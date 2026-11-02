/**
 * Failure taxonomy. Classification is deterministic and drives remediation;
 * the LLM never classifies failures that decide what the system does.
 */
export const FAILURE_CLASSES = [
  'transient', // retryable infrastructure faults: 5xx, 429, connection errors before a write
  'authentication', // access token rejected; may be fixable by refresh
  'validation', // lead data cannot satisfy the CRM contract
  'ambiguous_write', // a write may or may not have committed (timeout / 5xx after send)
  'verification', // CRM state read back does not match what was sent
  'permanent', // non-retryable: forbidden, not found, revoked credentials, contract errors
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const PIPELINE_STAGES = [
  'load', 'fetch_source', 'validate', 'idempotency', 'find_contact', 'create_contact', 'read_back', 'verify', 'commit', 'credentials',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Sanitized, persisted evidence of one failed pipeline step. */
export interface FailureEvidence {
  failureClass: FailureClass;
  code: string;
  stage: PipelineStage;
  message: string;
  httpStatus?: number;
  retryAfterMs?: number;
  /** For writes: whether the request may have reached the remote system. */
  requestSent?: boolean;
  endpoint?: string;
  details?: Record<string, unknown>;
  occurredAt: string;
}

/** Error raised by pipeline steps; carries its classification to the remediation workflow. */
export class PipelineError extends Error {
  constructor(readonly evidence: Omit<FailureEvidence, 'occurredAt'>) {
    super(`[${evidence.failureClass}/${evidence.code}] ${evidence.message}`);
    this.name = 'PipelineError';
  }
}

export function isPipelineError(err: unknown): err is PipelineError {
  return err instanceof PipelineError || (err as { name?: string })?.name === 'PipelineError';
}
