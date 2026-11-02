import type { AppDatabase } from '../db/connection';
import type { Repositories } from '../db/repositories';
import type { Delivery, DeliveryAttempt } from '../db/repositories/deliveries';
import type { Tenant } from '../db/repositories/tenants';
import { PipelineError, type FailureEvidence, type PipelineStage } from '../domain/failure';
import type { RemediationDecision } from '../domain/remediation';
import { validateAndNormalizeLead, type NormalizedLead } from '../domain/lead';
import type { CrmClient, CrmContact, NewCrmContact } from '../integrations/crm';
import type { MetaSourceClient } from '../integrations/meta-source';
import type { Clock } from '../shared/clock';
import type { AppLogger } from '../shared/logger';
import type { CredentialService } from './credentials';
import { toPipelineError } from './failure-classifier';

export interface LeaseFence {
  jobId: string;
  leaseToken: string;
  workerId: string;
  stillHeld(): boolean;
}

export interface AttemptContext {
  delivery: Delivery;
  tenant: Tenant;
  attempt: DeliveryAttempt;
  /** The job lease this attempt runs under; checked before every externally visible write. */
  fence: LeaseFence;
}

export type BeginResult =
  | { kind: 'run'; ctx: AttemptContext; interruptedAttempts: DeliveryAttempt[] }
  | { kind: 'skip'; reason: string; delivery: Delivery }
  /** Another live lease is already working on this delivery (single-flight per delivery). */
  | { kind: 'busy'; reason: string; delivery: Delivery };

export type ContactOrigin = 'existing' | 'created' | 'prior_attempt';

export interface PipelineDeps {
  db: AppDatabase;
  repos: Repositories;
  clock: Clock;
  logger: AppLogger;
  source: MetaSourceClient;
  crm: CrmClient;
  credentials: CredentialService;
  /** Lease ownership check for attempts started by other jobs (delivery-level fencing). */
  leaseHeld: (jobId: string, leaseToken: string) => boolean;
}

/** Fields that must round-trip unchanged through the CRM for a delivery to count. */
export const VERIFIED_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'postalCode'] as const;

/**
 * The lead-delivery business process, independent of Mastra. Each public method is one
 * pipeline stage; failures are raised as classified `PipelineError`s with evidence.
 */
export class DeliveryPipeline {
  constructor(private deps: PipelineDeps) {}

  /** Wraps a stage: records progress and converts any failure into classified evidence. */
  async stage<T>(attemptId: string, stage: PipelineStage, fn: () => Promise<T> | T): Promise<T> {
    this.deps.repos.attempts.setStage(attemptId, stage);
    try {
      return await fn();
    } catch (err) {
      throw toPipelineError(err, stage);
    }
  }

  /**
   * Starts an attempt under a job lease. Reclaimed work (previous worker died) marks the
   * orphaned attempt as abandoned so the history shows the interruption explicitly.
   */
  begin(deliveryId: string, fence: LeaseFence): BeginResult {
    const { repos, db } = this.deps;
    return db.transaction((): BeginResult => {
      const delivery = repos.deliveries.get(deliveryId);
      if (!delivery) throw new PipelineError({ failureClass: 'permanent', code: 'delivery_not_found', stage: 'load', message: `Delivery ${deliveryId} does not exist` });
      if (delivery.status === 'delivered' || delivery.status === 'escalated') {
        return { kind: 'skip', reason: `delivery already ${delivery.status}`, delivery };
      }
      const running = repos.attempts.running(delivery.id);
      const live = running.find((a) => a.jobId && a.leaseToken && a.leaseToken !== fence.leaseToken && this.deps.leaseHeld(a.jobId, a.leaseToken));
      if (live) return { kind: 'busy', reason: `attempt ${live.id} is in progress on ${live.workerId}`, delivery };
      const interruptedAttempts = running;
      for (const a of interruptedAttempts) {
        repos.attempts.finish(a.id, 'abandoned', {
          failureClass: 'transient', code: 'worker_interrupted', stage: a.stageReached ?? 'load',
          message: `Worker ${a.workerId ?? 'unknown'} stopped before finishing (lease expired)`, occurredAt: new Date(this.deps.clock.now()).toISOString(),
        });
      }
      const tenant = repos.tenants.get(delivery.tenantId)!;
      const attempt = repos.attempts.start({ deliveryId: delivery.id, tenantId: delivery.tenantId, jobId: fence.jobId, leaseToken: fence.leaseToken, workerId: fence.workerId });
      const updated = repos.deliveries.transition(delivery.id, ['pending', 'retry_scheduled', 'processing'], 'processing', { attemptCount: attempt.attemptNumber });
      repos.audit.record({
        tenantId: tenant.id, actor: `worker:${fence.workerId}`, action: 'delivery.attempt_started', entityType: 'delivery', entityId: delivery.id,
        correlationId: delivery.correlationId, data: { attemptId: attempt.id, attemptNumber: attempt.attemptNumber, interrupted: interruptedAttempts.map((a) => a.id) },
      });
      return { kind: 'run', ctx: { delivery: updated, tenant, attempt, fence }, interruptedAttempts };
    }).immediate();
  }

