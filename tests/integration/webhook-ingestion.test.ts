import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebhookApp } from '../../src/api/webhooks';
import { createContainer, type Container } from '../../src/container';
import { SimulatorAdminClient } from '../../src/simulators/admin-client';
import { generateLead, TENANT_FIXTURES } from '../../src/simulators/fixtures';
import { provisionTenant } from '../../src/services/provisioning';
import { silentLogger } from '../../src/shared/logger';
import { testConfig } from '../support/config';
import { startServer } from '../support/http-server';
import { SIM_ADMIN, startSimulator } from '../support/simulator';

const [acme, summit] = TENANT_FIXTURES;

describe('webhook ingestion (P03.01)', () => {
  let sim: Awaited<ReturnType<typeof startSimulator>>;
  let appServer: Awaited<ReturnType<typeof startServer>>;
  let container: Container;
  let admin: SimulatorAdminClient;
  let secretA: string;
  let secretB: string;
  const config = testConfig();

  beforeAll(async () => {
    sim = await startSimulator();
    container = createContainer({ config: { ...config }, logger: silentLogger });
    appServer = await startServer(createWebhookApp(() => container.ingestion, () => silentLogger));
    container.config.APP_PUBLIC_URL = appServer.url;
    admin = new SimulatorAdminClient(sim.url, SIM_ADMIN);
    const a = await provisionTenant(container, admin, acme);
    const b = await provisionTenant(container, admin, summit);
    secretA = container.repos.credentials.get(a.id, 'meta')!.secrets.appSecret;
    secretB = container.repos.credentials.get(b.id, 'meta')!.secrets.appSecret;
  });
  afterAll(async () => {
    await sim.close();
    await appServer.close();
    container.db.close();
    config.cleanup();
  });

  const envelope = (pageId: string, leadIds: string[]) =>
    JSON.stringify({ object: 'page', entry: [{ id: pageId, time: 1, changes: leadIds.map((id) => ({ field: 'leadgen', value: { leadgen_id: id, page_id: pageId } })) }] });
  const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const post = (slug: string, body: string, signature?: string) =>
    fetch(`${appServer.url}/webhooks/meta/${slug}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) } });
  const countRows = (table: string) => (container.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  it('accepts a signed webhook only after event, delivery and job are committed', async () => {
    const body = envelope(acme.metaPageId, ['5001']);
    const res = await post(acme.slug, body, sign(secretA, body));
    const json = (await res.json()) as { accepted: number; correlationId: string };
    expect(res.status).toBe(200);
    expect(json.accepted).toBe(1);
    const tenant = container.repos.tenants.getBySlug(acme.slug)!;
    const delivery = container.repos.deliveries.getByLead(tenant.id, 'meta_lead_ads', '5001')!;
    expect(delivery).toMatchObject({ status: 'pending', trigger: 'webhook', correlationId: json.correlationId });
    expect(container.queue.liveByDedupeKey(`deliver:${delivery.id}`)).toMatchObject({ status: 'queued', kind: 'deliver_lead' });
    expect(container.repos.audit.forEntity('delivery', delivery.id).map((a) => a.action)).toEqual(['delivery.accepted']);
  });

  it('turns duplicate webhooks into one delivery and one job', async () => {
    const body = envelope(acme.metaPageId, ['5002', '5002']);
    const first = (await (await post(acme.slug, body, sign(secretA, body))).json()) as { accepted: number; duplicates: number };
    const second = (await (await post(acme.slug, body, sign(secretA, body))).json()) as { accepted: number; duplicates: number };
    expect(first).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(second).toMatchObject({ accepted: 0, duplicates: 1 });
    const tenant = container.repos.tenants.getBySlug(acme.slug)!;
    const d = container.repos.deliveries.getByLead(tenant.id, 'meta_lead_ads', '5002')!;
    expect(container.queue.list().filter((j) => j.dedupeKey === `deliver:${d.id}`)).toHaveLength(1);
  });

  it('rejects missing, malformed, tampered and cross-tenant signatures without persisting the payload', async () => {
    const before = { events: countRows('webhook_events'), deliveries: countRows('deliveries') };
    const body = envelope(acme.metaPageId, ['6001']);
    const cases = [
      await post(acme.slug, body),
      await post(acme.slug, body, 'sha1=deadbeef'),
      await post(acme.slug, body, sign(secretA, body).replace(/.$/, '0')),
      await post(acme.slug, body.replace('6001', '6002'), sign(secretA, body)),
      await post(acme.slug, body, sign(secretB, body)), // signed by another tenant's secret
    ];
    expect(cases.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect({ events: countRows('webhook_events'), deliveries: countRows('deliveries') }).toEqual(before);
    const tenant = container.repos.tenants.getBySlug(acme.slug)!;
    expect(container.repos.audit.forEntity('tenant', tenant.id).filter((a) => a.action === 'webhook.signature_rejected')).toHaveLength(5);
  });

  it('rejects unknown tenants, foreign pages, bad JSON and oversized bodies', async () => {
    const body = envelope(acme.metaPageId, ['7001']);
    expect((await post('nope', body, sign(secretA, body))).status).toBe(404);
    const foreign = envelope(summit.metaPageId, ['7002']);
    expect((await post(acme.slug, foreign, sign(secretA, foreign))).status).toBe(422);
    const bad = '{"object":';
    expect((await post(acme.slug, bad, sign(secretA, bad))).status).toBe(400);
    const huge = JSON.stringify({ object: 'page', entry: [{ id: acme.metaPageId, changes: [], pad: 'x'.repeat(300_000) }] });
    expect((await post(acme.slug, huge, sign(secretA, huge))).status).toBe(413);
  });

  it('never acknowledges when the commit fails, so the platform retries', async () => {
    const broken = createContainer({ config: { ...config, DATA_DIR: config.dataDir }, logger: silentLogger });
    const server = await startServer(createWebhookApp(() => broken.ingestion, () => silentLogger));
    broken.db.exec('DROP TRIGGER IF EXISTS fail_insert; CREATE TRIGGER fail_insert BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, \'disk full\'); END;');
    const body = envelope(acme.metaPageId, ['8001']);
    const res = await fetch(`${server.url}/webhooks/meta/${acme.slug}`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(secretA, body) } });
    expect(res.status).toBe(503);
    // The whole transaction rolled back: no orphan event row either.
    expect((broken.db.prepare("SELECT count(*) AS n FROM webhook_events WHERE payload_json LIKE '%8001%'").get() as { n: number }).n).toBe(0);
    broken.db.exec('DROP TRIGGER fail_insert');
    await server.close();
  });

  it('end to end: a simulator lead produces a signed webhook that is accepted', async () => {
    const lead = generateLead(11, acme);
    const { webhook } = await admin.createLead(acme.metaPageId, lead);
    expect(webhook.outcome).toBe('delivered');
    const tenant = container.repos.tenants.getBySlug(acme.slug)!;
    expect(container.repos.deliveries.getByLead(tenant.id, 'meta_lead_ads', lead.id)?.status).toBe('pending');
  });
});
