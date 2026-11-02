import { Hono } from 'hono';
import { openSimulatorDb } from '../../src/simulators/db';
import { createSimulatorApp } from '../../src/simulators/server';
import { startServer } from './http-server';

export const SIM_ADMIN = 'test-sim-admin-token-0123456789';

/** Runs the simulators on an ephemeral port against an in-memory database. */
export async function startSimulator() {
  const db = openSimulatorDb(':memory:');
  const { app, deps } = createSimulatorApp({ db, adminToken: SIM_ADMIN, baseUrl: 'http://placeholder', webhookTimeoutMs: 2_000, allowReset: true });
  const server = await startServer(app);
  deps.baseUrl = server.url;
  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${SIM_ADMIN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    return json as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { url: server.url, db, deps, admin, close: server.close };
}

/** Captures webhooks sent by the simulator. */
export async function startWebhookSink(status = 200) {
  const received: Array<{ body: string; signature: string | undefined }> = [];
  const app = new Hono();
  app.post('/hook', async (c) => {
    received.push({ body: await c.req.text(), signature: c.req.header('x-hub-signature-256') });
    return c.json({ ok: true }, status as 200);
  });
  const server = await startServer(app);
  return { url: `${server.url}/hook`, received, close: server.close };
}
