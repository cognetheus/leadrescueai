/** Entry point for the third-party simulators (Meta Lead Ads + CRM) on SIMULATOR_PORT. */
import { serve } from '@hono/node-server';
import { getConfig } from '../config/env';
import { openSimulatorDb } from './db';
import { createSimulatorApp } from './server';

const config = getConfig();
const db = openSimulatorDb(config.simulatorDbPath);
const { app } = createSimulatorApp({ db, adminToken: config.SIMULATOR_ADMIN_TOKEN, baseUrl: config.SIMULATOR_BASE_URL,
  allowReset: config.APP_ENV !== 'production',
});

// Containers set SIMULATOR_HOST=0.0.0.0; local runs stay on loopback.
const hostname = process.env.SIMULATOR_HOST ?? '127.0.0.1';
const server = serve({ fetch: app.fetch, port: config.SIMULATOR_PORT, hostname }, (info) => {
  console.log(`[simulators] Meta Lead Ads + CRM simulators listening on http://${hostname}:${info.port} (db: ${config.simulatorDbPath})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
