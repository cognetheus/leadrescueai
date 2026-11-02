import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { resolveContainer } from '../../container';
import { createJobRunner } from '../../jobs/create-runner';
import { Reconciler, type SegmentResult } from '../../services/reconciliation';

const Input = z.object({
  trigger: z.enum(['schedule', 'manual']).default('manual'),
  /** Restrict to some tenants (demo/testing); default: every active tenant. */
  tenantSlugs: z.array(z.string()).optional(),
});
const RunState = z.object({ runId: z.string().default('') });
const Item = z.object({ runId: z.string(), tenantId: z.string() });
const Segment = z.object({
  tenantId: z.string(), tenant: z.string(), status: z.enum(['completed', 'failed']), scanned: z.number(), pages: z.number(),
  alreadyDelivered: z.number(), inFlight: z.number(), missing: z.number(), stalled: z.number(), escalated: z.number(),
  backfilled: z.number(), backfillVerified: z.number(), backfillPending: z.number(), checkpointAdvancedTo: z.string().nullable(), error: z.string().nullable(),
});
const Report = z.object({
  runId: z.string(),
  status: z.enum(['completed', 'partial', 'failed']),
  tenants: z.number(),
  scanned: z.number(),
  missing: z.number(),
  backfillVerified: z.number(),
  backfillPending: z.number(),
  failedTenants: z.array(z.string()),
});

const startRun = createStep({
  id: 'start-run',
  description: 'Record the reconciliation run and select active tenants',
  inputSchema: Input,
  outputSchema: z.array(Item),
  stateSchema: RunState,
  execute: async ({ inputData, requestContext, runId, setState }) => {
    const { repos } = resolveContainer(requestContext);
    const run = repos.reconciliation.startRun(inputData.trigger, runId);
    await setState({ runId: run.id });
    const tenants = repos.tenants.listActive().filter((t) => !inputData.tenantSlugs?.length || inputData.tenantSlugs.includes(t.slug));
    return tenants.map((t) => ({ runId: run.id, tenantId: t.id }));
  },
});

const reconcileTenant = createStep({
  id: 'reconcile-tenant',
  description: 'Scan the source (cursor pagination + lookback), compare, backfill missing leads, verify, then commit the checkpoint',
  inputSchema: Item,
  outputSchema: Segment,
  execute: async ({ inputData, requestContext, mastra }) => {
    const c = resolveContainer(requestContext);
    const tenant = c.repos.tenants.get(inputData.tenantId)!;
    const runner = createJobRunner(c, mastra, { workerId: `reconciler:${inputData.runId}`, concurrency: 1, listen: false });
    const reconciler = new Reconciler({
      repos: c.repos, db: c.db, queue: c.queue, source: c.services.source, crm: c.services.crm, credentials: c.services.credentials,
      incidents: c.services.incidents, clock: c.clock, logger: c.logger, lookbackMs: c.config.RECONCILE_LOOKBACK_MS,
      pageSize: c.config.RECONCILE_PAGE_SIZE, deliveryDeadlineMs: c.config.DELIVERY_DEADLINE_MS,
      processJob: async (jobId) => {
        const job = c.queue.claimById(jobId, `reconciler:${inputData.runId}`, c.config.JOB_LEASE_MS);
        if (job) {
          await runner.process(job);
          return;
        }
        // Owned by a worker right now: wait (bounded) for it to finish.
        for (let i = 0; i < 100 && c.queue.get(jobId)?.status === 'leased'; i++) await new Promise((r) => setTimeout(r, 100));
      },
    });
    return reconciler.reconcileTenant(tenant, inputData.runId) as Promise<SegmentResult>;
  },
});

const finishRun = createStep({
  id: 'report',
  description: 'Summarize findings and close the run (partial if any tenant segment failed)',
  inputSchema: z.array(Segment),
  outputSchema: Report,
  stateSchema: RunState,
  execute: async ({ inputData, requestContext, state }) => {
    const { repos } = resolveContainer(requestContext);
    const failed = inputData.filter((s) => s.status === 'failed');
    const status = failed.length === 0 ? 'completed' : failed.length === inputData.length ? 'failed' : 'partial';
    const sum = (k: keyof SegmentResult) => inputData.reduce((a, s) => a + (s[k] as number), 0);
    const report = {
      runId: state.runId, status, tenants: inputData.length, scanned: sum('scanned'), missing: sum('missing'),
      backfillVerified: sum('backfillVerified'), backfillPending: sum('backfillPending'), failedTenants: failed.map((f) => f.tenant),
    } as const;
    repos.reconciliation.finishRun(state.runId, status, { ...report, segments: inputData }, failed.length ? failed.map((f) => `${f.tenant}: ${f.error}`).join('; ') : undefined);
    return report;
  },
});

export const sourceReconciliationWorkflow = createWorkflow({
  id: 'source-reconciliation',
  description: 'Workflow C: find leads the webhooks missed and backfill them through the delivery pipeline',
  inputSchema: Input,
  outputSchema: Report,
  stateSchema: RunState,
  // Native Mastra cron scheduling (SchedulerWorker). Read from the environment at definition time.
  schedule: { cron: process.env.RECONCILE_CRON ?? '*/5 * * * *', inputData: { trigger: 'schedule' } },
})
  .then(startRun)
  .foreach(reconcileTenant, { concurrency: 1 })
  .then(finishRun)
  .commit();
