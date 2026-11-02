import type { Repositories } from '../db/repositories';
import type { FailureEvidence } from '../domain/failure';
import { isPipelineError } from '../domain/failure';
import type { NormalizedLead } from '../domain/lead';
import type { RemediationAction, RemediationDecision, RetryPolicy } from '../domain/remediation';
import { selectRemediation } from '../domain/remediation-policy';
import type { JobOutcome } from '../jobs/runner';
import type { Clock } from '../shared/clock';
import type { AppLogger } from '../shared/logger';
import type { AttemptContext, DeliveryPipeline } from './delivery-pipeline';
import type { FailureHandler } from './failure-handler';
import type { IncidentService } from './incidents';
import { backoffDelay } from './retry-policy';
import type { TokenRefresher } from './token-refresher';

/** What an executed recovery action achieved. */
export type ActionResult =
  | { kind: 'retry'; retryAt: number; detail: string }
  | { kind: 'recovered'; contactId: string; detail: string }
  | { kind: 'escalate'; reason: string; evidence?: FailureEvidence };

export interface RemediationOutcome {
  decision: RemediationDecision;
  result: ActionResult;
  outcome: JobOutcome;
}

/**
 * Workflow B: self-healing delivery. Selects an allowlisted action with the deterministic
 * policy, executes it, verifies what it can, and records every step on the attempt,
 * the delivery, the incident timeline and the audit log.
 */
export class RemediationService implements FailureHandler {
  constructor(
    private deps: {
      repos: Repositories;
      incidents: IncidentService;
      pipeline: DeliveryPipeline;
      refresher: TokenRefresher;
      clock: Clock;
      logger: AppLogger;
      policy: RetryPolicy;
    },
  ) {}

  previousActions(ctx: AttemptContext): RemediationAction[] {
    return this.deps.repos.attempts
      .forDelivery(ctx.delivery.id)
      .filter((a) => a.id !== ctx.attempt.id && a.remediation)
      .map((a) => a.remediation!.action);
  }

  decide(ctx: AttemptContext, failure: FailureEvidence): RemediationDecision {
    const backoff = backoffDelay(this.deps.policy, ctx.attempt.attemptNumber, ctx.delivery.id, failure.retryAfterMs);
    return selectRemediation(
      {
        failureClass: failure.failureClass, code: failure.code, attemptNumber: ctx.attempt.attemptNumber,
        firstReceivedAt: ctx.delivery.receivedAt, now: this.deps.clock.now(), previousActions: this.previousActions(ctx),
        ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      },
      { ...this.deps.policy, deadlineMs: ctx.delivery.deadlineAt - ctx.delivery.receivedAt },
      backoff,
    );
  }

  /** Performs the selected action. Never throws: unexpected errors become escalation evidence. */
  async execute(ctx: AttemptContext, decision: RemediationDecision, failure: FailureEvidence, lead?: NormalizedLead): Promise<ActionResult> {
    const { pipeline, refresher, clock } = this.deps;
    const now = clock.now();
    const later = (detail: string, at = decision.retryAt ?? now): ActionResult => ({ kind: 'retry', retryAt: at, detail });
    const transientBackoff = () => now + backoffDelay(this.deps.policy, ctx.attempt.attemptNumber, ctx.delivery.id);
    try {
      switch (decision.action) {
        case 'retry_with_backoff':
          return later(`retry scheduled for ${new Date(decision.retryAt!).toISOString()}`);

        case 'refresh_token_and_retry': {
          const r = await refresher.refresh(ctx.tenant.id, { owner: `worker:${ctx.attempt.workerId}`, staleSince: ctx.attempt.startedAt });
          if (r.outcome === 'refreshed') return later(`access token refreshed (credential v${r.version}); retrying now`);
          if (r.outcome === 'already_refreshed') return later(`token already refreshed by another worker (v${r.version}); retrying now`);
          if (r.outcome === 'unavailable') return later(`token refresh unavailable (${r.reason}); retrying with backoff`, transientBackoff());
          return {
            kind: 'escalate', reason: `CRM refresh grant revoked (${r.reason}); an operator must re-authorize the CRM connection`,
            evidence: { ...failure, failureClass: 'permanent', code: 'crm_refresh_grant_revoked', stage: 'credentials', message: r.reason, occurredAt: new Date(now).toISOString() },
          };
        }

        case 'refetch_source_and_retry': {
          const raw = await pipeline.fetchSourceLead(ctx);
          await pipeline.validateLead(ctx, raw); // throws if still invalid
          return later('canonical lead re-fetched and now passes validation; retrying now');
        }

        case 'crm_read_before_retry': {
          const effectiveLead = lead ?? (await pipeline.validateLead(ctx, await pipeline.fetchSourceLead(ctx))).lead;
          const existing = await pipeline.findContact(ctx, effectiveLead);
          if (!existing) return later('CRM has no contact for this lead; the write did not commit, safe to retry');
          const contact = await pipeline.readBack(ctx, existing.id);
          await pipeline.verify(ctx, effectiveLead, contact);
          return { kind: 'recovered', contactId: existing.id, detail: `write had committed: adopted and verified contact ${existing.id} (no duplicate created)` };
        }

        case 'reverify_crm_record':
          return later('re-verification of the CRM record scheduled');

        case 'reconciliation_backfill':
          return later('backfill delivery scheduled');

        case 'escalate':
          return { kind: 'escalate', reason: decision.reason };
      }
    } catch (err) {
      // The recovery action itself failed: record why, and keep the failure bounded.
      const evidence = isPipelineError(err) ? { ...err.evidence, occurredAt: new Date(now).toISOString() } : undefined;
      if (evidence && (evidence.failureClass === 'transient') && ctx.attempt.attemptNumber < this.deps.policy.maxAttempts) {
        return later(`recovery action hit a transient error (${evidence.code}); retrying with backoff`, transientBackoff());
      }
      const reason = decision.action === 'refetch_source_and_retry'
        ? 'canonical lead is still invalid after re-fetch; missing data will not be fabricated'
        : `recovery action ${decision.action} failed: ${(err as Error).message}`;
      return { kind: 'escalate', reason, ...(evidence ? { evidence } : {}) };
    }
  }

