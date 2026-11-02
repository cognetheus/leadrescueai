import type { RemediationContext, RemediationDecision, RetryPolicy } from './remediation';

/** Codes whose validation failures came from the source data (re-fetchable), not from the CRM contract. */
const SOURCE_VALIDATION_CODES = new Set(['source_lead_invalid']);
const MAX_REVERIFICATIONS = 2;

/**
 * Deterministic remediation policy. Given a classified failure and the attempt history,
 * returns exactly one allowlisted action. This function — not the LLM — decides what
 * the system does; it is pure so every branch is unit-testable.
 *
 * Global bounds: no action that schedules more work is chosen once the attempt limit
 * or the delivery deadline would be exceeded; the result is then `escalate`.
 */
export function selectRemediation(ctx: RemediationContext, policy: RetryPolicy, backoffMs: number): RemediationDecision {
  const limits = { attempt: ctx.attemptNumber, maxAttempts: policy.maxAttempts, deadlineAt: ctx.firstReceivedAt + policy.deadlineMs };
  const escalate = (reason: string): RemediationDecision => ({ action: 'escalate', reason, limits });
  const count = (a: string) => ctx.previousActions.filter((p) => p === a).length;
  const retryAt = ctx.now + backoffMs;
  const exhausted = ctx.attemptNumber >= policy.maxAttempts;
  const pastDeadline = (at: number) => at > limits.deadlineAt;

  switch (ctx.failureClass) {
    case 'permanent':
      return escalate(`permanent failure (${ctx.code}) cannot be fixed automatically`);

    case 'authentication':
      // One refresh per failure streak: if a freshly refreshed token is also rejected, retrying cannot help.
      if (count('refresh_token_and_retry') >= 1 && ctx.previousActions.at(-1) === 'refresh_token_and_retry') {
        return escalate('CRM rejected a freshly refreshed access token');
      }
      if (exhausted || pastDeadline(ctx.now)) return escalate('retry limit or deadline reached');
      return { action: 'refresh_token_and_retry', reason: 'CRM access token rejected; refresh (rotating) and retry immediately', retryAt: ctx.now, limits };

    case 'validation':
      if (!SOURCE_VALIDATION_CODES.has(ctx.code)) return escalate(`CRM rejected the contact (${ctx.code}); lead data needs correction`);
      if (count('refetch_source_and_retry') >= 1) return escalate('canonical lead is still missing required fields after a re-fetch; refusing to fabricate data');
      if (exhausted || pastDeadline(ctx.now)) return escalate('retry limit or deadline reached');
      return { action: 'refetch_source_and_retry', reason: 'lead failed validation; re-fetch the canonical record once in case the first read was stale', retryAt: ctx.now, limits };

    case 'ambiguous_write':
      if (exhausted || pastDeadline(retryAt)) return escalate('write outcome unknown and retry limit or deadline reached');
      return { action: 'crm_read_before_retry', reason: 'contact creation outcome unknown; read the CRM before any further write', retryAt, limits };

    case 'verification':
      if (count('reverify_crm_record') >= MAX_REVERIFICATIONS) return escalate(`CRM record still mismatched after ${MAX_REVERIFICATIONS} re-verifications`);
      if (exhausted || pastDeadline(retryAt)) return escalate('retry limit or deadline reached during verification');
      return { action: 'reverify_crm_record', reason: 'CRM read-back did not match; re-read after a delay (possible replication lag)', retryAt, limits };

    case 'transient':
      if (exhausted) return escalate(`transient failure persisted for ${policy.maxAttempts} attempts`);
      if (pastDeadline(retryAt)) return escalate('next retry would exceed the delivery deadline');
      return {
        action: 'retry_with_backoff',
        reason: `transient ${ctx.code}; retry ${ctx.attemptNumber + 1}/${policy.maxAttempts}${ctx.retryAfterMs ? ` honoring Retry-After ${Math.round(ctx.retryAfterMs / 1000)}s` : ''}`,
        retryAt,
        limits,
      };
  }
}
