import { createHash } from 'node:crypto';
import type { RetryPolicy } from '../domain/remediation';

/**
 * Exponential backoff with deterministic jitter (±20%, derived from the delivery and attempt)
 * so retries of many leads spread out, yet every run of a test or demo is reproducible.
 * A provider's Retry-After hint is a floor, never ignored.
 */
export function backoffDelay(policy: RetryPolicy, attemptNumber: number, seed: string, retryAfterMs?: number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attemptNumber - 1));
  const h = createHash('sha256').update(`${seed}:${attemptNumber}`).digest().readUInt32BE(0) / 0xffffffff;
  const jittered = Math.round(exp * (0.8 + 0.4 * h));
  return Math.max(jittered, retryAfterMs ?? 0);
}
