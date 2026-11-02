import type { FailureEvidence } from '../domain/failure';
import type { NormalizedLead } from '../domain/lead';
import type { JobOutcome } from '../jobs/runner';
import type { AttemptContext } from './delivery-pipeline';

/**
 * Decides and applies what happens after a failed attempt. The job handler depends only on
 * this interface; the implementation is the remediation workflow (see services/remediation).
 */
export interface FailureHandler {
  /** `lead` is the validated lead from the failed attempt, when validation got that far. */
  handle(ctx: AttemptContext, failure: FailureEvidence, lead?: NormalizedLead): Promise<JobOutcome>;
}
