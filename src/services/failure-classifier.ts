import type { IntegrationError } from '../integrations/errors';
import { PipelineError, type FailureEvidence, type PipelineStage } from '../domain/failure';

type Evidence = Omit<FailureEvidence, 'occurredAt'>;

const WRITE_OPERATIONS = new Set(['create_contact']);

/**
 * Deterministic classification of integration failures. This is the single place that
 * decides whether a failure is retryable, needs credentials, is ambiguous, or is final.
 *
 * Write semantics: 429 and 503 are explicit "not processed" refusals and are transient;
 * 500/502/504, timeouts and dropped connections after the request was sent leave the
 * outcome unknown, so they are ambiguous writes that must be resolved by reading first.
 */
export function classifyIntegrationError(err: IntegrationError, stage: PipelineStage): Evidence {
  const { httpStatus, retryAfterMs, requestSent, providerCode, endpoint } = err.details;
  const prefix = `${err.provider}_${err.operation}`;
  const base = { stage, message: err.message, endpoint, ...(httpStatus ? { httpStatus } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), requestSent };
  const isWrite = WRITE_OPERATIONS.has(err.operation);

  if (err.operation === 'refresh_token') {
    if (providerCode === 'invalid_grant') return { ...base, failureClass: 'permanent', code: 'crm_refresh_grant_revoked' };
    if (httpStatus === 401 || providerCode === 'invalid_client') return { ...base, failureClass: 'permanent', code: 'crm_client_credentials_invalid' };
    if (httpStatus === 429 || (httpStatus ?? 0) >= 500 || err.kind !== 'http') return { ...base, failureClass: 'transient', code: 'crm_token_endpoint_unavailable' };
    return { ...base, failureClass: 'permanent', code: 'crm_token_refresh_failed' };
  }

  if (err.kind === 'protocol') return { ...base, failureClass: 'transient', code: `${prefix}_malformed_response` };
  if (err.kind === 'timeout' || err.kind === 'network') {
    if (isWrite && requestSent) return { ...base, failureClass: 'ambiguous_write', code: `${prefix}_outcome_unknown` };
    return { ...base, failureClass: 'transient', code: `${prefix}_${err.kind}` };
  }

  const status = httpStatus ?? 0;
  if (status === 429) return { ...base, failureClass: 'transient', code: `${prefix}_rate_limited` };
  if (status === 503) return { ...base, failureClass: 'transient', code: `${prefix}_unavailable` };
  if (status >= 500) {
    return isWrite ? { ...base, failureClass: 'ambiguous_write', code: `${prefix}_outcome_unknown` } : { ...base, failureClass: 'transient', code: `${prefix}_http_${status}` };
  }
  if (status === 401) {
    if (err.provider === 'crm') return { ...base, failureClass: 'authentication', code: providerCode === 'token_expired' ? 'crm_access_token_expired' : 'crm_access_token_rejected' };
    return { ...base, failureClass: 'permanent', code: 'source_page_token_invalid' };
  }
  if (status === 404 && err.provider === 'meta') return { ...base, failureClass: 'permanent', code: 'source_lead_not_found' };
  if (status === 422 || status === 400) return { ...base, failureClass: status === 422 ? 'validation' : 'permanent', code: `${prefix}_rejected` };
  if (status === 403) return { ...base, failureClass: 'permanent', code: `${prefix}_forbidden` };
  return { ...base, failureClass: 'permanent', code: `${prefix}_http_${status}` };
}

export function toPipelineError(err: unknown, stage: PipelineStage): PipelineError {
  if (err instanceof PipelineError) return err;
  if ((err as { name?: string })?.name === 'IntegrationError') return new PipelineError(classifyIntegrationError(err as IntegrationError, stage));
  // Unknown internal error: retry within limits, but keep the evidence.
  return new PipelineError({ failureClass: 'transient', code: 'internal_error', stage, message: (err as Error)?.message ?? String(err) });
}
