import type { Repositories } from '../db/repositories';
import type { FailureEvidence } from '../domain/failure';
import type { RemediationDecision, RetryPolicy } from '../domain/remediation';
import type { JobOutcome } from '../jobs/runner';
import type { Clock } from '../shared/clock';
import type { AttemptContext } from './delivery-pipeline';
import type { FailureHandler } from './failure-handler';
import type { IncidentService } from './incidents';
import { backoffDelay } from './retry-policy';

const RETRYABLE = new Set(['transient', 'ambiguous_write']);

/**
 * Baseline failure handling: bounded, durable retries for transient and ambiguous failures
 * (the next attempt always reads the CRM before writing), escalation for everything else.
 */
export class BoundedRetryFailureHandler implements FailureHandler {
  constructor(private repos: Repositories, private incidents: IncidentService, private clock: Clock, private policy: RetryPolicy) {}

  async handle(ctx: AttemptContext, failure: FailureEvidence): Promise<JobOutcome> {
    const now = this.clock.now();
    const limits = { attempt: ctx.attempt.attemptNumber, maxAttempts: this.policy.maxAttempts, deadlineAt: ctx.delivery.deadlineAt };
    const retryAt = now + backoffDelay(this.policy, ctx.attempt.attemptNumber, ctx.delivery.id, failure.retryAfterMs);
    const canRetry = RETRYABLE.has(failure.failureClass) && ctx.attempt.attemptNumber < this.policy.maxAttempts && retryAt <= ctx.delivery.deadlineAt;
    const decision: RemediationDecision = canRetry
      ? { action: 'retry_with_backoff', reason: `${failure.failureClass} failure; retry ${ctx.attempt.attemptNumber + 1}/${this.policy.maxAttempts}`, retryAt, limits }
      : { action: 'escalate', reason: RETRYABLE.has(failure.failureClass) ? 'retry limit or deadline reached' : `${failure.failureClass} failure is not retryable`, limits };

    this.repos.attempts.finish(ctx.attempt.id, 'failed', failure, decision);
    this.incidents.recordFailure(ctx, failure, decision);
    if (decision.action === 'retry_with_backoff') {
      this.repos.deliveries.transition(ctx.delivery.id, ['processing'], 'retry_scheduled', { lastFailureClass: failure.failureClass, lastFailureCode: failure.code, nextAttemptAt: retryAt });
      return { type: 'reschedule', runAfter: retryAt, reason: `${failure.code}: ${decision.reason}` };
    }
    this.repos.deliveries.transition(ctx.delivery.id, ['processing'], 'escalated', { lastFailureClass: failure.failureClass, lastFailureCode: failure.code });
    this.incidents.escalate(ctx, failure, decision.reason);
    return { type: 'complete' };
  }
}
