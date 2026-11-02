import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { resolveContainer } from '../../container';

/**
 * Baseline workflow: proves the Mastra runtime can reach the application database
 * and persist a run that Studio can display. Used as a smoke test and readiness probe.
 */
const checkAppDatabase = createStep({
  id: 'check-app-database',
  description: 'Executes a read against the application SQLite database',
  inputSchema: z.object({ requestedBy: z.string().default('manual') }),
  outputSchema: z.object({ requestedBy: z.string(), sqliteVersion: z.string(), checkedAt: z.string() }),
  execute: async ({ inputData, requestContext }) => {
    const { db, clock } = resolveContainer(requestContext);
    const row = db.prepare('select sqlite_version() as version').get() as { version: string };
    return {
      requestedBy: inputData.requestedBy,
      sqliteVersion: row.version,
      checkedAt: new Date(clock.now()).toISOString(),
    };
  },
});

const summarize = createStep({
  id: 'summarize',
  inputSchema: z.object({ requestedBy: z.string(), sqliteVersion: z.string(), checkedAt: z.string() }),
  outputSchema: z.object({ healthy: z.boolean(), summary: z.string() }),
  execute: async ({ inputData }) => ({
    healthy: true,
    summary: `App database reachable (SQLite ${inputData.sqliteVersion}) at ${inputData.checkedAt}, requested by ${inputData.requestedBy}`,
  }),
});

export const platformHeartbeatWorkflow = createWorkflow({
  id: 'platform-heartbeat',
  description: 'Smoke test: Mastra runtime -> application database round trip',
  inputSchema: z.object({ requestedBy: z.string().default('manual') }),
  outputSchema: z.object({ healthy: z.boolean(), summary: z.string() }),
})
  .then(checkAppDatabase)
  .then(summarize)
  .commit();
