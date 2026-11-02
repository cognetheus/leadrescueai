import type { FailureClass } from './failure';

/** Allowlist of automatic recovery actions. Anything else is impossible by construction. */
export const REMEDIATION_ACTIONS = [
  'retry_with_backoff',
  'refresh_token_and_retry',
  'refetch_source_and_retry',
  'crm_read_before_retry',
  'reverify_crm_record',
  'reconciliation_backfill',
  'escalate',
] as const;
export type RemediationAction = (typeof REMEDIATION_ACTIONS)[number];

export interface RemediationDecision {
  action: RemediationAction;
  reason: string;
  /** When the next attempt may run (for actions that schedule a retry). */
  retryAt?: number;
  /** Policy limits that applied to this decision, recorded for audit. */
  limits: { attempt: number; maxAttempts: number; deadlineAt: number };
}

/** Attempt-history facts the policy needs; supplied by the application layer. */
export interface RemediationContext {
  failureClass: FailureClass;
  code: string;
  attemptNumber: number; // 1-based number of the attempt that just failed
  firstReceivedAt: number;
  now: number;
  retryAfterMs?: number;
  /** Actions already performed for this delivery, oldest first. */
  previousActions: RemediationAction[];
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  deadlineMs: number;
}
