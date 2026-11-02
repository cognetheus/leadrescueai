import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateLead, TENANT_FIXTURES } from '../../src/simulators/fixtures';
import { createHarness, type Harness } from '../support/harness';

describe('reconciliation duplicate prevention and verification (P05.03)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ RECONCILE_PAGE_SIZE: '7' });
  });
  afterAll(() => h.close());

  const tenantId = () => h.tenants['acme-roofing']!.id;
  const delivery = (leadId: string) => h.container.repos.deliveries.getByLead(tenantId(), 'meta_lead_ads', leadId);
  const deliveriesFor = (leadId: string) =>
    (h.container.db.prepare('SELECT count(*) AS n FROM deliveries WHERE tenant_id = ? AND source_lead_id = ?').get(tenantId(), leadId) as { n: number }).n;

  it('a late webhook racing a backfill of the same lead yields one delivery and one contact', async () => {
    const { leadId } = await h.submitLead({ seed: 701, scenario: 'lost_webhook' });
    await Promise.all([h.reconcile(['acme-roofing']), h.sim.redeliverWebhook(leadId)]);
    await h.drain();
    expect(deliveriesFor(leadId)).toBe(1);
    expect(delivery(leadId)!.status).toBe('delivered');
    expect(await h.contactsFor('acme-roofing', leadId)).toHaveLength(1);
  });

  it('two concurrent reconciliation runs do not duplicate backfills', async () => {
    const lost: string[] = [];
    for (let i = 0; i < 3; i++) lost.push((await h.submitLead({ seed: 710 + i, scenario: 'lost_webhook' })).leadId);
    h.clock.advance(1_000);
    const [a, b] = await Promise.all([h.reconcile(['acme-roofing']), h.reconcile(['acme-roofing'])]);
    await h.drain();
    expect(Number(a.missing) + Number(b.missing)).toBeGreaterThanOrEqual(3);
    for (const id of lost) {
      expect(deliveriesFor(id)).toBe(1);
      expect(await h.contactsFor('acme-roofing', id)).toHaveLength(1);
    }
    expect((await h.sim.crmDuplicates()).duplicates).toEqual([]);
  });

  it('reports a backfill that cannot finish yet, and the regular worker completes it without duplication', async () => {
    const seed = 720;
    const leadId = generateLead(seed, TENANT_FIXTURES[0]).id;
    await h.sim.addFault({ target: 'crm.create_contact', scopeKey: TENANT_FIXTURES[0].crmLocationId, matchKey: leadId, effect: { type: 'http_error', status: 503 }, remaining: 1, label: 'backfill 503' });
    await h.submitLead({ seed, scenario: 'lost_webhook' });
    h.clock.advance(1_000);
    const report = await h.reconcile(['acme-roofing']);
    expect(report).toMatchObject({ missing: 1, backfillVerified: 0, backfillPending: 1 });
    expect(h.container.repos.reconciliation.findings(report.runId)[0]!.outcome).toMatch(/retry_scheduled/);

    // Next run sees the delivery in flight with a live job: no second backfill.
    h.clock.advance(1_000);
    const again = await h.reconcile(['acme-roofing']);
    expect(again).toMatchObject({ missing: 0 });
    await h.drain();
    expect(delivery(leadId)!.status).toBe('delivered');
    expect(await h.contactsFor('acme-roofing', leadId)).toHaveLength(1);
  });

  it('reports escalated leads without re-driving them', async () => {
    const { leadId } = await h.submitLead({ seed: 730, scenario: 'missing_required_field' });
    await h.drain();
    expect(delivery(leadId)!.status).toBe('escalated');
    const attemptsBefore = h.container.repos.attempts.forDelivery(delivery(leadId)!.id).length;
    h.clock.advance(1_000);
    const report = await h.reconcile(['acme-roofing']);
    expect(h.container.repos.reconciliation.findings(report.runId)).toEqual(expect.arrayContaining([expect.objectContaining({ sourceLeadId: leadId, finding: 'escalated', action: 'report_only' })]));
    expect(h.container.repos.attempts.forDelivery(delivery(leadId)!.id)).toHaveLength(attemptsBefore);
    expect(delivery(leadId)!.status).toBe('escalated');
  });

  it('a large paginated scan with many lost webhooks recovers every lead exactly once', async () => {
    const leads: string[] = [];
    for (let i = 0; i < 36; i++) leads.push((await h.submitLead({ tenant: 'summit-hvac', seed: 800 + i, scenario: i % 3 === 0 ? 'lost_webhook' : 'healthy' })).leadId);
    await h.drain();
    h.clock.advance(1_000);
    const report = await h.reconcile(['summit-hvac']);
    expect(report).toMatchObject({ status: 'completed', missing: 12, backfillVerified: 12 });
    const summit = h.tenants['summit-hvac']!;
    for (const id of leads) {
      expect(h.container.repos.deliveries.getByLead(summit.id, 'meta_lead_ads', id)!.status).toBe('delivered');
      expect(await h.contactsFor('summit-hvac', id)).toHaveLength(1);
    }
  });
});
