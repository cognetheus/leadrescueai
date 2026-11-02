import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { AppDatabase } from '../db/connection';
import { FaultEngine } from './faults/engine';
import { createCrmApp } from './crm/app';
import { createFaultAdminApp } from './faults/admin-app';
import { createMetaApp } from './meta/app';
import type { SimulatorDeps } from './shared';

export interface SimulatorOptions {
  db: AppDatabase;
  adminToken: string;
  baseUrl: string;
  now?: () => number;
  webhookTimeoutMs?: number;
  allowReset?: boolean;
}

export function createSimulatorApp(opts: SimulatorOptions): { app: Hono; deps: SimulatorDeps } {
  const now = opts.now ?? Date.now;
  const deps: SimulatorDeps = {
    db: opts.db,
    faults: new FaultEngine(opts.db, now),
    adminToken: opts.adminToken,
    now,
    baseUrl: opts.baseUrl,
    webhookTimeoutMs: opts.webhookTimeoutMs ?? 5_000,
    allowReset: opts.allowReset ?? false,
  };
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: 'invalid_request', issues: err.issues }, 400);
    if (err instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400);
    console.error('[simulator] unhandled error', err);
    return c.json({ error: 'internal_error' }, 500);
  });
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.route('/', createFaultAdminApp(deps));
  app.route('/', createMetaApp(deps));
  app.route('/', createCrmApp(deps));
  return { app, deps };
}