  async fetchSourceLead(ctx: AttemptContext): Promise<unknown> {
    return this.stage(ctx.attempt.id, 'fetch_source', () =>
      this.deps.source.getLead(this.deps.credentials.metaPageToken(ctx.tenant.id), ctx.delivery.sourceLeadId),
    );
  }

  /** Validates the canonical lead and guards identity (right lead, right tenant). */
  async validateLead(ctx: AttemptContext, raw: unknown): Promise<{ lead: NormalizedLead; warnings: string[] }> {
    return this.stage(ctx.attempt.id, 'validate', () => {
      const result = validateAndNormalizeLead(raw);
      if (!result.ok) {
        throw new PipelineError({
          failureClass: 'validation', code: 'source_lead_invalid', stage: 'validate',
          message: `Lead failed validation: ${result.issues.map((i) => i.message).join('; ')}`,
          details: { issues: result.issues, warnings: result.warnings },
        });
      }
      if (result.lead.sourceLeadId !== ctx.delivery.sourceLeadId || result.lead.pageId !== ctx.tenant.metaPageId) {
        throw new PipelineError({ failureClass: 'permanent', code: 'source_identity_mismatch', stage: 'validate', message: 'Source returned a lead for a different id or page' });
      }
      return { lead: result.lead, warnings: result.warnings.map((w) => w.message) };
    });
  }

  /** Tenant-scoped idempotency: a contact already linked to this delivery is reused, never recreated. */
  async idempotencyCheck(ctx: AttemptContext): Promise<string | null> {
    return this.stage(ctx.attempt.id, 'idempotency', () => {
      const current = this.deps.repos.deliveries.get(ctx.delivery.id)!;
      return current.crmContactId;
    });
  }

  /** Read-before-write: looks up the contact by the stable external source id. */
  async findContact(ctx: AttemptContext, lead: NormalizedLead): Promise<CrmContact | null> {
    return this.stage(ctx.attempt.id, 'find_contact', async () => {
      const token = this.deps.credentials.crmAccessToken(ctx.tenant.id);
      const matches = await this.deps.crm.findByExternalId(token, ctx.tenant.crmLocationId, lead.sourceLeadId);
      if (matches.length > 1) {
        throw new PipelineError({
          failureClass: 'permanent', code: 'crm_duplicate_contacts_detected', stage: 'find_contact',
          message: `${matches.length} CRM contacts share external id ${lead.sourceLeadId}; refusing to pick one automatically`,
          details: { contactIds: matches.map((m) => m.id) },
        });
      }
      return matches[0] ?? null;
    });
  }

  async createContact(ctx: AttemptContext, lead: NormalizedLead): Promise<CrmContact> {
    return this.stage(ctx.attempt.id, 'create_contact', async () => {
      this.assertLease(ctx, 'create_contact');
      const token = this.deps.credentials.crmAccessToken(ctx.tenant.id);
      // Write intent is recorded before the call so an ambiguous outcome is traceable.
      this.deps.repos.audit.record({
        tenantId: ctx.tenant.id, actor: `worker:${ctx.attempt.workerId}`, action: 'crm.create_requested', entityType: 'delivery',
        entityId: ctx.delivery.id, correlationId: ctx.delivery.correlationId, data: { attemptId: ctx.attempt.id, externalSourceId: lead.sourceLeadId },
      });
      const contact = await this.deps.crm.createContact(token, toCrmContact(ctx.tenant, lead));
      this.deps.repos.deliveries.recordContact(ctx.delivery.id, contact.id);
      return contact;
    });
  }

