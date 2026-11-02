import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { resolveContainer } from '../../container';
import { isPipelineError, PipelineError, type FailureEvidence } from '../../domain/failure';
import type { NormalizedLead } from '../../domain/lead';
import type { CrmContact } from '../../integrations/crm';
import type { AttemptContext, ContactOrigin, DeliveryPipeline } from '../../services/delivery-pipeline';
import { LocalRegistry } from '../../shared/local-registry';
import { maskEmail, maskPhone } from '../../shared/redact';

/**
 * Per-attempt runtime handed to the workflow through the request context. It holds the
 * lease-fenced attempt and the unmasked lead, which deliberately never enters workflow
 * state, snapshots or trace spans (those only carry identifiers and masked summaries).
 */
export interface AttemptRuntime {
  ctx: AttemptContext;
  pipeline: DeliveryPipeline;
  rawLead?: unknown;
  lead?: NormalizedLead;
  contact?: CrmContact;
  failure?: FailureEvidence;
}
export const ATTEMPT_KEY = 'leadrescue.attemptRef';

/** In-memory attempt runtimes, referenced from the request context by attempt id only. */
export const attemptRuntimes = new LocalRegistry<AttemptRuntime>();

function runtimeOf(requestContext: RequestContext | undefined): AttemptRuntime {
  const rt = attemptRuntimes.get(requestContext?.get(ATTEMPT_KEY));
  if (!rt) {
    throw new PipelineError({
      failureClass: 'permanent', code: 'missing_job_lease', stage: 'load',
      message: 'lead-delivery runs only under a job lease; trigger it with a webhook, reconciliation or POST /ops/deliveries/:id/replay',
    });
  }
  return rt;
}

/** Runs a stage and records its classified failure for the remediation workflow before rethrowing. */
async function guarded<T>(requestContext: RequestContext | undefined, fn: (rt: AttemptRuntime) => Promise<T>): Promise<T> {
  const rt = runtimeOf(requestContext);
  try {
    return await fn(rt);
  } catch (err) {
    if (isPipelineError(err)) rt.failure = { ...err.evidence, occurredAt: new Date(resolveContainer(requestContext).clock.now()).toISOString() };
    throw err;
  }
}

const LeadSummary = z.object({
  firstName: z.string(),
  hasLastName: z.boolean(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  serviceType: z.string().nullable(),
});

export const DeliveryState = z.object({
  attemptId: z.string(),
  attemptNumber: z.number(),
  deliveryId: z.string(),
  tenantId: z.string(),
  sourceLeadId: z.string(),
  correlationId: z.string(),
  sourceFieldCount: z.number().optional(),
  lead: LeadSummary.optional(),
  validationWarnings: z.array(z.string()).optional(),
  priorContactId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  contactOrigin: z.enum(['existing', 'created', 'prior_attempt']).optional(),
  verifiedFields: z.array(z.string()).optional(),
  status: z.enum(['in_progress', 'delivered']).default('in_progress'),
});
type State = z.infer<typeof DeliveryState>;

const step = (id: string, description: string, execute: (state: State, rt: AttemptRuntime) => Promise<State>) =>
  createStep({
    id,
    description,
    inputSchema: DeliveryState,
    outputSchema: DeliveryState,
    execute: async ({ inputData, requestContext }) => guarded(requestContext, (rt) => execute(inputData, rt)),
  });

const fetchSourceLead = step('fetch-source-lead', 'Fetch the canonical lead from the advertising source API', async (s, rt) => {
  rt.rawLead = await rt.pipeline.fetchSourceLead(rt.ctx);
  const fields = (rt.rawLead as { field_data?: unknown[] })?.field_data;
  return { ...s, sourceFieldCount: Array.isArray(fields) ? fields.length : 0 };
});

const validateLead = step('validate-and-normalize', 'Validate required fields and normalize name, email and phone', async (s, rt) => {
  const { lead, warnings } = await rt.pipeline.validateLead(rt.ctx, rt.rawLead);
  rt.lead = lead;
  return {
    ...s,
    validationWarnings: warnings,
    lead: {
      firstName: lead.firstName,
      hasLastName: Boolean(lead.lastName),
      email: lead.email ? maskEmail(lead.email) : null,
      phone: lead.phone ? maskPhone(lead.phone) : null,
      serviceType: lead.serviceType,
    },
  };
});

const checkIdempotency = step('check-idempotency', 'Tenant-scoped idempotency: reuse a contact already linked to this delivery', async (s, rt) => ({
  ...s,
  priorContactId: await rt.pipeline.idempotencyCheck(rt.ctx),
}));

const findContact = step('find-crm-contact', 'Read-before-write: find an existing CRM contact by external source id', async (s, rt) => {
  if (s.priorContactId) return { ...s, contactId: s.priorContactId, contactOrigin: 'prior_attempt' as ContactOrigin };
  const existing = await rt.pipeline.findContact(rt.ctx, rt.lead!);
  return existing ? { ...s, contactId: existing.id, contactOrigin: 'existing' as ContactOrigin } : { ...s, contactId: null };
});

const useExistingContact = step('use-existing-contact', 'Contact already exists: skip creation (no duplicate)', async (s) => s);

const createContact = step('create-crm-contact', 'Create the CRM contact', async (s, rt) => {
  const contact = await rt.pipeline.createContact(rt.ctx, rt.lead!);
  return { ...s, contactId: contact.id, contactOrigin: 'created' as ContactOrigin };
});

const mergeBranch = createStep({
  id: 'resolve-contact',
  description: 'Join the existing/created branches',
  inputSchema: z.object({ 'use-existing-contact': DeliveryState.optional(), 'create-crm-contact': DeliveryState.optional() }),
  outputSchema: DeliveryState,
  execute: async ({ inputData }) => {
    const s = inputData['create-crm-contact'] ?? inputData['use-existing-contact'];
    if (!s?.contactId) throw new Error('no contact resolved');
    return s;
  },
});

const readBack = step('read-back-contact', 'Read the CRM record back', async (s, rt) => {
  rt.contact = await rt.pipeline.readBack(rt.ctx, s.contactId!);
  return s;
});

const verify = step('verify-contact', 'Verify identity and required fields against the lead', async (s, rt) => {
  const { checkedFields } = await rt.pipeline.verify(rt.ctx, rt.lead!, rt.contact!);
  return { ...s, verifiedFields: checkedFields };
});

const commit = step('commit-delivery', 'Commit delivered state (lease-fenced) and audit', async (s, rt) => {
  await rt.pipeline.commit(rt.ctx, s.contactId!, s.contactOrigin!);
  return { ...s, status: 'delivered' as const };
});

export const leadDeliveryWorkflow = createWorkflow({
  id: 'lead-delivery',
  description: 'Workflow A: deliver one lead from the ad source into the CRM, verified, exactly once',
  inputSchema: DeliveryState,
  outputSchema: DeliveryState,
})
  .then(fetchSourceLead)
  .then(validateLead)
  .then(checkIdempotency)
  .then(findContact)
  .branch([
    [async ({ inputData }) => Boolean(inputData.contactId), useExistingContact],
    [async ({ inputData }) => !inputData.contactId, createContact],
  ])
  .then(mergeBranch)
  .then(readBack)
  .then(verify)
  .then(commit)
  .commit();
