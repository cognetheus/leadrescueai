import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppDatabase } from '../db/connection';
import type { FaultEngine, FiredFault } from './faults/engine';

export interface SimulatorDeps {
  db: AppDatabase;
  faults: FaultEngine;
  adminToken: string;
  now: () => number;
  /** Public base URL of the simulator itself (used in pagination `next` links). */
  baseUrl: string;
  webhookTimeoutMs: number;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function bearer(c: Context): string | null {
  const h = c.req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** Admin endpoints (provisioning, fault injection, inspection) require the simulator admin token. */
export function requireAdmin(adminToken: string): MiddlewareHandler {
  return async (c, next) => {
    const token = bearer(c);
    if (!token || !safeEqual(token, adminToken)) return c.json({ error: 'unauthorized' }, 401);
    return next();
  };
}

/** Response for an injected `http_error` fault, including a Retry-After hint when configured. */
export function faultHttpResponse(c: Context, fault: FiredFault, body: unknown): Response {
  if (fault.effect.type !== 'http_error') throw new Error('not an http_error fault');
  if (fault.effect.retryAfterSec !== undefined) c.header('retry-after', String(fault.effect.retryAfterSec));
  c.header('x-simulated-fault', fault.ruleId);
  return c.json(body, fault.effect.status as 500);
}
