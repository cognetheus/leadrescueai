import { randomBytes, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { sleep, type FiredFault } from '../faults/engine';
import { bearer, faultHttpResponse, requireAdmin, safeEqual, type SimulatorDeps } from '../shared';

interface ContactRow {
  id: string; location_id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null;
  postal_code: string | null; source: string | null; external_source_id: string | null; tags: string; custom_fields: string;
  created_at: number; updated_at: number;
}

export interface CrmContact {
  id: string;
  locationId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  postalCode: string | null;
  source: string | null;
  externalSourceId: string | null;
  tags: string[];
  customFields: Record<string, string>;
  dateAdded: string;
}

const toContact = (r: ContactRow): CrmContact => ({
  id: r.id, locationId: r.location_id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone,
  postalCode: r.postal_code, source: r.source, externalSourceId: r.external_source_id,
  tags: JSON.parse(r.tags) as string[], customFields: JSON.parse(r.custom_fields) as Record<string, string>,
  dateAdded: new Date(r.created_at).toISOString(),
});

const CreateContactSchema = z.object({
  locationId: z.string().min(1),
  firstName: z.string().min(1).max(200),
  lastName: z.string().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().regex(/^\+[0-9]{8,15}$/).nullable().optional(),
  postalCode: z.string().max(12).nullable().optional(),
  source: z.string().max(100).optional(),
  externalSourceId: z.string().min(1).max(100),
  tags: z.array(z.string().max(50)).max(20).default([]),
  customFields: z.record(z.string(), z.string().max(500)).default({}),
}).refine((c) => c.email || c.phone, { message: 'email or phone is required' });

const token = (prefix: string) => `${prefix}_${randomBytes(18).toString('base64url')}`;

/**
 * GoHighLevel-style CRM simulator.
 *
 * - Access tokens are scoped to one location (tenant) and expire.
 * - Refresh tokens rotate on every use; replaying a used refresh token is treated as
 *   theft and revokes the whole token family (OAuth 2.0 BCP refresh-token rotation).
 * - Contacts are NOT unique by external id, as in real CRMs: callers must search first.
 */
export function createCrmApp(deps: SimulatorDeps): Hono {
  const { db, faults, now } = deps;
  const app = new Hono();
  const admin = requireAdmin(deps.adminToken);

  const issueTokens = (locationId: string, familyId: string, ttlSec: number) => {
    const accessToken = token('at');
    const refreshToken = token('rt');
    db.prepare('INSERT INTO crm_access_tokens (token, location_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(accessToken, locationId, now() + ttlSec * 1000, now());
    db.prepare("INSERT INTO crm_refresh_tokens (token, location_id, family_id, status, created_at) VALUES (?, ?, ?, 'active', ?)").run(refreshToken, locationId, familyId, now());
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: ttlSec, token_type: 'Bearer', locationId };
  };

  /** Resolves the caller's location from its bearer token, or returns an error response. */
  const authenticate = (c: Context, locationId: string | undefined): Response | string => {
    const presented = bearer(c);
    if (!presented) return c.json({ statusCode: 401, error: 'invalid_token', message: 'Missing bearer token' }, 401);
    const row = db.prepare('SELECT * FROM crm_access_tokens WHERE token = ?').get(presented) as { token: string; location_id: string; expires_at: number } | undefined;
    if (!row || !safeEqual(row.token, presented)) return c.json({ statusCode: 401, error: 'invalid_token', message: 'Invalid access token' }, 401);
    if (row.expires_at <= now()) return c.json({ statusCode: 401, error: 'token_expired', message: 'Access token has expired' }, 401);
    if (locationId && locationId !== row.location_id) return c.json({ statusCode: 403, error: 'forbidden', message: 'Token is not authorized for this location' }, 403);
    return row.location_id;
  };

  const failFast = (c: Context, fault: FiredFault | null) =>
    fault?.effect.type === 'http_error'
      ? faultHttpResponse(c, fault, { statusCode: fault.effect.status, error: 'simulated_fault', message: `Simulated failure (${fault.label})` })
      : null;

  // ---- Admin: provisioning and inspection ----

  app.post('/sim-admin/crm/locations', admin, async (c) => {
    const body = z
      .object({ locationId: z.string().min(1), name: z.string().min(1), clientId: z.string().min(8), clientSecret: z.string().min(16), accessTokenTtlSec: z.number().int().min(1).default(3600) })
      .parse(await c.req.json());
    db.prepare(
      `INSERT INTO crm_locations (location_id, name, client_id, client_secret, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (location_id) DO UPDATE SET name = excluded.name, client_id = excluded.client_id, client_secret = excluded.client_secret`,
    ).run(body.locationId, body.name, body.clientId, body.clientSecret, now());
    // Simulates the OAuth installation flow: the first token pair for a fresh token family.
    return c.json(issueTokens(body.locationId, randomUUID(), body.accessTokenTtlSec), 201);
  });

  app.post('/sim-admin/crm/locations/:locationId/expire-access-tokens', admin, (c) => {
    const n = db.prepare('UPDATE crm_access_tokens SET expires_at = ? WHERE location_id = ? AND expires_at > ?').run(now() - 1, c.req.param('locationId'), now()).changes;
    return c.json({ expired: n });
  });

  app.post('/sim-admin/crm/locations/:locationId/revoke-refresh-tokens', admin, (c) => {
    const n = db.prepare("UPDATE crm_refresh_tokens SET status = 'revoked' WHERE location_id = ? AND status = 'active'").run(c.req.param('locationId')).changes;
    return c.json({ revoked: n });
  });

  app.get('/sim-admin/crm/contacts', admin, (c) => {
    const locationId = c.req.query('locationId');
    const rows = (locationId
      ? db.prepare('SELECT * FROM crm_contacts WHERE location_id = ? ORDER BY created_at, id').all(locationId)
      : db.prepare('SELECT * FROM crm_contacts ORDER BY created_at, id').all()) as ContactRow[];
    return c.json({ contacts: rows.map(toContact) });
  });

  /** Duplicate report: more than one contact per (location, external source id). */
  app.get('/sim-admin/crm/duplicates', admin, (c) =>
    c.json({
      duplicates: db
        .prepare('SELECT location_id AS locationId, external_source_id AS externalSourceId, count(*) AS count FROM crm_contacts WHERE external_source_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1')
        .all(),
    }),
  );

  // ---- OAuth ----

  app.post('/crm/oauth/token', async (c) => {
    const raw = c.req.header('content-type')?.includes('application/json') ? await c.req.json() : Object.fromEntries(new URLSearchParams(await c.req.text()));
    const parsed = z.object({ grant_type: z.literal('refresh_token'), client_id: z.string(), client_secret: z.string(), refresh_token: z.string() }).safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const body = parsed.data;
    const loc = db.prepare('SELECT * FROM crm_locations WHERE client_id = ?').get(body.client_id) as { location_id: string; client_secret: string } | undefined;
    if (!loc || !safeEqual(loc.client_secret, body.client_secret)) return c.json({ error: 'invalid_client' }, 401);
    const fault = faults.fire('crm.token', loc.location_id, null);
    const early = failFast(c, fault);
    if (early) return early;
    if (fault?.effect.type === 'delay') await sleep(fault.effect.ms);

    return db.transaction(() => {
      const rt = db.prepare('SELECT * FROM crm_refresh_tokens WHERE token = ? AND location_id = ?').get(body.refresh_token, loc.location_id) as
        | { token: string; family_id: string; status: 'active' | 'used' | 'revoked' }
        | undefined;
      if (!rt) return c.json({ error: 'invalid_grant', error_description: 'Unknown refresh token' }, 400);
      if (rt.status === 'used') {
        // Replay of a rotated token: assume compromise and revoke the entire family.
        db.prepare("UPDATE crm_refresh_tokens SET status = 'revoked' WHERE family_id = ?").run(rt.family_id);
        db.prepare('DELETE FROM crm_access_tokens WHERE location_id = ?').run(loc.location_id);
        return c.json({ error: 'invalid_grant', error_description: 'Refresh token reuse detected; grant revoked' }, 400);
      }
      if (rt.status === 'revoked') return c.json({ error: 'invalid_grant', error_description: 'Refresh token has been revoked' }, 400);
      db.prepare("UPDATE crm_refresh_tokens SET status = 'used' WHERE token = ?").run(rt.token);
      return c.json(issueTokens(loc.location_id, rt.family_id, 3600));
    }).immediate();
  });

  // ---- Contacts API ----

  app.get('/crm/v1/contacts', async (c) => {
    const locationId = c.req.query('locationId');
    if (!locationId) return c.json({ statusCode: 422, message: 'locationId is required' }, 422);
    const auth = authenticate(c, locationId);
    if (typeof auth !== 'string') return auth;
    const externalSourceId = c.req.query('externalSourceId') ?? null;
    const fault = faults.fire('crm.search_contacts', locationId, externalSourceId);
    const early = failFast(c, fault);
    if (early) return early;
    if (fault?.effect.type === 'delay') await sleep(fault.effect.ms);
    const rows = (externalSourceId
      ? db.prepare('SELECT * FROM crm_contacts WHERE location_id = ? AND external_source_id = ? ORDER BY created_at, id').all(locationId, externalSourceId)
      : db.prepare('SELECT * FROM crm_contacts WHERE location_id = ? ORDER BY created_at DESC, id LIMIT 100').all(locationId)) as ContactRow[];
    return c.json({ contacts: rows.map(toContact), total: rows.length });
  });

  app.post('/crm/v1/contacts', async (c) => {
    const json = (await c.req.json()) as { locationId?: string; externalSourceId?: string };
    const auth = authenticate(c, json.locationId);
    if (typeof auth !== 'string') return auth;
    const parsed = CreateContactSchema.safeParse(json);
    if (!parsed.success) return c.json({ statusCode: 422, message: 'Validation failed', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 422);
    const body = parsed.data;
    const fault = faults.fire('crm.create_contact', body.locationId, body.externalSourceId);
    const early = failFast(c, fault);
    if (early) return early;
    if (fault?.effect.type === 'delay') await sleep(fault.effect.ms);

    const id = `ct_${randomBytes(9).toString('hex')}`;
    db.prepare(
      `INSERT INTO crm_contacts (id, location_id, first_name, last_name, email, phone, postal_code, source, external_source_id, tags, custom_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, body.locationId, body.firstName, body.lastName ?? null, body.email ?? null, body.phone ?? null, body.postalCode ?? null,
      body.source ?? null, body.externalSourceId, JSON.stringify(body.tags), JSON.stringify(body.customFields), now(), now());
    const contact = toContact(db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(id) as ContactRow);

    if (fault?.effect.type === 'timeout_after_commit') {
      // The contact now exists, but the caller will never see this response in time.
      await sleep(fault.effect.delayMs);
      return c.json({ statusCode: 504, message: 'Gateway timeout' }, 504);
    }
    return c.json({ contact }, 201);
  });

  app.get('/crm/v1/contacts/:id', async (c) => {
    const row = db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(c.req.param('id')) as ContactRow | undefined;
    const auth = authenticate(c, undefined);
    if (typeof auth !== 'string') return auth;
    // Contacts of other locations are reported as not found (no cross-tenant existence leak).
    if (!row || row.location_id !== auth) return c.json({ statusCode: 404, message: 'Contact not found' }, 404);
    const fault = faults.fire('crm.get_contact', auth, row.external_source_id);
    const early = failFast(c, fault);
    if (early) return early;
    if (fault?.effect.type === 'delay') await sleep(fault.effect.ms);
    const contact = toContact(row);
    if (fault?.effect.type === 'mutate_field' && fault.effect.field in contact) {
      (contact as unknown as Record<string, unknown>)[fault.effect.field] = fault.effect.value;
    }
    return c.json({ contact });
  });

  return app;
}
