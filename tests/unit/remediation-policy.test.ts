import { describe, expect, it } from 'vitest';
import type { FailureClass } from '../../src/domain/failure';
import type { RemediationAction, RemediationContext } from '../../src/domain/remediation';
import { selectRemediation } from '../../src/domain/remediation-policy';
import { IntegrationError } from '../../src/integrations/errors';
import { classifyIntegrationError } from '../../src/services/failure-classifier';
import { backoffDelay } from '../../src/services/retry-policy';

const policy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000, deadlineMs: 600_000 };
const ctx = (failureClass: FailureClass, over: Partial<RemediationContext> = {}): RemediationContext => ({
  failureClass, code: 'x', attemptNumber: 1, firstReceivedAt: 0, now: 10_000, previousActions: [], ...over,
});
const decide = (c: RemediationContext, backoff = 2_000) => selectRemediation(c, policy, backoff);

describe('failure classification', () => {
  const err = (provider: 'crm' | 'meta', operation: string, kind: 'http' | 'timeout' | 'network' | 'protocol', details: Partial<IntegrationError['details']> = {}) =>
    new IntegrationError(provider, operation, kind, 'boom', { requestSent: true, endpoint: '/x', ...details });

  it.each([
    [err('crm', 'create_contact', 'http', { httpStatus: 503 }), 'transient', 'crm_create_contact_unavailable'],
    [err('crm', 'create_contact', 'http', { httpStatus: 429, retryAfterMs: 3_000 }), 'transient', 'crm_create_contact_rate_limited'],
    [err('crm', 'create_contact', 'timeout'), 'ambiguous_write', 'crm_create_contact_outcome_unknown'],
    [err('crm', 'create_contact', 'http', { httpStatus: 502 }), 'ambiguous_write', 'crm_create_contact_outcome_unknown'],
    [err('crm', 'create_contact', 'network', { requestSent: false }), 'transient', 'crm_create_contact_network'],
    [err('crm', 'search_contacts', 'timeout'), 'transient', 'crm_search_contacts_timeout'],
    [err('crm', 'search_contacts', 'http', { httpStatus: 401, providerCode: 'token_expired' }), 'authentication', 'crm_access_token_expired'],
    [err('crm', 'refresh_token', 'http', { httpStatus: 400, providerCode: 'invalid_grant' }), 'permanent', 'crm_refresh_grant_revoked'],
    [err('crm', 'refresh_token', 'http', { httpStatus: 503 }), 'transient', 'crm_token_endpoint_unavailable'],
    [err('crm', 'create_contact', 'http', { httpStatus: 422 }), 'validation', 'crm_create_contact_rejected'],
    [err('crm', 'get_contact', 'http', { httpStatus: 403 }), 'permanent', 'crm_get_contact_forbidden'],
    [err('meta', 'get_lead', 'http', { httpStatus: 404 }), 'permanent', 'source_lead_not_found'],
    [err('meta', 'get_lead', 'http', { httpStatus: 401 }), 'permanent', 'source_page_token_invalid'],
    [err('meta', 'get_lead', 'protocol'), 'transient', 'meta_get_lead_malformed_response'],
  ])('%#: %s -> %s', (e, failureClass, code) => {
    expect(classifyIntegrationError(e, 'create_contact')).toMatchObject({ failureClass, code });
  });

  it('carries Retry-After and the ambiguity flag into evidence', () => {
    expect(classifyIntegrationError(err('crm', 'create_contact', 'http', { httpStatus: 429, retryAfterMs: 3_000 }), 'create_contact')).toMatchObject({ retryAfterMs: 3_000, requestSent: true, httpStatus: 429 });
  });
});

describe('remediation policy', () => {
  it.each<[FailureClass, string, RemediationAction]>([
    ['transient', 'crm_create_contact_unavailable', 'retry_with_backoff'],
    ['authentication', 'crm_access_token_expired', 'refresh_token_and_retry'],
    ['validation', 'source_lead_invalid', 'refetch_source_and_retry'],
    ['validation', 'crm_create_contact_rejected', 'escalate'],
    ['ambiguous_write', 'crm_create_contact_outcome_unknown', 'crm_read_before_retry'],
    ['verification', 'crm_verification_mismatch', 'reverify_crm_record'],
    ['permanent', 'crm_refresh_grant_revoked', 'escalate'],
  ])('%s/%s -> %s', (failureClass, code, action) => {
    expect(decide(ctx(failureClass, { code })).action).toBe(action);
  });

  it('retry limits terminate: every class escalates at the attempt limit', () => {
    for (const c of ['transient', 'authentication', 'ambiguous_write', 'verification'] as const) {
      expect(decide(ctx(c, { code: 'source_lead_invalid', attemptNumber: 5 })).action).toBe('escalate');
    }
  });

  it('a simulated retry loop of a persistent transient fault always terminates within the limit', () => {
    let attempt = 1;
    let decision = decide(ctx('transient', { attemptNumber: attempt }));
    while (decision.action !== 'escalate') {
      attempt++;
      expect(attempt).toBeLessThanOrEqual(policy.maxAttempts);
      decision = decide(ctx('transient', { attemptNumber: attempt }));
    }
    expect(attempt).toBe(policy.maxAttempts);
  });

  it('escalates when the next retry would pass the delivery deadline', () => {
    expect(decide(ctx('transient', { now: 599_000 }), 2_000).action).toBe('escalate');
    expect(decide(ctx('transient', { now: 597_000 }), 2_000).action).toBe('retry_with_backoff');
  });

  it('refreshes at most once per failure streak, re-fetches once, re-verifies twice', () => {
    expect(decide(ctx('authentication', { previousActions: ['refresh_token_and_retry'] })).action).toBe('escalate');
    expect(decide(ctx('authentication', { previousActions: ['refresh_token_and_retry', 'retry_with_backoff'] })).action).toBe('refresh_token_and_retry');
    expect(decide(ctx('validation', { code: 'source_lead_invalid', previousActions: ['refetch_source_and_retry'] })).action).toBe('escalate');
    expect(decide(ctx('verification', { previousActions: ['reverify_crm_record'] })).action).toBe('reverify_crm_record');
    expect(decide(ctx('verification', { previousActions: ['reverify_crm_record', 'reverify_crm_record'] })).action).toBe('escalate');
  });
});

describe('backoff', () => {
  it('grows exponentially, caps, is deterministic, and honors Retry-After as a floor', () => {
    const d = (n: number, ra?: number) => backoffDelay(policy, n, 'dlv_1', ra);
    expect(d(1)).toBe(d(1));
    expect(d(1)).toBeGreaterThanOrEqual(800);
    expect(d(1)).toBeLessThanOrEqual(1_200);
    expect(d(3)).toBeGreaterThanOrEqual(3_200);
    expect(d(20)).toBeLessThanOrEqual(36_000);
    expect(d(1, 10_000)).toBe(10_000);
    expect(backoffDelay(policy, 1, 'dlv_2')).not.toBe(d(1)); // jitter spreads deliveries
  });
});
