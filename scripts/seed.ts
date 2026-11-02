/** Provisions the demo tenants in the simulators and the application database. Idempotent. */
import { createContainer } from '../src/container';
import { SimulatorAdminClient } from '../src/simulators/admin-client';
import { TENANT_FIXTURES } from '../src/simulators/fixtures';
import { provisionTenant } from '../src/services/provisioning';

const container = createContainer();
const { config } = container;
const sim = new SimulatorAdminClient(config.SIMULATOR_BASE_URL, config.SIMULATOR_ADMIN_TOKEN);
try {
  await sim.health();
} catch {
  console.error(`Simulators are not reachable at ${config.SIMULATOR_BASE_URL}. Start them with: pnpm sim`);
  process.exit(1);
}
for (const fx of TENANT_FIXTURES) {
  const tenant = await provisionTenant(container, sim, fx);
  console.log(`✓ ${tenant.slug.padEnd(14)} page=${tenant.metaPageId} crmLocation=${tenant.crmLocationId} webhook=${config.APP_PUBLIC_URL}/webhooks/meta/${tenant.slug}`);
}
container.db.close();
