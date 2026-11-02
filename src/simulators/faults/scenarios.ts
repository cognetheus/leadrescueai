import type { FaultRuleInput } from './engine';

export const SCENARIO_NAMES = [
  'healthy',
  'crm_503',
  'crm_429',
  'expired_token',
  'revoked_refresh_token',
  'lost_webhook',
  'missing_required_field',
  'partial_source_read',
  'timeout_after_commit',
  'verification_mismatch',
  'duplicate_webhook',
  'worker_interruption',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface ScenarioPlan {
  name: ScenarioName;
  description: string;
  expectedOutcome: string;
  /** Fault rules scoped to this tenant and lead. */
  rules: FaultRuleInput[];
  /** Simulator state changes applied before the lead is created. */
  mutations: Array<'expire_access_tokens' | 'revoke_refresh_tokens'>;
  leadVariant: 'complete' | 'missing_contact';
  /** Human steps or automation the scenario needs beyond the faults (shown in demos). */
  notes?: string;
}

/**
 * Deterministic fault scenarios. Every rule is scoped to one tenant and one lead id,
 * so scenarios can run side by side without interfering, and each firing is attributable.
 */
export function planScenario(name: ScenarioName, scope: { pageId: string; locationId: string; leadId: string; clientTimeoutMs: number }): ScenarioPlan {
  const crm = { scopeKey: scope.locationId, matchKey: scope.leadId };
  const meta = { scopeKey: scope.pageId, matchKey: scope.leadId };
  const base = { name, mutations: [] as ScenarioPlan['mutations'], leadVariant: 'complete' as const, rules: [] as FaultRuleInput[] };
  switch (name) {
    case 'healthy':
      return { ...base, description: 'No faults.', expectedOutcome: 'delivered on attempt 1' };
    case 'crm_503':
      return {
        ...base,
        description: 'CRM returns HTTP 503 for the first two contact creations.',
        expectedOutcome: 'recovered by bounded retry; delivered on attempt 3 with one CRM contact',
        rules: [{ target: 'crm.create_contact', ...crm, effect: { type: 'http_error', status: 503 }, remaining: 2, label: `${name}: CRM 503 x2` }],
      };
    case 'crm_429':
      return {
        ...base,
        description: 'CRM rate-limits the first contact creation with Retry-After: 3.',
        expectedOutcome: 'retry honors Retry-After; delivered on attempt 2',
        rules: [{ target: 'crm.create_contact', ...crm, effect: { type: 'http_error', status: 429, retryAfterSec: 3 }, remaining: 1, label: `${name}: CRM 429` }],
      };
    case 'expired_token':
      return {
        ...base,
        description: "The tenant's CRM access token is expired before the lead arrives.",
        expectedOutcome: 'token refreshed (rotated) automatically; delivered',
        mutations: ['expire_access_tokens'],
      };
    case 'revoked_refresh_token':
      return {
        ...base,
        description: 'Access token expired and the refresh grant revoked (e.g. app uninstalled).',
        expectedOutcome: 'escalated: CRM re-authorization required; no contact created',
        mutations: ['expire_access_tokens', 'revoke_refresh_tokens'],
      };
    case 'lost_webhook':
      return {
        ...base,
        description: 'The leadgen webhook is never delivered.',
        expectedOutcome: 'no delivery until reconciliation discovers and backfills the lead',
        rules: [{ target: 'meta.webhook', ...meta, effect: { type: 'drop' }, remaining: 1, label: `${name}: drop webhook` }],
      };
    case 'missing_required_field':
      return {
        ...base,
        leadVariant: 'missing_contact',
        description: 'The lead was submitted without any email or phone number.',
        expectedOutcome: 'canonical source re-fetched once; still invalid, escalated; no contact fabricated',
      };
    case 'partial_source_read':
      return {
        ...base,
        description: 'The first canonical read returns the lead without contact fields (stale replica).',
        expectedOutcome: 'canonical re-fetch returns full data; delivered',
        rules: [{ target: 'meta.get_lead', ...meta, effect: { type: 'omit_fields', fields: ['email', 'phone_number'] }, remaining: 1, label: `${name}: partial read` }],
      };
    case 'timeout_after_commit':
      return {
        ...base,
        description: 'The CRM commits the contact but the response arrives after the client timeout.',
        expectedOutcome: 'read-before-retry finds the committed contact; delivered with exactly one contact',
        rules: [{ target: 'crm.create_contact', ...crm, effect: { type: 'timeout_after_commit', delayMs: scope.clientTimeoutMs + 1_500 }, remaining: 1, label: `${name}: commit then timeout` }],
      };
    case 'verification_mismatch':
      return {
        ...base,
        description: 'Every CRM read-back returns a different email than was written.',
        expectedOutcome: 'verification fails repeatedly; escalated instead of a false success',
        rules: [{ target: 'crm.get_contact', ...crm, effect: { type: 'mutate_field', field: 'email', value: 'someone.else@example.com' }, remaining: null, label: `${name}: stale read-back` }],
      };
    case 'duplicate_webhook':
      return {
        ...base,
        description: 'The platform delivers the same webhook three times.',
        expectedOutcome: 'one delivery, one CRM contact; duplicates recorded',
        rules: [{ target: 'meta.webhook', ...meta, effect: { type: 'duplicate', copies: 2 }, remaining: 1, label: `${name}: webhook x3` }],
      };
    case 'worker_interruption':
      return {
        ...base,
        description: 'The CRM create stalls long enough for the worker to be killed mid-delivery.',
        expectedOutcome: 'lease expires, another worker reclaims, finds the committed contact; one contact',
        rules: [{ target: 'crm.create_contact', ...crm, effect: { type: 'delay', ms: 8_000 }, remaining: 1, label: `${name}: slow create` }],
        notes: 'Kill the worker while the create is in flight (see `pnpm demo worker-interruption`).',
      };
  }
}
