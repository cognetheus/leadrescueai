import type { FailureEvidence } from '../domain/failure';
import type { JobOutcome } from '../jobs/runner';
import type { AttemptContext } from './delivery-pipeline';

/**
 * Decides and applies what happens after a failed attempt. The job handler depends only on
 * this interface; the implementation is the remediation workflow (see services/remediation).
 */
export interface FailureHandler {
  handle(ctx: AttemptContext, failure: FailureEvidence): Promise<JobOutcome>;
}
