import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/container';
import { silentLogger } from '../../src/shared/logger';
import { createHarness, type Harness } from '../support/harness';

describe('recovery actions and token refresh (P04.02)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const delivery = (leadId: string, tenant = 'acme-roofing') => h.container.repos.deliveries.getByLead(h.tenants[tenant]!.id, 'meta_lead_ads', leadId)!;
  const actions = (leadId: string, tenant = 'acme-roofing') => h.container.repos.attempts.forDelivery(delivery(leadId, tenant).id).map((a) => a.remediation?.action ?? null);
  const incidentFor = (leadId: string, tenant = 'acme-roofing') => h.container.repos.incidents.forDelivery(delivery(leadId, tenant).id)[0]!;

  it('HTTP 503 recovers within bounds via backoff retries', async () => {
    const { leadId } = await h.submitLead({ seed: 401, scenario: 'crm_503' });
    await h.drain();
    expect(delivery(leadId)).toMatchObject({ status: 'delivered', attemptCount: 3 });
    expect(actions(leadId)).toEqual(['retry_with_backoff', 'retry_with_backoff', null]);
    expect(await h.contactsFor('acme-roofing', leadId)).toHaveLength(1);
    expect(incidentFor(leadId)).toMatchObject({ status: 'recovered', severity: 'low' });
  });

  it('HTTP 429 retry honors Retry-After', async () => {
    const { leadId } = await h.submitLead({ seed: 402, scenario: 'crm_429' });
    const before = h.clock.now();
    await h.drain();
    const [first] = h.container.repos.attempts.forDelivery(delivery(leadId).id);
    expect(first!.remediation!.retryAt! - first!.finishedAt!).toBeGreaterThanOrEqual(3_000);
    expect(h.clock.now() - before).toBeGreaterThanOrEqual(3_000);
    expect(delivery(leadId).status).toBe('delivered');
  });

  it('expired access tokens are refreshed (rotated) automatically', async () => {
    const tenant = h.tenants['acme-roofing']!;
    const credBefore = h.container.repos.credentials.get(tenant.id, 'crm')!;
    const { leadId } = await h.submitLead({ seed: 403, scenario: 'expired_token' });
    await h.drain();
    const credAfter = h.container.repos.credentials.get(tenant.id, 'crm')!;
    expect(delivery(leadId)).toMatchObject({ status: 'delivered', attemptCount: 2 });
    expect(actions(leadId)).toEqual(['refresh_token_and_retry', null]);
    expect(credAfter.version).toBe(credBefore.version + 1);
    expect(credAfter.secrets.refreshToken).not.toBe(credBefore.secrets.refreshToken);
    expect(h.container.repos.audit.forEntity('credential', credAfter.id).map((a) => a.action)).toContain('credential.refreshed');
  });

  it('revoked refresh grants escalate as critical and stop further token calls', async () => {
    const { leadId } = await h.submitLead({ tenant: 'summit-hvac', seed: 404, scenario: 'revoked_refresh_token' });
    await h.drain();
    const tenant = h.tenants['summit-hvac']!;
    expect(delivery(leadId, 'summit-hvac')).toMatchObject({ status: 'escalated', lastFailureCode: 'crm_refresh_grant_revoked' });
    expect(h.container.repos.credentials.get(tenant.id, 'crm')!.status).toBe('revoked');
    expect(incidentFor(leadId, 'summit-hvac')).toMatchObject({ status: 'escalated', severity: 'critical' });
    expect(await h.contactsFor('summit-hvac', leadId)).toHaveLength(0);

    // The next lead for this tenant escalates immediately without touching the token endpoint.
    const { leadId: next } = await h.submitLead({ tenant: 'summit-hvac', seed: 405 });
    await h.drain();
    expect(delivery(next, 'summit-hvac')).toMatchObject({ status: 'escalated', lastFailureCode: 'crm_credentials_revoked', attemptCount: 1 });
  });

  it('timeout after a committed CRM write is resolved by read-before-retry without a duplicate', async () => {
    const { leadId } = await h.submitLead({ seed: 406, scenario: 'timeout_after_commit' });
    await h.drain();
    const d = delivery(leadId);
    const attempts = h.container.repos.attempts.forDelivery(d.id);
    expect(d.status).toBe('delivered');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'succeeded', failure: { failureClass: 'ambiguous_write' }, remediation: { action: 'crm_read_before_retry' } });
    expect(await h.contactsFor('acme-roofing', leadId)).toHaveLength(1);
    expect(incidentFor(leadId).status).toBe('recovered');
  });

  it('a stale partial source read is fixed by a canonical re-fetch', async () => {
    const { leadId } = await h.submitLead({ seed: 407, scenario: 'partial_source_read' });
    await h.drain();
    expect(delivery(leadId)).toMatchObject({ status: 'delivered', attemptCount: 2 });
    expect(actions(leadId)).toEqual(['refetch_source_and_retry', null]);
  });

  it('a lead that is invalid at the source is re-fetched once, then escalated without fabrication', async () => {
    const { leadId } = await h.submitLead({ seed: 408, scenario: 'missing_required_field' });
    await h.drain();
    const attempts = h.container.repos.attempts.forDelivery(delivery(leadId).id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.remediation!.reason).toMatch(/still invalid after re-fetch|refusing to fabricate|will not be fabricated/);
    expect(delivery(leadId)).toMatchObject({ status: 'escalated', lastFailureClass: 'validation' });
    expect(await h.contactsFor('acme-roofing', leadId)).toHaveLength(0);
  });

  it('persistent verification mismatch is re-verified twice and then escalated', async () => {
    const { leadId } = await h.submitLead({ seed: 409, scenario: 'verification_mismatch' });
    await h.drain();
    expect(actions(leadId)).toEqual(['reverify_crm_record', 'reverify_crm_record', 'escalate']);
    expect(delivery(leadId)).toMatchObject({ status: 'escalated', lastFailureClass: 'verification', deliveredAt: null });
    expect(await h.contactsFor('acme-roofing', leadId)).toHaveLength(1); // the contact exists but was never claimed as delivered
  });

  it('concurrent refreshes from two workers rotate once and never trigger reuse revocation', async () => {
    const tenant = h.tenants['acme-roofing']!;
    await h.sim.expireAccessTokens(tenant.crmLocationId);
    const other = createContainer({ config: h.container.config, clock: h.clock, logger: silentLogger });
    const since = h.clock.now();
    const [a, b] = await Promise.all([
      h.container.services.refresher.refresh(tenant.id, { owner: 'w1', staleSince: since }),
      other.services.refresher.refresh(tenant.id, { owner: 'w2', staleSince: since }),
    ]);
    other.db.close();
    expect([a.outcome, b.outcome].sort()).toEqual(['already_refreshed', 'refreshed']);
    const cred = h.container.repos.credentials.get(tenant.id, 'crm')!;
    expect(cred.status).toBe('active');
    // The stored (latest) refresh token still works: the grant was not revoked by a replay.
    await expect(h.container.services.crm.refreshToken(cred.secrets)).resolves.toBeTruthy();
  });
});
