import { afterAll, describe, expect, it } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { CONTAINER_KEY, createContainer } from '../../src/container';
import { createMastra } from '../../src/mastra/create-mastra';
import { silentLogger } from '../../src/shared/logger';
import { testConfig } from '../support/config';

describe('Mastra runtime (P00.02)', () => {
  const config = testConfig();
  const container = createContainer({ config, logger: silentLogger });
  const mastra = createMastra({ config, workers: false });
  afterAll(async () => {
    await mastra.shutdown();
    container.db.close();
    config.cleanup();
  });

  it('runs the baseline workflow against the app database and persists run + trace', async () => {
    const requestContext = new RequestContext();
    requestContext.set(CONTAINER_KEY, container);
    const run = await mastra.getWorkflow('platformHeartbeatWorkflow').createRun();
    const result = await run.start({ inputData: { requestedBy: 'vitest' }, requestContext });

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.result.healthy).toBe(true);
    expect(result.result.summary).toContain('requested by vitest');

    const storage = mastra.getStorage();
    const workflows = await storage?.getStore('workflows');
    const persisted = await workflows?.getWorkflowRunById({ runId: run.runId, workflowName: 'platform-heartbeat' });
    expect(persisted?.runId).toBe(run.runId);

    // Spans are exported asynchronously; poll the durable store instead of sleeping blindly.
    const observability = await storage?.getStore('observability');
    let names: string[] = [];
    for (let i = 0; i < 50 && !names.includes("workflow step: 'summarize'"); i++) {
      const traces = await observability!.listTraces({});
      const traceIds = [...new Set(traces.spans.map((s) => s.traceId))];
      const all = await Promise.all(traceIds.map((traceId) => observability!.getTrace({ traceId })));
      names = all.flatMap((t) => t?.spans.map((s) => s.name) ?? []);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(names).toContain("workflow run: 'platform-heartbeat'");
    expect(names).toContain("workflow step: 'check-app-database'");
  });
});