  async readBack(ctx: AttemptContext, contactId: string): Promise<CrmContact> {
    return this.stage(ctx.attempt.id, 'read_back', () => this.deps.crm.getContact(this.deps.credentials.crmAccessToken(ctx.tenant.id), contactId));
  }

  /** Delivery only counts if the CRM holds exactly what was sent, for the right tenant and lead. */
  async verify(ctx: AttemptContext, lead: NormalizedLead, contact: CrmContact): Promise<{ checkedFields: string[] }> {
    return this.stage(ctx.attempt.id, 'verify', () => {
      const mismatches = verifyContact(ctx.tenant, lead, contact);
      if (mismatches.length) {
        throw new PipelineError({
          failureClass: 'verification', code: 'crm_verification_mismatch', stage: 'verify',
          message: `CRM record ${contact.id} does not match the lead: ${mismatches.map((m) => m.field).join(', ')}`,
          details: { contactId: contact.id, mismatchedFields: mismatches.map((m) => m.field) },
        });
      }
      return { checkedFields: ['externalSourceId', 'locationId', ...VERIFIED_FIELDS] };
    });
  }

  /** Marks the delivery delivered. Fenced: a worker that lost its lease cannot commit. */
  async commit(ctx: AttemptContext, contactId: string, origin: ContactOrigin, recovered?: { failure: FailureEvidence; remediation: RemediationDecision }): Promise<Delivery> {
    return this.stage(ctx.attempt.id, 'commit', () => {
      const { repos, db } = this.deps;
      return db.transaction(() => {
        this.assertLease(ctx, 'commit');
        repos.deliveries.recordContact(ctx.delivery.id, contactId);
        const delivered = repos.deliveries.transition(ctx.delivery.id, ['processing'], 'delivered', {
          crmContactId: contactId, lastFailureClass: null, lastFailureCode: null,
        });
        repos.attempts.finish(ctx.attempt.id, 'succeeded', recovered?.failure ?? null, recovered?.remediation ?? null);
        repos.audit.record({
          tenantId: ctx.tenant.id, actor: `worker:${ctx.attempt.workerId}`, action: 'delivery.delivered', entityType: 'delivery',
          entityId: ctx.delivery.id, correlationId: ctx.delivery.correlationId,
          data: { attemptId: ctx.attempt.id, attemptNumber: ctx.attempt.attemptNumber, crmContactId: contactId, contactOrigin: origin, recoveredBy: recovered?.remediation.action ?? null },
        });
        return delivered;
      }).immediate();
    });
  }

  private assertLease(ctx: AttemptContext, stage: PipelineStage) {
    if (!ctx.fence.stillHeld()) {
      throw new PipelineError({ failureClass: 'transient', code: 'lease_lost', stage, message: `Job lease lost before ${stage}; another worker owns this delivery` });
    }
  }
}

export function toCrmContact(tenant: Tenant, lead: NormalizedLead): NewCrmContact {
  const customFields: Record<string, string> = { lead_form_id: lead.formId, lead_created_at: lead.createdAt };
  if (lead.serviceType) customFields.service_type = lead.serviceType;
  for (const [k, v] of Object.entries(lead.answers)) customFields[`answer_${k}`] = v;
  return {
    locationId: tenant.crmLocationId,
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email,
    phone: lead.phone,
    postalCode: lead.postalCode,
    source: 'Meta Lead Ads',
    externalSourceId: lead.sourceLeadId,
    tags: ['meta-lead', 'leadrescue'],
    customFields,
  };
}

export function verifyContact(tenant: Tenant, lead: NormalizedLead, contact: CrmContact): Array<{ field: string }> {
  const out: Array<{ field: string }> = [];
  if (contact.externalSourceId !== lead.sourceLeadId) out.push({ field: 'externalSourceId' });
  if (contact.locationId !== tenant.crmLocationId) out.push({ field: 'locationId' });
  for (const f of VERIFIED_FIELDS) {
    if ((contact[f] ?? null) !== (lead[f] ?? null)) out.push({ field: f });
  }
  return out;
}
