import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { AddressInfo } from 'node:net';

/** Starts a Hono app on an ephemeral port and returns its base URL. */
export async function startServer(app: Hono): Promise<{ url: string; close: () => Promise<void> }> {
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
