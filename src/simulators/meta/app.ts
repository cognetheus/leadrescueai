import { createHmac, randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { fetchWithTimeout } from '../../shared/http';
import { sleep } from '../faults/engine';
import { bearer, faultHttpResponse, requireAdmin, safeEqual, type SimulatorDeps } from '../shared';

interface PageRow { page_id: string; name: string; app_secret: string; page_access_token: string; webhook_url: string | null }
interface LeadRow { id: string; page_id: string; form_id: string; created_time: number; field_data: string }

export interface GraphLead {
  id: string;
  created_time: string;
  form_id: string;
  page_id: string;
  field_data: Array<{ name: string; values: string[] }>;
}

const toGraph = (r: LeadRow): GraphLead => ({
  id: r.id,
  created_time: new Date(r.created_time).toISOString(),
  form_id: r.form_id,
  page_id: r.page_id,
  field_data: JSON.parse(r.field_data) as GraphLead['field_data'],
});

const graphError = (message: string, code: number) => ({ error: { message, type: 'OAuthException', code } });

export function signMetaPayload(appSecret: string, body: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;
}

const encodeCursor = (t: number, id: string) => Buffer.from(JSON.stringify([t, id])).toString('base64url');
function decodeCursor(cursor: string): [number, string] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'string' ? [v[0], v[1]] : null;
  } catch {
    return null;
  }
}

const CreateLeadSchema = z.object({
  formId: z.string().min(1).default('form-default'),
  fields: z.record(z.string(), z.string()),
  /** Backdating supports reconciliation lookback tests (late-arriving source records). */
  createdTime: z.string().datetime().optional(),
  id: z.string().regex(/^[0-9]{6,20}$/).optional(),
});

/**
 * Meta Lead Ads simulator (Graph-API-shaped).
 *
 * - Webhooks carry only identifiers and are HMAC-SHA256 signed with the app secret
 *   (`X-Hub-Signature-256`), so receivers must fetch the canonical lead.
 * - Listing uses stable keyset cursors over (created_time, id), so pages never skip or
 *   repeat leads that share a timestamp.
 */
