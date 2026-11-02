import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationError } from '../../src/integrations/errors';
import { MetaSourceClient } from '../../src/integrations/meta-source';
import { signMetaPayload } from '../../src/simulators/meta/app';
import { startSimulator, startWebhookSink } from '../support/simulator';

const SECRET_A = 'app-secret-tenant-a-0123456789';
const TOKEN_A = 'page-token-tenant-a-0123456789';
const TOKEN_B = 'page-token-tenant-b-0123456789';

describe('Meta Lead Ads simulator (P02.01)', () => {
  let sim: Awaited<ReturnType<typeof startSimulator>>;
  let sink: Awaited<ReturnType<typeof startWebhookSink>>;
  let client: MetaSourceClient;

  beforeAll(async () => {
    sim = await startSimulator();
    sink = await startWebhookSink();
    client = new MetaSourceClient(sim.url, 2_000);
    await sim.admin('POST', '/sim-admin/meta/pages', { pageId: 'page-a', name: 'A', appSecret: SECRET_A, pageAccessToken: TOKEN_A, webhookUrl: sink.url });
    await sim.admin('POST', '/sim-admin/meta/pages', { pageId: 'page-b', name: 'B', appSecret: 'app-secret-tenant-b-0123456789', pageAccessToken: TOKEN_B, webhookUrl: null });
  });
  afterAll(async () => {
    await sim.close();
    await sink.close();
  });

  const createLead = (fields: Record<string, string>, extra: Record<string, unknown> = {}) =>
    sim.admin('POST', '/sim-admin/meta/pages/page-a/leads', { fields, ...extra });

  it('delivers a signed, identifier-only webhook and serves the canonical lead', async () => {
    sink.received.length = 0;
    const { lead, webhook } = await createLead({ full_name: 'Dana Fox', email: 'dana@example.com' });
    expect(webhook.outcome).toBe('delivered');
    expect(sink.received).toHaveLength(1);
    const { body, signature } = sink.received[0]!;
    expect(signature).toBe(signMetaPayload(SECRET_A, body));
    const payload = JSON.parse(body);
    expect(payload.entry[0].changes[0].value).toMatchObject({ leadgen_id: lead.id, page_id: 'page-a' });
    expect(body).not.toContain('dana@example.com'); // contact data never travels in the webhook

    const canonical = (await client.getLead(TOKEN_A, lead.id)) as { field_data: unknown[] };
    expect(canonical.field_data).toEqual([{ name: 'full_name', values: ['Dana Fox'] }, { name: 'email', values: ['dana@example.com'] }]);
  });

  it('isolates tenants: another page token cannot read the lead', async () => {
    const { lead } = await createLead({ full_name: 'Iso Lated', email: 'iso@example.com' });
    await expect(client.getLead(TOKEN_B, lead.id)).rejects.toMatchObject({ details: { httpStatus: 404 } });
    await expect(client.getLead('bogus-token-xxxxxxxxxxxx', lead.id)).rejects.toMatchObject({ details: { httpStatus: 401 } });
    await expect(client.listLeads(TOKEN_B, 'page-a', { sinceMs: 0, limit: 10 })).rejects.toMatchObject({ details: { httpStatus: 403 } });
  });

  it('paginates with stable cursors even when many leads share a timestamp and new leads arrive mid-scan', async () => {
    const base = Date.parse('2025-06-01T00:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 57; i++) {
      // Groups of identical timestamps straddle page boundaries.
      const { lead } = await createLead({ full_name: `P ${i}`, email: `p${i}@example.com` }, { createdTime: new Date(base + Math.floor(i / 7) * 1000).toISOString(), id: String(9_000_000 + i) });
      ids.push(lead.id);
    }
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page = await client.listLeads(TOKEN_A, 'page-a', { sinceMs: base, limit: 10, after });
      seen.push(...page.leads.map((l) => l.id).filter((id) => ids.includes(id) || id.startsWith('late-')));
      after = page.nextCursor;
      if (++pages === 2) {
        await createLead({ full_name: 'Late Arrival', email: 'late@example.com' }, { createdTime: new Date(base + 999_000).toISOString(), id: '9999999' });
        ids.push('9999999');
      }
    } while (after);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates across pages
    expect(seen.sort()).toEqual([...ids].sort()); // nothing skipped, including the mid-scan arrival
  });

  it('drops or duplicates webhooks deterministically and records attribution', async () => {
    sink.received.length = 0;
    const drop = await sim.admin('POST', '/sim-admin/faults', { target: 'meta.webhook', scopeKey: 'page-a', effect: { type: 'drop' }, label: 'lost webhook' });
    const dropped = await createLead({ full_name: 'Lost Lead', email: 'lost@example.com' });
    expect(dropped.webhook).toMatchObject({ outcome: 'dropped', faultRuleId: drop.rule.id });
    expect(sink.received).toHaveLength(0);

    await sim.admin('POST', '/sim-admin/faults', { target: 'meta.webhook', scopeKey: 'page-a', effect: { type: 'duplicate', copies: 1 }, label: 'dup webhook' });
    await createLead({ full_name: 'Twice Sent', email: 'twice@example.com' });
    expect(sink.received).toHaveLength(2);
    expect(sink.received[0]!.body).toBe(sink.received[1]!.body);

    const events = await sim.admin('GET', '/sim-admin/fault-events');
    expect(events.events.map((e: { label: string }) => e.label)).toEqual(expect.arrayContaining(['lost webhook', 'dup webhook']));
  });

  it('surfaces injected source failures as typed integration errors', async () => {
    const { lead } = await createLead({ full_name: 'Flaky Read', email: 'flaky@example.com' });
    await sim.admin('POST', '/sim-admin/faults', { target: 'meta.get_lead', matchKey: lead.id, effect: { type: 'http_error', status: 503, retryAfterSec: 2 }, label: 'source 503' });
    const err = await client.getLead(TOKEN_A, lead.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err).toMatchObject({ kind: 'http', details: { httpStatus: 503, retryAfterMs: 2_000 } });
    await expect(client.getLead(TOKEN_A, lead.id)).resolves.toBeTruthy(); // one-shot fault consumed
  });
});