  /** Applies the action result durably and returns what the job runner should do. */
  async apply(ctx: AttemptContext, failure: FailureEvidence, decision: RemediationDecision, result: ActionResult): Promise<JobOutcome> {
    const { repos, incidents, pipeline } = this.deps;
    const incident = incidents.recordFailure(ctx, failure, decision);
    const executed = result.kind === 'escalate' ? `escalation: ${result.reason}` : result.detail;
    incidents.event(incident, 'remediation_executed', `${decision.action}: ${executed}`, ctx.attempt.id, { action: decision.action, result: result.kind });
    repos.audit.record({
      tenantId: ctx.tenant.id, actor: `worker:${ctx.attempt.workerId}`, action: `remediation.${decision.action}`, entityType: 'delivery', entityId: ctx.delivery.id,
      correlationId: ctx.delivery.correlationId, data: { attemptId: ctx.attempt.id, failureCode: failure.code, result: result.kind, detail: executed },
    });

    if (result.kind === 'recovered') {
      // The attempt succeeds *with* its failure evidence and remediation recorded on it.
      await pipeline.commit(ctx, result.contactId, 'existing', { failure, remediation: decision });
      incidents.recordRecoveryIfOpen(ctx, result.contactId, ctx.attempt.workflowRunId ?? ctx.attempt.id);
      return { type: 'complete' };
    }

    if (result.kind === 'retry') {
      repos.attempts.finish(ctx.attempt.id, 'failed', failure, decision);
      repos.deliveries.transition(ctx.delivery.id, ['processing'], 'retry_scheduled', { lastFailureClass: failure.failureClass, lastFailureCode: failure.code, nextAttemptAt: result.retryAt });
      incidents.event(incident, 'retry_scheduled', `Attempt ${ctx.attempt.attemptNumber + 1} scheduled for ${new Date(result.retryAt).toISOString()}`, ctx.attempt.id, { retryAt: result.retryAt });
      return { type: 'reschedule', runAfter: result.retryAt, reason: `${failure.code} → ${decision.action}` };
    }

    const finalEvidence = result.evidence ?? failure;
    const finalDecision: RemediationDecision = decision.action === 'escalate' ? decision : { ...decision, reason: `${decision.reason}; then escalated: ${result.reason}` };
    repos.attempts.finish(ctx.attempt.id, 'failed', finalEvidence, finalDecision);
    repos.deliveries.transition(ctx.delivery.id, ['processing'], 'escalated', { lastFailureClass: finalEvidence.failureClass, lastFailureCode: finalEvidence.code });
    incidents.escalate(ctx, finalEvidence, result.reason);
    return { type: 'complete' };
  }

  async handle(ctx: AttemptContext, failure: FailureEvidence, lead?: NormalizedLead): Promise<JobOutcome> {
    const decision = this.decide(ctx, failure);
    const result = await this.execute(ctx, decision, failure, lead);
    this.deps.logger.info('Remediation applied', { deliveryId: ctx.delivery.id, attemptId: ctx.attempt.id, action: decision.action, result: result.kind });
    return this.apply(ctx, failure, decision, result);
  }
}
