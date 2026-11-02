import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../support/harness';

describe('scheduled reconciliation and backfill (P05.02)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ RECONCILE_PAGE_SIZE: '5' });
  });
  afterAll(() => h.close());

  const delivery = (leadId: string, tenant = 'acme-roofing') => h.container.repos.deliveries.getByLead(h.tenants[tenant]!.id, 'meta_lead_ads', leadId);

  it('declares a cron schedule on the workflow', () => {
    const wf = h.mastra.getWorkflow('sourceReconciliationWorkflow');
    expect(wf.getScheduleConfigs()).toEqual([expect.objectContaining({ cron: '*/5 * * * *', inputData: { trigger: 'schedule' } })]);
  });

  it('discovers a lead whose webhook was lost and delivers it through the pipeline, verified', async () => {
    const { leadId, webhook } = await h.submitLead({ seed: 601, scenario: 'lost_webhook' });
    for (let i = 0; i < 4; i++) await h.submitLead({ seed: 610 + i }); // healthy neighbours across pages
    await h.drain();
    expect(webhook.outcome).toBe('dropped');
    expect(delivery(leadId)).toBeUndefined();

    const report = await h.reconcile();
    expect(report).toMatchObject({ status: 'completed', missing: 1, backfillVerified: 1, backfillPending: 0 });
    expect(delivery(leadId)).toMatchObject({ status: 'delivered', trigger: 'reconciliation' });
    expect(await h.contactsFor('acme-roofing', leadId)).toHaveLength(1);

    const [incident] = h.container.repos.incidents.forDelivery(delivery(leadId)!.id);
    expect(incident).toMatchObject({ kind: 'lost_webhook', status: 'recovered' });
    expect(h.container.repos.incidents.events(incident!.id).map((e) => e.type)).toEqual(['detected', 'remediation_selected', 'verification_passed', 'recovered']);
    const findings = h.container.repos.reconciliation.findings(report.runId);
    expect(findings).toEqual([expect.objectContaining({ sourceLeadId: leadId, finding: 'missing', action: 'reconciliation_backfill', outcome: 'delivered and verified in CRM' })]);
    expect(h.container.repos.reconciliation.getCheckpoint(h.tenants['acme-roofing']!.id, 'meta_lead_ads')).toBeDefined();
  });

  it('is idempotent: a second run over the overlapping window changes nothing', async () => {
    const contactsBefore = (await h.sim.crmContacts()).contacts.length;
    h.clock.advance(60_000);
    const report = await h.reconcile();
    expect(report).toMatchObject({ status: 'completed', missing: 0, backfillVerified: 0 });
    expect((await h.sim.crmContacts()).contacts.length).toBe(contactsBefore);
    expect((await h.sim.crmDuplicates()).duplicates).toEqual([]);
  });

  it('re-queues an in-flight delivery that lost its job, after checking the CRM', async () => {
    const { leadId } = await h.submitLead({ seed: 620 });
    const d = delivery(leadId)!;
    const job = h.container.queue.liveByDedupeKey(`deliver:${d.id}`)!;
    h.container.queue.cancelQueued(job.id); // e.g. an operator mistake or a lost queue row
    const report = await h.reconcile(['acme-roofing']);
    expect(report.backfillVerified).toBe(1);
    expect(delivery(leadId)!.status).toBe('delivered');
    expect(h.container.repos.reconciliation.findings(report.runId)).toEqual([expect.objectContaining({ finding: 'stalled', action: 'requeue_delivery' })]);
  });

  it('a failing tenant segment does not block others and keeps its checkpoint', async () => {
    const acme = h.tenants['acme-roofing']!;
    const summit = h.tenants['summit-hvac']!;
    await h.submitLead({ tenant: 'summit-hvac', seed: 630, scenario: 'lost_webhook' });
    const acmeBefore = h.container.repos.reconciliation.getCheckpoint(acme.id, 'meta_lead_ads');
    await h.sim.addFault({ target: 'meta.list_leads', scopeKey: acme.metaPageId, effect: { type: 'http_error', status: 503 }, remaining: 1, label: 'acme list outage' });
    h.clock.advance(60_000);
    const report = await h.reconcile();
    expect(report).toMatchObject({ status: 'partial', failedTenants: ['acme-roofing'], backfillVerified: 1 });
    expect(h.container.repos.reconciliation.getCheckpoint(acme.id, 'meta_lead_ads')).toEqual(acmeBefore);
    expect(h.container.repos.reconciliation.getCheckpoint(summit.id, 'meta_lead_ads')!.lastRunId).toBe(report.runId);
    expect(h.container.repos.reconciliation.getRun(report.runId)).toMatchObject({ status: 'partial' });
  });
});
