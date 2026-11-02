import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/container';
import { toCrmContact } from '../../src/services/delivery-pipeline';
import { createJobRunner } from '../../src/jobs/create-runner';
import { validateAndNormalizeLead } from '../../src/domain/lead';
import { generateLead, TENANT_FIXTURES } from '../../src/simulators/fixtures';
import { silentLogger } from '../../src/shared/logger';
import { createHarness, type Harness } from '../support/harness';

const acme = TENANT_FIXTURES[0];

describe('delivery guarantees (P03.03)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const delivery = (leadId: string, tenant = 'acme-roofing') => h.container.repos.deliveries.getByLead(h.tenants[tenant]!.id, 'meta_lead_ads', leadId)!;
  const crmToken = (tenant = 'acme-roofing') => h.container.repos.credentials.get(h.tenants[tenant]!.id, 'crm')!.secrets.accessToken;

  it('duplicate webhooks produce exactly one delivery and one CRM contact', async () => {
    const { leadId } = await h.submitLead({ seed: 101, scenario: 'duplicate_webhook' });
    await h.sim.redeliverWebhook(leadId); // and the platform retries once more later
    await h.drain();
    expect(delivery(leadId)).toMatchObject({ status: 'delivered', attemptCount: 1 });
    expect(await h.contactsFor('acme-roofing', leadId)).toHaveLength(1);
    const audit = h.container.repos.audit.forEntity('delivery', delivery(leadId).id).map((a) => a.action);
    expect(audit.filter((a) => a === 'webhook.duplicate_lead')).toHaveLength(3);
    expect(audit.filter((a) => a === 'crm.create_requested')).toHaveLength(1);
  });

  it('adopts a contact that already exists in the CRM instead of creating another', async () => {
    const seed = 102;
    const lead = generateLead(seed, acme);
    const normalized = validateAndNormalizeLead({ id: lead.id, created_time: new Date().toISOString(), form_id: lead.formId, page_id: acme.metaPageId, field_data: Object.entries(lead.fields).map(([name, v]) => ({ name, values: [v] })) });
    if (!normalized.ok) throw new Error('fixture invalid');
    const existing = await h.container.services.crm.createContact(crmToken(), toCrmContact(h.tenants['acme-roofing']!, normalized.lead));
    await h.submitLead({ seed });
    await h.drain();
    expect(delivery(lead.id)).toMatchObject({ status: 'delivered', crmContactId: existing.id });
    expect(await h.contactsFor('acme-roofing', lead.id)).toHaveLength(1);
    expect(h.container.repos.audit.forEntity('delivery', delivery(lead.id).id).find((a) => a.action === 'delivery.delivered')?.data).toMatchObject({ contactOrigin: 'existing' });
  });

  it('refuses to pick between pre-existing duplicate contacts and escalates', async () => {
    const seed = 103;
    const lead = generateLead(seed, acme);
    const base = { locationId: acme.crmLocationId, firstName: 'Dup', lastName: null, email: 'dup@example.com', phone: null, postalCode: null, source: 'manual', externalSourceId: lead.id, tags: [], customFields: {} };
    await h.container.services.crm.createContact(crmToken(), base);
    await h.container.services.crm.createContact(crmToken(), base);
    await h.submitLead({ seed });
    await h.drain();
    expect(delivery(lead.id)).toMatchObject({ status: 'escalated', lastFailureCode: 'crm_duplicate_contacts_detected' });
    expect(await h.contactsFor('acme-roofing', lead.id)).toHaveLength(2); // nothing added
  });

  it('never reports success when the CRM read-back does not match', async () => {
    const { leadId } = await h.submitLead({ seed: 104, scenario: 'verification_mismatch' });
    await h.drain();
    const d = delivery(leadId);
    expect(d.status).not.toBe('delivered');
    expect(d.deliveredAt).toBeNull();
    expect(d.lastFailureClass).toBe('verification');
    const attempts = h.container.repos.attempts.forDelivery(d.id);
    expect(attempts.every((a) => a.status === 'failed')).toBe(true);
    expect(attempts[0]!.failure?.details).toMatchObject({ mismatchedFields: ['email'] });
    expect(h.container.repos.audit.forEntity('delivery', d.id).some((a) => a.action === 'delivery.delivered')).toBe(false);
  });

  it('handles invalid leads safely: no CRM write, no fabricated data', async () => {
    const { leadId } = await h.submitLead({ seed: 105, scenario: 'missing_required_field' });
    await h.drain();
    expect(delivery(leadId)).toMatchObject({ status: 'escalated', lastFailureClass: 'validation', crmContactId: null });
    expect(await h.contactsFor('acme-roofing', leadId)).toHaveLength(0);
  });

  it('keeps tenants isolated end to end', async () => {
    const a = await h.submitLead({ tenant: 'acme-roofing', seed: 106 });
    const b = await h.submitLead({ tenant: 'summit-hvac', seed: 107 });
    await h.drain();
    expect(await h.contactsFor('acme-roofing', a.leadId)).toHaveLength(1);
    expect(await h.contactsFor('summit-hvac', b.leadId)).toHaveLength(1);
    expect(await h.contactsFor('summit-hvac', a.leadId)).toHaveLength(0);
    expect(await h.contactsFor('acme-roofing', b.leadId)).toHaveLength(0);
    expect(delivery(b.leadId, 'summit-hvac').tenantId).toBe(h.tenants['summit-hvac']!.id);
  });

  it('competing workers deliver every lead exactly once', async () => {
    // A second worker process: its own database connection, same database file.
    const other = createContainer({ config: h.container.config, clock: h.clock, logger: silentLogger });
    const runners = [
      createJobRunner(h.container, h.mastra, { workerId: 'worker-1', concurrency: 3 }),
      createJobRunner(other, h.mastra, { workerId: 'worker-2', concurrency: 3 }),
    ];
    const leads: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { leadId } = await h.submitLead({ seed: 200 + i, tenant: i % 2 ? 'summit-hvac' : 'acme-roofing', scenario: i % 3 === 0 ? 'duplicate_webhook' : 'healthy' });
      leads.push(leadId);
    }
    runners.forEach((r) => r.start());
    for (let i = 0; i < 300; i++) {
      const pending = leads.filter((id, n) => delivery(id, n % 2 ? 'summit-hvac' : 'acme-roofing').status !== 'delivered');
      if (!pending.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await Promise.all(runners.map((r) => r.stop()));
    other.db.close();
    for (const [n, id] of leads.entries()) {
      const tenant = n % 2 ? 'summit-hvac' : 'acme-roofing';
      expect(delivery(id, tenant).status).toBe('delivered');
      expect(await h.contactsFor(tenant, id)).toHaveLength(1);
    }
    expect((await h.sim.crmDuplicates()).duplicates.filter((d) => leads.includes(d.externalSourceId))).toEqual([]);
  });

  it('a second live job for the same delivery cannot run concurrently (single-flight)', async () => {
    const seed = 300;
    const lead = generateLead(seed, acme);
    await h.sim.addFault({ target: 'crm.create_contact', scopeKey: acme.crmLocationId, matchKey: lead.id, effect: { type: 'delay', ms: 400 }, remaining: 1, label: 'slow create' });
    await h.submitLead({ seed });
    const d = delivery(lead.id);
    // Bypass job dedupe on purpose: a rogue duplicate job for the same delivery.
    h.container.queue.enqueue('deliver_lead', { deliveryId: d.id, correlationId: d.correlationId }, { dedupeKey: 'rogue-duplicate' });
    const other = createContainer({ config: h.container.config, clock: h.clock, logger: silentLogger });
    const r1 = createJobRunner(h.container, h.mastra, { workerId: 'w-a', concurrency: 1 });
    const r2 = createJobRunner(other, h.mastra, { workerId: 'w-b', concurrency: 1 });
    await Promise.all([r1.runOnce(), r2.runOnce()]);
    other.db.close();
    // Whichever job lost the race was deferred: the overlap really happened and was blocked.
    const jobs = h.container.queue.list().filter((j) => (j.payload as { deliveryId: string }).deliveryId === d.id);
    expect(jobs.filter((j) => /is in progress on w-/.test(j.lastError ?? ''))).toHaveLength(1);
    await h.drain();
    expect(delivery(lead.id).status).toBe('delivered');
    expect(await h.contactsFor('acme-roofing', lead.id)).toHaveLength(1);
    expect(h.container.repos.attempts.forDelivery(d.id).filter((a) => a.status === 'succeeded')).toHaveLength(1);
  });
});
