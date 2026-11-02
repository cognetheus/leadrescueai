import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection';
import type { Repositories } from '../db/repositories';
import type { JobQueue } from '../jobs/queue';
import type { Clock } from '../shared/clock';
import { newId } from '../shared/ids';
import type { AppLogger } from '../shared/logger';

export const MAX_WEBHOOK_BYTES = 256 * 1024;

const LeadgenChange = z.object({
  field: z.literal('leadgen'),
  value: z.object({
    leadgen_id: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
    page_id: z.string().min(1),
    form_id: z.string().optional(),
    created_time: z.number().optional(),
  }),
});
const MetaEnvelope = z.object({
  object: z.literal('page'),
  entry: z
    .array(z.object({ id: z.string().min(1), time: z.number().optional(), changes: z.array(z.object({ field: z.string() }).passthrough()).max(100) }))
    .min(1)
    .max(50),
});

export type IngestionResult =
  | { status: 200; body: { eventId: string; correlationId: string; accepted: number; duplicates: number; ignored: number } }
  | { status: 400 | 401 | 404 | 413 | 422; body: { error: string } };

export interface IngestionDeps {
  db: AppDatabase;
  repos: Repositories;
  queue: JobQueue;
  clock: Clock;
  logger: AppLogger;
  deliveryDeadlineMs: number;
  /** Called after commit so idle workers can start immediately. */
  onEnqueued?: () => void;
}

/** Constant-time check of Meta's `X-Hub-Signature-256: sha256=<hex>` over the exact raw body. */
export function verifyMetaSignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const provided = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Webhook acceptance. The response is produced only after the event, the deliveries
 * and their jobs are durably committed together; a crash before commit yields a non-2xx
 * response, so the platform retries instead of the lead being silently lost.
 */
export class WebhookIngestionService {
  constructor(private deps: IngestionDeps) {}

  ingestMeta(input: { tenantSlug: string; rawBody: Buffer; signature: string | undefined }): IngestionResult {
    const { repos, clock, logger } = this.deps;
    if (input.rawBody.length > MAX_WEBHOOK_BYTES) return { status: 413, body: { error: 'payload too large' } };
    const tenant = repos.tenants.getBySlug(input.tenantSlug);
    if (!tenant || tenant.status !== 'active') return { status: 404, body: { error: 'unknown tenant' } };
    const meta = repos.credentials.get(tenant.id, 'meta');
    const bodyHash = createHash('sha256').update(input.rawBody).digest('hex');

    if (!meta || !verifyMetaSignature(meta.secrets.appSecret, input.rawBody, input.signature)) {
      // Unauthenticated payloads are not stored; only the fact of rejection is audited.
      repos.audit.record({
        tenantId: tenant.id, actor: 'webhook', action: 'webhook.signature_rejected', entityType: 'tenant', entityId: tenant.id,
        data: { bodySha256: bodyHash, bytes: input.rawBody.length, signaturePresent: Boolean(input.signature) },
      });
      logger.warn('Rejected webhook with invalid signature', { tenantId: tenant.id });
      return { status: 401, body: { error: 'invalid signature' } };
    }

    let json: unknown;
    try {
      json = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'invalid JSON' } };
    }
    const envelope = MetaEnvelope.safeParse(json);
    if (!envelope.success) return { status: 422, body: { error: 'invalid webhook envelope' } };
    if (envelope.data.entry.some((e) => e.id !== tenant.metaPageId)) {
      repos.audit.record({ tenantId: tenant.id, actor: 'webhook', action: 'webhook.page_mismatch', entityType: 'tenant', entityId: tenant.id, data: { bodySha256: bodyHash } });
      return { status: 422, body: { error: 'page does not belong to tenant' } };
    }

    const leadIds: string[] = [];
    let ignored = 0;
    for (const entry of envelope.data.entry) {
      for (const change of entry.changes) {
        const parsed = LeadgenChange.safeParse(change);
        if (parsed.success && parsed.data.value.page_id === tenant.metaPageId) leadIds.push(parsed.data.value.leadgen_id);
        else ignored++;
      }
    }

    const now = clock.now();
    const eventId = newId('evt', now);
    const correlationId = newId('cor', now);
    let accepted = 0;
    let duplicates = 0;
    this.deps.db.transaction(() => {
      repos.webhookEvents.insert({
        id: eventId, tenantId: tenant.id, source: 'meta_lead_ads', bodySha256: bodyHash, payload: json, leadCount: leadIds.length,
        newDeliveries: 0, duplicates: 0, correlationId, receivedAt: now,
      });
      for (const leadId of new Set(leadIds)) {
        const { delivery, created } = repos.deliveries.insertIfAbsent({
          tenantId: tenant.id, source: 'meta_lead_ads', sourceLeadId: leadId, trigger: 'webhook',
          firstEventId: eventId, correlationId, deadlineMs: this.deps.deliveryDeadlineMs,
        });
        if (created) {
          accepted++;
          const { job } = this.deps.queue.enqueue('deliver_lead', { deliveryId: delivery.id, correlationId }, { dedupeKey: `deliver:${delivery.id}`, tenantId: tenant.id });
          repos.audit.record({
            tenantId: tenant.id, actor: 'webhook', action: 'delivery.accepted', entityType: 'delivery', entityId: delivery.id, correlationId,
            data: { sourceLeadId: leadId, eventId, jobId: job.id },
          });
        } else {
          duplicates++;
          repos.audit.record({
            tenantId: tenant.id, actor: 'webhook', action: 'webhook.duplicate_lead', entityType: 'delivery', entityId: delivery.id, correlationId,
            data: { sourceLeadId: leadId, eventId, existingStatus: delivery.status },
          });
        }
      }
      repos.webhookEvents.updateCounts(eventId, accepted, duplicates);
    }).immediate();

    logger.info('Webhook accepted', { tenantId: tenant.id, correlationId, eventId, accepted, duplicates });
    if (accepted) this.deps.onEnqueued?.();
    return { status: 200, body: { eventId, correlationId, accepted, duplicates, ignored } };
  }
}
