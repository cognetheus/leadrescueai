import { registerApiRoute } from '@mastra/core/server';
import type { Hono } from 'hono';
import { getContainer } from '../../container';
import { createHealthApp } from '../../api/health';
import { createWebhookApp } from '../../api/webhooks';

/**
 * Application HTTP surfaces are plain Hono apps (testable without a Mastra server)
 * mounted onto the Mastra server here. Mastra's own auth is not used for them:
 * each app enforces its own authentication (HMAC for webhooks, admin token for ops).
 */
function mount(app: Hono, path: string, method: 'GET' | 'POST' | 'ALL') {
  return registerApiRoute(path, {
    method,
    requiresAuth: false,
    handler: (c) => app.fetch(c.req.raw),
  });
}

export function buildApiRoutes() {
  const health = createHealthApp(getContainer);
  const webhooks = createWebhookApp(() => getContainer().ingestion, () => getContainer().logger);
  return [
    mount(health, '/health/live', 'GET'),
    mount(health, '/health/ready', 'GET'),
    mount(webhooks, '/webhooks/meta/:tenantSlug', 'POST'),
  ];
}
