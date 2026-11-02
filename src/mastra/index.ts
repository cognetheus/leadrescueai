import { Mastra } from '@mastra/core/mastra';
import { getConfig } from '../config/env';
import { getContainer } from '../container';
import { createJobRunner } from '../jobs/create-runner';
import { LeadJobWorker } from '../jobs/lead-job-worker';
import { mastraOptions } from './create-mastra';
import { buildApiRoutes } from './routes';

const config = getConfig();

export const mastra = new Mastra({
  ...mastraOptions({
    config,
    // The durable job runner starts with Mastra's other workers (scheduler, etc.).
    workers: config.WORKER_ENABLED ? [new LeadJobWorker((m) => createJobRunner(getContainer(), m))] : undefined,
  }),
  server: {
    port: 4111,
    // Containers set MASTRA_HOST=0.0.0.0; local runs stay on loopback.
    host: process.env.MASTRA_HOST ?? 'localhost',
    apiRoutes: buildApiRoutes(),
  },
  bundler: {
    externals: ['better-sqlite3'],
  },
});
