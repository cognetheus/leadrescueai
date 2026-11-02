import { Mastra } from '@mastra/core/mastra';
import type { MastraWorker } from '@mastra/core/worker';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import type { AppConfig } from '../config/env';
import { createMastraLogger } from '../shared/logger';
import { leadDeliveryWorkflow } from './workflows/lead-delivery';
import { platformHeartbeatWorkflow } from './workflows/platform-heartbeat';

export interface MastraFactoryOptions {
  config: AppConfig;
  /** Override for tests (e.g. `file::memory:`) */
  storageUrl?: string;
  workers?: MastraWorker[] | false;
}

export const workflows = {
  platformHeartbeatWorkflow,
  leadDeliveryWorkflow,
};

/**
 * Shared Mastra configuration. `src/mastra/index.ts` (loaded by `mastra dev`/Studio)
 * and the test harness both build their instance from here so they cannot drift.
 */
export function mastraOptions(opts: MastraFactoryOptions) {
  const { config } = opts;
  return {
    workflows,
    storage: new LibSQLStore({ id: 'leadrescue-mastra', url: opts.storageUrl ?? config.mastraDbUrl }),
    logger: createMastraLogger(config.LOG_LEVEL),
    observability: new Observability({
      configs: {
        default: {
          serviceName: 'leadrescue-ai',
          exporters: [new MastraStorageExporter({ strategy: 'realtime' as const })],
          spanOutputProcessors: [new SensitiveDataFilter()],
        },
      },
    }),
    // Lease-based job recovery owns crash recovery; Mastra must not re-drive runs on boot as well.
    recovery: { workflows: 'off' as const },
    ...(opts.workers !== undefined ? { workers: opts.workers } : {}),
  };
}

export function createMastra(opts: MastraFactoryOptions): Mastra {
  return new Mastra(mastraOptions(opts));
}
