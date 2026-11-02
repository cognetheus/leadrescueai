import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CrmClient, type NewCrmContact } from '../../src/integrations/crm';
import { IntegrationError } from '../../src/integrations/errors';
import { startSimulator } from '../support/simulator';

const contact = (over: Partial<NewCrmContact> = {}): NewCrmContact => ({
  locationId: 'loc-a', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+15125550101', postalCode: '78701',
  source: 'Meta Lead Ads', externalSourceId: 'lead-1', tags: ['meta-lead'], customFields: {}, ...over,
});

describe('CRM simulator (P02.02)', () => {
  let sim: Awaited<ReturnType<typeof startSimulator>>;
  let crm: CrmClient;
  let tokensA: { access_token: string; refresh_token: string };
  let tokensB: { access_token: string; refresh_token: string };
  const clientA = { clientId: 'client-a-123', clientSecret: 'client-secret-a-0123456789' };

  beforeAll(async () => {
    sim = await startSimulator();
    crm = new CrmClient(sim.url, 1_000);
    tokensA = (await sim.admin('POST', '/sim-admin/crm/locations', { locationId: 'loc-a', name: 'A', ...clientA })) as typeof tokensA;
    tokensB = (await sim.admin('POST', '/sim-admin/crm/locations', { locationId: 'loc-b', name: 'B', clientId: 'client-b-123', clientSecret: 'client-secret-b-0123456789' })) as typeof tokensB;
  });
  afterAll(() => sim.close());

  it('creates, finds by external id and reads back contacts', async () => {
    const created = await crm.createContact(tokensA.access_token, contact());
    const found = await crm.findByExternalId(tokensA.access_token, 'loc-a', 'lead-1');
    const read = await crm.getContact(tokensA.access_token, created.id);
    expect(found.map((c) => c.id)).toEqual([created.id]);
    expect(read).toMatchObject({ email: 'ada@example.com', phone: '+15125550101', externalSourceId: 'lead-1' });
  });

  it('does not deduplicate by itself (the caller must)', async () => {
    await crm.createContact(tokensA.access_token, contact({ externalSourceId: 'dup-1' }));
    await crm.createContact(tokensA.access_token, contact({ externalSourceId: 'dup-1' }));
    const report = await sim.admin('GET', '/sim-admin/crm/duplicates');
    expect(report.duplicates).toEqual([{ locationId: 'loc-a', externalSourceId: 'dup-1', count: 2 }]);
  });

  it('scopes tokens to their location', async () => {
    const created = await crm.createContact(tokensA.access_token, contact({ externalSourceId: 'iso-1' }));
    await expect(crm.findByExternalId(tokensB.access_token, 'loc-a', 'iso-1')).rejects.toMatchObject({ details: { httpStatus: 403 } });
    await expect(crm.getContact(tokensB.access_token, created.id)).rejects.toMatchObject({ details: { httpStatus: 404 } });
    await expect(crm.createContact(tokensB.access_token, contact({ externalSourceId: 'iso-2' }))).rejects.toMatchObject({ details: { httpStatus: 403 } });
  });

  it('rejects contacts that violate the CRM contract', async () => {
    const err = await crm.createContact(tokensA.access_token, contact({ email: null, phone: null })).catch((e: unknown) => e);
    expect(err).toMatchObject({ details: { httpStatus: 422 } });
  });

  it('expires access tokens and rotates refresh tokens', async () => {
    await sim.admin('POST', '/sim-admin/crm/locations/loc-a/expire-access-tokens');
    const expired = await crm.findByExternalId(tokensA.access_token, 'loc-a', 'lead-1').catch((e: unknown) => e);
    expect(expired).toMatchObject({ details: { httpStatus: 401, providerCode: 'token_expired' } });

    const grant = await crm.refreshToken({ ...clientA, refreshToken: tokensA.refresh_token });
    expect(grant.refreshToken).not.toBe(tokensA.refresh_token);
    await expect(crm.findByExternalId(grant.accessToken, 'loc-a', 'lead-1')).resolves.toHaveLength(1);

    // Replaying the rotated refresh token is treated as theft: the whole grant is revoked.
    const replay = await crm.refreshToken({ ...clientA, refreshToken: tokensA.refresh_token }).catch((e: unknown) => e);
    expect(replay).toMatchObject({ details: { httpStatus: 400, providerCode: 'invalid_grant' } });
    const after = await crm.refreshToken({ ...clientA, refreshToken: grant.refreshToken }).catch((e: unknown) => e);
    expect(after).toMatchObject({ details: { providerCode: 'invalid_grant' } });
    tokensA = (await sim.admin('POST', '/sim-admin/crm/locations', { locationId: 'loc-a', name: 'A', ...clientA })) as typeof tokensA; // re-install
  });

  it('commits a contact and then times out (ambiguous write)', async () => {
    await sim.admin('POST', '/sim-admin/faults', { target: 'crm.create_contact', scopeKey: 'loc-a', matchKey: 'amb-1', effect: { type: 'timeout_after_commit', delayMs: 1_500 }, label: 'timeout after commit' });
    const err = await crm.createContact(tokensA.access_token, contact({ externalSourceId: 'amb-1' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err).toMatchObject({ kind: 'timeout', details: { requestSent: true } });
    expect(await crm.findByExternalId(tokensA.access_token, 'loc-a', 'amb-1')).toHaveLength(1); // it did commit
  });

  it('serves inconsistent reads under a verification-mismatch fault', async () => {
    const created = await crm.createContact(tokensA.access_token, contact({ externalSourceId: 'mm-1' }));
    await sim.admin('POST', '/sim-admin/faults', { target: 'crm.get_contact', matchKey: 'mm-1', effect: { type: 'mutate_field', field: 'email', value: 'stale@example.com' }, label: 'stale read' });
    expect((await crm.getContact(tokensA.access_token, created.id)).email).toBe('stale@example.com');
    expect((await crm.getContact(tokensA.access_token, created.id)).email).toBe('ada@example.com');
  });

  it('returns 503/429 with retry hints under transient faults', async () => {
    await sim.admin('POST', '/sim-admin/faults', { target: 'crm.search_contacts', scopeKey: 'loc-a', effect: { type: 'http_error', status: 429, retryAfterSec: 3 }, label: 'rate limit' });
    const err = await crm.findByExternalId(tokensA.access_token, 'loc-a', 'x').catch((e: unknown) => e);
    expect(err).toMatchObject({ details: { httpStatus: 429, retryAfterMs: 3_000 } });
  });
});
