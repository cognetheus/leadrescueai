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

const server = serve({ fetch: app.fetch, port: config.SIMULATOR_PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[simulators] Meta Lead Ads + CRM simulators listening on http://127.0.0.1:${info.port} (db: ${config.simulatorDbPath})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