export function createMetaApp(deps: SimulatorDeps): Hono {
  const { db, faults, now } = deps;
  const app = new Hono();
  const admin = requireAdmin(deps.adminToken);

  const pageByToken = (token: string | null): PageRow | undefined => {
    if (!token) return undefined;
    const page = db.prepare('SELECT * FROM meta_pages WHERE page_access_token = ?').get(token) as PageRow | undefined;
    return page && safeEqual(page.page_access_token, token) ? page : undefined;
  };
  const tokenFrom = (c: Parameters<typeof bearer>[0]) => c.req.query('access_token') ?? bearer(c);

  app.post('/sim-admin/meta/pages', admin, async (c) => {
    const body = z
      .object({ pageId: z.string().min(1), name: z.string().min(1), appSecret: z.string().min(16), pageAccessToken: z.string().min(16), webhookUrl: z.string().url().nullable() })
      .parse(await c.req.json());
    db.prepare(
      `INSERT INTO meta_pages (page_id, name, app_secret, page_access_token, webhook_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (page_id) DO UPDATE SET name = excluded.name, app_secret = excluded.app_secret,
         page_access_token = excluded.page_access_token, webhook_url = excluded.webhook_url`,
    ).run(body.pageId, body.name, body.appSecret, body.pageAccessToken, body.webhookUrl, now());
    return c.json({ pageId: body.pageId }, 201);
  });

  /** Simulates a consumer submitting a lead form; the platform then notifies subscribers. */
  app.post('/sim-admin/meta/pages/:pageId/leads', admin, async (c) => {
    const page = db.prepare('SELECT * FROM meta_pages WHERE page_id = ?').get(c.req.param('pageId')) as PageRow | undefined;
    if (!page) return c.json({ error: 'unknown page' }, 404);
    const body = CreateLeadSchema.parse(await c.req.json());
    const id = body.id ?? `${now()}${randomInt(100000, 999999)}`;
    const createdTime = body.createdTime ? Date.parse(body.createdTime) : now();
    const fieldData = Object.entries(body.fields).map(([name, value]) => ({ name, values: [value] }));
    db.prepare('INSERT INTO meta_leads (id, page_id, form_id, created_time, field_data, inserted_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, page.page_id, body.formId, createdTime, JSON.stringify(fieldData), now());
    const lead = db.prepare('SELECT * FROM meta_leads WHERE id = ?').get(id) as LeadRow;
    const webhook = await dispatchWebhook(deps, page, lead);
    return c.json({ lead: toGraph(lead), webhook }, 201);
  });

  /** Re-sends the webhook for an existing lead (platform retry / duplicate delivery). */
  app.post('/sim-admin/meta/leads/:leadId/redeliver', admin, async (c) => {
    const lead = db.prepare('SELECT * FROM meta_leads WHERE id = ?').get(c.req.param('leadId')) as LeadRow | undefined;
    if (!lead) return c.json({ error: 'unknown lead' }, 404);
    const page = db.prepare('SELECT * FROM meta_pages WHERE page_id = ?').get(lead.page_id) as PageRow;
    return c.json({ webhook: await dispatchWebhook(deps, page, lead) });
  });

  app.get('/sim-admin/meta/webhook-deliveries', admin, (c) =>
    c.json({ deliveries: db.prepare('SELECT * FROM meta_webhook_deliveries ORDER BY id DESC LIMIT 200').all() }),
  );

  app.get('/sim-admin/meta/pages/:pageId/leads', admin, (c) => {
    const rows = db.prepare('SELECT * FROM meta_leads WHERE page_id = ? ORDER BY created_time, id').all(c.req.param('pageId')) as LeadRow[];
    return c.json({ leads: rows.map(toGraph) });
  });

  // ---- Graph-style public API (page access token) ----

  app.get('/meta/v1/leads/:leadId', async (c) => {
    const page = pageByToken(tokenFrom(c));
    if (!page) return c.json(graphError('Invalid OAuth access token.', 190), 401);
    const leadId = c.req.param('leadId');
    const fault = faults.fire('meta.get_lead', page.page_id, leadId);
    if (fault?.effect.type === 'http_error') return faultHttpResponse(c, fault, graphError(`Simulated failure (${fault.label})`, 2));
    if (fault?.effect.type === 'delay') await sleep(fault.effect.ms);
    const row = db.prepare('SELECT * FROM meta_leads WHERE id = ? AND page_id = ?').get(leadId, page.page_id) as LeadRow | undefined;
    // Leads of other pages are indistinguishable from nonexistent ones (tenant isolation).
    if (!row) return c.json(graphError(`Unsupported get request. Object with ID '${leadId}' does not exist.`, 100), 404);
    const lead = toGraph(row);
    if (fault?.effect.type === 'omit_fields') {
      const omit = new Set(fault.effect.fields);
      lead.field_data = lead.field_data.filter((f) => !omit.has(f.name));
    }
    return c.json(lead);
  });

  app.get('/meta/v1/:pageId/leads', async (c) => {
    const page = pageByToken(tokenFrom(c));
    if (!page) return c.json(graphError('Invalid OAuth access token.', 190), 401);
    if (page.page_id !== c.req.param('pageId')) return c.json(graphError('Permissions error', 200), 403);
    const fault = faults.fire('meta.list_leads', page.page_id, null);
    if (fault?.effect.type === 'http_error') return faultHttpResponse(c, fault, graphError(`Simulated failure (${fault.label})`, 2));
    if (fault?.effect.type === 'delay') await sleep(fault.effect.ms);

    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 25) || 25, 1), 100);
    const sinceMs = c.req.query('since') ? Number(c.req.query('since')) * 1000 : 0;
    const untilMs = c.req.query('until') ? Number(c.req.query('until')) * 1000 : Number.MAX_SAFE_INTEGER;
    const after = c.req.query('after');
    const cursor = after ? decodeCursor(after) : null;
    if (after && !cursor) return c.json(graphError('Invalid cursor', 100), 400);
    const rows = db
      .prepare(
        `SELECT * FROM meta_leads WHERE page_id = ? AND created_time >= ? AND created_time <= ?
           AND (created_time, id) > (?, ?) ORDER BY created_time, id LIMIT ?`,
      )
      .all(page.page_id, sinceMs, untilMs, cursor?.[0] ?? -1, cursor?.[1] ?? '', limit + 1) as LeadRow[];
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    const hasMore = rows.length > limit;
    const nextCursor = last ? encodeCursor(last.created_time, last.id) : null;
    const nextUrl = new URL(`/meta/v1/${page.page_id}/leads`, deps.baseUrl);
    if (hasMore && nextCursor) {
      nextUrl.searchParams.set('limit', String(limit));
      if (c.req.query('since')) nextUrl.searchParams.set('since', c.req.query('since')!);
      if (c.req.query('until')) nextUrl.searchParams.set('until', c.req.query('until')!);
      nextUrl.searchParams.set('after', nextCursor);
    }
    return c.json({
      data: pageRows.map(toGraph),
      paging: { cursors: { after: nextCursor }, ...(hasMore ? { next: nextUrl.toString() } : {}) },
    });
  });

  return app;
}

