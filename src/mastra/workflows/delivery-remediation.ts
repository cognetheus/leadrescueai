import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { FAILURE_CLASSES, type FailureEvidence } from '../../domain/failure';
import type { NormalizedLead } from '../../domain/lead';
import { REMEDIATION_ACTIONS, type RemediationDecision } from '../../domain/remediation';
import type { JobOutcome } from '../../jobs/runner';
import type { AttemptContext } from '../../services/delivery-pipeline';
import type { ActionResult, RemediationService } from '../../services/remediation';
import { LocalRegistry } from '../../shared/local-registry';
import { redactString } from '../../shared/redact';

/** In-memory state for one remediation run (never persisted; see lead-delivery for why). */
export interface RemediationRuntime {
  ctx: AttemptContext;
  failure: FailureEvidence;
  lead?: NormalizedLead;
  service: RemediationService;
  decision?: RemediationDecision;
  result?: ActionResult;
  outcome?: JobOutcome;
}
export const REMEDIATION_KEY = 'leadrescue.remediationRef';
export const remediationRuntimes = new LocalRegistry<RemediationRuntime>();

const rt = (requestContext: RequestContext | undefined): RemediationRuntime => {
  const r = remediationRuntimes.get(requestContext?.get(REMEDIATION_KEY));
  if (!r) throw new Error('delivery-remediation runs only for a failed attempt (started by the delivery job handler)');
  return r;
};

const State = z.object({
  attemptId: z.string(),
  deliveryId: z.string(),
  tenantId: z.string(),
  correlationId: z.string(),
  evidence: z
    .object({ failureClass: z.enum(FAILURE_CLASSES), code: z.string(), stage: z.string(), httpStatus: z.number().nullable(), message: z.string(), requestSent: z.boolean().nullable() })
    .optional(),
  retryable: z.boolean().optional(),
  decision: z.object({ action: z.enum(REMEDIATION_ACTIONS), reason: z.string(), retryAt: z.string().nullable(), attempt: z.number(), maxAttempts: z.number(), deadlineAt: z.string() }).optional(),
  actionResult: z.object({ kind: z.enum(['retry', 'recovered', 'escalate']), detail: z.string() }).optional(),
  verification: z.object({ ok: z.boolean(), checks: z.array(z.string()) }).optional(),
  outcome: z.object({ deliveryStatus: z.string(), job: z.enum(['complete', 'reschedule', 'dead']) }).optional(),
});
type S = z.infer<typeof State>;

const step = (id: string, description: string, fn: (s: S, r: RemediationRuntime) => Promise<S>) =>
  createStep({ id, description, inputSchema: State, outputSchema: State, execute: async ({ inputData, requestContext }) => fn(inputData, rt(requestContext)) });

const captureEvidence = step('capture-evidence', 'Capture sanitized failure evidence from the failed attempt', async (s, r) => ({
  ...s,
  evidence: {
    failureClass: r.failure.failureClass, code: r.failure.code, stage: r.failure.stage, httpStatus: r.failure.httpStatus ?? null,
    message: redactString(r.failure.message).slice(0, 300), requestSent: r.failure.requestSent ?? null,
  },
}));

const classify = step('classify-failure', 'Confirm the deterministic failure class', async (s) => ({
  ...s,
  retryable: ['transient', 'ambiguous_write', 'authentication', 'verification', 'validation'].includes(s.evidence!.failureClass),
}));

const select = step('select-remediation', 'Choose one allowlisted action within retry limits and deadline', async (s, r) => {
  r.decision = r.service.decide(r.ctx, r.failure);
  const d = r.decision;
  return {
    ...s,
    decision: {
      action: d.action, reason: d.reason, retryAt: d.retryAt ? new Date(d.retryAt).toISOString() : null,
      attempt: d.limits.attempt, maxAttempts: d.limits.maxAttempts, deadlineAt: new Date(d.limits.deadlineAt).toISOString(),
    },
  };
});

const execute = step('execute-action', 'Perform the recovery action (refresh, re-fetch, read-before-retry, schedule, escalate)', async (s, r) => {
  r.result = await r.service.execute(r.ctx, r.decision!, r.failure, r.lead);
  return { ...s, actionResult: { kind: r.result.kind, detail: r.result.kind === 'escalate' ? r.result.reason : r.result.detail } };
});

const verifyOutcome = step('verify-outcome', 'Check the action result respects policy invariants before committing it', async (s, r) => {
  const checks: string[] = [];
  const res = r.result!;
  const d = r.decision!;
  if (res.kind === 'recovered') checks.push('contact read back and verified against the lead before commit');
  if (res.kind === 'retry') {
    if (res.retryAt > d.limits.deadlineAt) throw new Error('retry scheduled past the delivery deadline');
    if (d.limits.attempt >= d.limits.maxAttempts) throw new Error('retry scheduled beyond the attempt limit');
    checks.push('next attempt within deadline', 'attempt limit not exceeded');
  }
  if (res.kind === 'escalate') checks.push('escalation reason recorded');
  return { ...s, verification: { ok: true, checks } };
});

const record = step('record-outcome', 'Persist attempt, delivery, incident timeline and audit trail', async (s, r) => {
  r.outcome = await r.service.apply(r.ctx, r.failure, r.decision!, r.result!);
  const status = r.result!.kind === 'recovered' ? 'delivered' : r.result!.kind === 'retry' ? 'retry_scheduled' : 'escalated';
  return { ...s, outcome: { deliveryStatus: status, job: r.outcome.type } };
});

export const deliveryRemediationWorkflow = createWorkflow({
  id: 'delivery-remediation',
  description: 'Workflow B: classify a failed delivery attempt, apply an allowlisted recovery, verify and record it',
  inputSchema: State,
  outputSchema: State,
})
  .then(captureEvidence)
  .then(classify)
  .then(select)
  .then(execute)
  .then(verifyOutcome)
  .then(record)
  .commit();
