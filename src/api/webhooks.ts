import { Hono } from 'hono';
import type { WebhookIngestionService } from '../services/ingestion';
import { MAX_WEBHOOK_BYTES } from '../services/ingestion';
import type { AppLogger } from '../shared/logger';

/** Public, HMAC-authenticated webhook endpoint. */
export function createWebhookApp(getService: () => WebhookIngestionService, logger: () => AppLogger): Hono {
  const app = new Hono();
  app.post('/webhooks/meta/:tenantSlug', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_WEBHOOK_BYTES) return c.json({ error: 'payload too large' }, 413);
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    try {
      const result = getService().ingestMeta({
        tenantSlug: c.req.param('tenantSlug'),
        rawBody,
        signature: c.req.header('x-hub-signature-256'),
      });
      return c.json(result.body, result.status);
    } catch (err) {
      // Nothing was acknowledged: the sender must retry.
      logger().error('Webhook ingestion failed before commit', { error: (err as Error).message });
      return c.json({ error: 'temporarily unavailable' }, 503);
    }
  });
  return app;
}
