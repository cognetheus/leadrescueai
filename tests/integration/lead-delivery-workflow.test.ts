import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../support/harness';

describe('lead-delivery workflow (P03.02)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('delivers a healthy lead through every pipeline stage and records the run', async () => {
    const { leadId, webhook } = await h.submitLead({ seed: 1 });
    expect(webhook.outcome).toBe('delivered');
    expect(await h.drain()).toBe(1);

    const tenant = h.tenants['acme-roofing']!;
    const delivery = h.container.repos.deliveries.getByLead(tenant.id, 'meta_lead_ads', leadId)!;
    expect(delivery).toMatchObject({ status: 'delivered', attemptCount: 1 });
    const [attempt] = h.container.repos.attempts.forDelivery(delivery.id);
    expect(attempt).toMatchObject({ status: 'succeeded', stageReached: 'commit', workflowRunId: attempt!.id });

    // CRM holds exactly one, correctly mapped contact.
    const contacts = await h.contactsFor('acme-roofing', leadId);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ id: delivery.crmContactId, locationId: tenant.crmLocationId, source: 'Meta Lead Ads' });
    expect(contacts[0]!.email).toMatch(/@example\.com$/);

    // Audit trail in order.
    expect(h.container.repos.audit.forEntity('delivery', delivery.id).map((a) => a.action)).toEqual([
      'delivery.accepted', 'delivery.attempt_started', 'crm.create_requested', 'delivery.delivered',
    ]);

    // Mastra persisted the run with every stage, taking the "create" branch.
    const workflows = await h.mastra.getStorage()!.getStore('workflows');
    const run = await workflows!.getWorkflowRunById({ runId: attempt!.id, workflowName: 'lead-delivery' });
    const snapshot = run!.snapshot as { status: string; context: Record<string, { status: string }> };
    expect(snapshot.status).toBe('success');
    for (const step of ['fetch-source-lead', 'validate-and-normalize', 'check-idempotency', 'find-crm-contact', 'create-crm-contact', 'read-back-contact', 'verify-contact', 'commit-delivery']) {
      expect(snapshot.context[step]?.status, step).toBe('success');
    }
    expect(snapshot.context['use-existing-contact']).toBeUndefined();
    // Neither raw customer contact data nor secrets reach Mastra's storage (snapshots, spans, logs).
    const { readFileSync, existsSync } = await import('node:fs');
    const dbFile = `${h.container.config.dataDir}/mastra.db`;
    const raw = [dbFile, `${dbFile}-wal`].filter(existsSync).map((f) => readFileSync(f).toString('latin1')).join('');
    const crmCred = h.container.repos.credentials.get(tenant.id, 'crm')!.secrets;
    const metaCred = h.container.repos.credentials.get(tenant.id, 'meta')!.secrets;
    for (const secret of [
      String(contacts[0]!.email), String(contacts[0]!.phone), h.container.config.ADMIN_API_TOKEN, h.container.config.CREDENTIALS_ENCRYPTION_KEY,
      crmCred.accessToken, crmCred.refreshToken, metaCred.pageAccessToken, metaCred.appSecret,
    ]) {
      expect(raw.includes(secret), `mastra.db leaks ${secret.slice(0, 4)}…`).toBe(false);
    }
  });

  it('is a no-op when the job runs again for an already delivered lead', async () => {
    const { leadId } = await h.submitLead({ seed: 2 });
    await h.drain();
    const tenant = h.tenants['acme-roofing']!;
    const d = h.container.repos.deliveries.getByLead(tenant.id, 'meta_lead_ads', leadId)!;
    h.container.queue.enqueue('deliver_lead', { deliveryId: d.id, correlationId: d.correlationId }, { dedupeKey: `deliver:${d.id}` });
    await h.drain();
    expect(h.container.repos.attempts.forDelivery(d.id)).toHaveLength(1);
    expect(await h.contactsFor('acme-roofing', leadId)).toHaveLength(1);
  });
});
