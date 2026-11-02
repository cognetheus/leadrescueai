import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/container';
import { CrmClient } from '../../src/integrations/crm';
import { MetaSourceClient } from '../../src/integrations/meta-source';
import { SimulatorAdminClient } from '../../src/simulators/admin-client';
import { FaultRuleInputSchema } from '../../src/simulators/faults/engine';
import { installScenario } from '../../src/simulators/faults/install';
import { planScenario, SCENARIO_NAMES } from '../../src/simulators/faults/scenarios';
import { generateLead, TENANT_FIXTURES } from '../../src/simulators/fixtures';
import { provisionTenant } from '../../src/services/provisioning';
import { silentLogger } from '../../src/shared/logger';
import { testConfig } from '../support/config';
import { SIM_ADMIN, startSimulator } from '../support/simulator';

const fx = TENANT_FIXTURES[0];

describe('fixtures', () => {
  it('are deterministic per seed and use reserved fictional contact data', () => {
    expect(generateLead(42, fx)).toEqual(generateLead(42, fx));
    expect(generateLead(42, fx)).not.toEqual(generateLead(43, fx));
    for (let s = 0; s < 50; s++) {
      const l = generateLead(s, fx);
      expect(l.fields.email).toMatch(/@example\.com$/);
      expect(l.fields.phone_number).toMatch(/555-01\d\d$/);
    }
    const missing = generateLead(1, fx, 'missing_contact');
    expect(missing.fields.email).toBeUndefined();
    expect(missing.fields.phone_number).toBeUndefined();
  });
});

describe('fault scenarios (P02.03)', () => {
  let sim: Awaited<ReturnType<typeof startSimulator>>;
  let admin: SimulatorAdminClient;
  const config = testConfig();
  const container = createContainer({ config, logger: silentLogger });

  beforeAll(async () => {
    sim = await startSimulator();
    admin = new SimulatorAdminClient(sim.url, SIM_ADMIN);
  });
  afterAll(async () => {
    await sim.close();
    container.db.close();
    config.cleanup();
  });

  it('defines a valid, tenant- and lead-scoped plan for every required scenario', () => {
    expect(SCENARIO_NAMES).toHaveLength(12);
    for (const name of SCENARIO_NAMES) {
      const plan = planScenario(name, { pageId: 'p', locationId: 'l', leadId: 'lead-9', clientTimeoutMs: 5_000 });
      expect(plan.expectedOutcome.length).toBeGreaterThan(5);
      for (const rule of plan.rules) {
        const parsed = FaultRuleInputSchema.parse(rule);
        expect(parsed.matchKey).toBe('lead-9'); // never affects other leads
        expect(parsed.scopeKey).toMatch(/^[pl]$/);
      }
    }
  });

  it('provisions tenants idempotently with working, encrypted credentials', async () => {
    const t1 = await provisionTenant(container, admin, fx);
    const t2 = await provisionTenant(container, admin, fx);
    expect(t2.id).toBe(t1.id);
    const metaCred = container.repos.credentials.get(t1.id, 'meta')!;
    const crmCred = container.repos.credentials.get(t1.id, 'crm')!;
    expect(crmCred.version).toBe(2); // re-installed on the second run
    const lead = generateLead(7, fx);
    await admin.createLead(t1.metaPageId, lead);
    await expect(new MetaSourceClient(sim.url, 2_000).getLead(metaCred.secrets.pageAccessToken, lead.id)).resolves.toMatchObject({ id: lead.id });
    await expect(new CrmClient(sim.url, 2_000).findByExternalId(crmCred.secrets.accessToken, t1.crmLocationId, 'x')).resolves.toEqual([]);
  });

  it('installs scenario faults and state mutations attributably, and resets cleanly', async () => {
    const tenant = await provisionTenant(container, admin, fx);
    const crmCred = container.repos.credentials.get(tenant.id, 'crm')!;
    const plan = planScenario('revoked_refresh_token', { pageId: tenant.metaPageId, locationId: tenant.crmLocationId, leadId: '1', clientTimeoutMs: 1_000 });
    await installScenario(admin, plan, tenant.crmLocationId);
    const crm = new CrmClient(sim.url, 2_000);
    await expect(crm.findByExternalId(crmCred.secrets.accessToken, tenant.crmLocationId, 'x')).rejects.toMatchObject({ details: { providerCode: 'token_expired' } });
    await expect(crm.refreshToken({ ...crmCred.secrets })).rejects.toMatchObject({ details: { providerCode: 'invalid_grant' } });

    const p503 = planScenario('crm_503', { pageId: tenant.metaPageId, locationId: tenant.crmLocationId, leadId: '2', clientTimeoutMs: 1_000 });
    const ids = await installScenario(admin, p503, tenant.crmLocationId);
    expect((await admin.listFaults()).rules.map((r) => r.id)).toEqual(ids);

    await admin.reset();
    expect((await admin.listFaults()).rules).toEqual([]);
    expect((await admin.crmContacts()).contacts).toEqual([]);
  });
});

describe('simulator reset guard', () => {
  it('refuses to wipe data when reset is not allowed', async () => {
    const { openSimulatorDb } = await import('../../src/simulators/db');
    const { createSimulatorApp } = await import('../../src/simulators/server');
    const { app } = createSimulatorApp({ db: openSimulatorDb(':memory:'), adminToken: SIM_ADMIN, baseUrl: 'http://x', allowReset: false });
    const res = await app.request('/sim-admin/reset', { method: 'POST', headers: { authorization: `Bearer ${SIM_ADMIN}` } });
    expect(res.status).toBe(403);
  });
});
