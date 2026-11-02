import path from 'node:path';
import type { Mastra } from '@mastra/core/mastra';
import { createWebhookApp } from '../../src/api/webhooks';
import { createContainer, type Container } from '../../src/container';
import type { Tenant } from '../../src/db/repositories/tenants';
import { createJobRunner } from '../../src/jobs/create-runner';
import type { JobRunner } from '../../src/jobs/runner';
import { createMastra } from '../../src/mastra/create-mastra';
import { SimulatorAdminClient } from '../../src/simulators/admin-client';
import { installScenario } from '../../src/simulators/faults/install';
import { planScenario, type ScenarioName } from '../../src/simulators/faults/scenarios';
import { generateLead, TENANT_FIXTURES, type TenantFixture } from '../../src/simulators/fixtures';
import { provisionTenant } from '../../src/services/provisioning';
import { ManualClock } from '../../src/shared/clock';
import { silentLogger } from '../../src/shared/logger';
import { testConfig } from './config';
import { startServer } from './http-server';
import { SIM_ADMIN, startSimulator } from './simulator';

export interface Harness {
  container: Container;
  mastra: Mastra;
  runner: JobRunner;
  clock: ManualClock;
  sim: SimulatorAdminClient;
  tenants: Record<string, Tenant>;
  /** Runs jobs until none are runnable, jumping the clock to each scheduled retry. */
  drain(opts?: { maxJobs?: number; horizonMs?: number }): Promise<number>;
  submitLead(opts?: { tenant?: string; seed?: number; scenario?: ScenarioName }): Promise<{ leadId: string; webhook: { outcome: string } }>;
  contactsFor(tenant: string, leadId: string): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

let seedCounter = 1000;

export async function createHarness(env: Record<string, string> = {}): Promise<Harness> {
  const simServer = await startSimulator();
  const config = testConfig({ SIMULATOR_BASE_URL: simServer.url, HTTP_TIMEOUT_MS: '1000', AI_ENABLED: 'false', ...env });
  const clock = new ManualClock(Date.now());
  const container = createContainer({ config, clock, logger: silentLogger });
  const webhookServer = await startServer(createWebhookApp(() => container.ingestion, () => silentLogger));
  container.config.APP_PUBLIC_URL = webhookServer.url;
  const sim = new SimulatorAdminClient(simServer.url, SIM_ADMIN);
  const tenants: Record<string, Tenant> = {};
  for (const fx of TENANT_FIXTURES) tenants[fx.slug] = await provisionTenant(container, sim, fx);
  const mastra = createMastra({ config, storageUrl: `file:${path.join(config.dataDir, 'mastra.db')}`, workers: false });
  const runner = createJobRunner(container, mastra, { workerId: 'test-worker', concurrency: 1 });

  const drain: Harness['drain'] = async ({ maxJobs = 100, horizonMs = 24 * 3600_000 } = {}) => {
    let processed = 0;
    const start = clock.now();
    while (processed < maxJobs) {
      if (await runner.runOnce()) {
        processed++;
        continue;
      }
      const next = container.db.prepare("SELECT min(run_after) AS t FROM jobs WHERE status = 'queued'").get() as { t: number | null };
      const expired = container.db.prepare("SELECT min(lease_expires_at) AS t FROM jobs WHERE status = 'leased'").get() as { t: number | null };
      const t = Math.min(next.t ?? Infinity, expired.t !== null ? expired.t + 1 : Infinity);
      if (!Number.isFinite(t) || t - start > horizonMs) break;
      clock.set(Math.max(clock.now(), t));
    }
    return processed;
  };

  const submitLead: Harness['submitLead'] = async ({ tenant = 'acme-roofing', seed = seedCounter++, scenario = 'healthy' } = {}) => {
    const fx = TENANT_FIXTURES.find((f) => f.slug === tenant) as TenantFixture;
    const t = tenants[tenant]!;
    const plan = planScenario(scenario, { pageId: t.metaPageId, locationId: t.crmLocationId, leadId: generateLead(seed, fx).id, clientTimeoutMs: config.HTTP_TIMEOUT_MS });
    const lead = generateLead(seed, fx, plan.leadVariant);
    await installScenario(sim, plan, t.crmLocationId);
    const { webhook } = await sim.createLead(t.metaPageId, lead);
    return { leadId: lead.id, webhook };
  };

  return {
    container, mastra, runner, clock, sim, tenants, drain, submitLead,
    contactsFor: async (tenant, leadId) => (await sim.crmContacts(tenants[tenant]!.crmLocationId)).contacts.filter((c) => c.externalSourceId === leadId),
    close: async () => {
      await runner.stop(1_000);
      await mastra.shutdown();
      await simServer.close();
      await webhookServer.close();
      container.db.close();
      config.cleanup();
    },
  };
}