/** Delivers the leadgen notification with bounded retries, honoring webhook faults. */
async function dispatchWebhook(deps: SimulatorDeps, page: PageRow, lead: LeadRow) {
  const log = (outcome: string, httpStatus: number | null, ruleId: string | null, error: string | null) =>
    deps.db
      .prepare('INSERT INTO meta_webhook_deliveries (page_id, lead_id, outcome, http_status, fault_rule_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(page.page_id, lead.id, outcome, httpStatus, ruleId, error, deps.now());

  if (!page.webhook_url) {
    log('no_subscription', null, null, null);
    return { outcome: 'no_subscription' as const, sent: 0 };
  }
  const fault = deps.faults.fire('meta.webhook', page.page_id, lead.id);
  if (fault?.effect.type === 'drop') {
    log('dropped', null, fault.ruleId, null);
    return { outcome: 'dropped' as const, sent: 0, faultRuleId: fault.ruleId };
  }
  if (fault?.effect.type === 'delay') await sleep(fault.effect.ms);
  const copies = fault?.effect.type === 'duplicate' ? 1 + fault.effect.copies : 1;

  const body = JSON.stringify({
    object: 'page',
    entry: [{
      id: page.page_id,
      time: Math.floor(deps.now() / 1000),
      changes: [{ field: 'leadgen', value: { leadgen_id: lead.id, page_id: page.page_id, form_id: lead.form_id, created_time: Math.floor(lead.created_time / 1000) } }],
    }],
  });
  const signature = signMetaPayload(page.app_secret, body);
  let delivered = 0;
  for (let copy = 0; copy < copies; copy++) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchWithTimeout(page.webhook_url, {
          method: 'POST', timeoutMs: deps.webhookTimeoutMs, body,
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        });
        log(copy > 0 ? 'duplicate_sent' : res.ok ? 'delivered' : 'rejected', res.status, fault?.ruleId ?? null, null);
        if (res.ok) { delivered++; break; }
        if (res.status < 500) break; // receiver rejected the payload; retrying will not help
      } catch (err) {
        log('error', null, fault?.ruleId ?? null, (err as Error).message);
      }
      await sleep(100 * attempt);
    }
  }
  return { outcome: delivered ? ('delivered' as const) : ('failed' as const), sent: delivered, ...(fault ? { faultRuleId: fault.ruleId } : {}) };
}
