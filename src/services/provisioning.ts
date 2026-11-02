import { randomBytes } from 'node:crypto';
import type { Container } from '../container';
import type { SimulatorAdminClient } from '../simulators/admin-client';
import type { TenantFixture } from '../simulators/fixtures';
import type { Tenant } from '../db/repositories/tenants';

const secret = () => randomBytes(24).toString('base64url');

/**
 * Connects a tenant to its (simulated) providers, idempotently:
 * - app tenant row (by slug),
 * - Meta page subscription pointing at this tenant's signed webhook endpoint,
 * - CRM OAuth installation, with the issued tokens stored encrypted in the app database.
 *
 * Re-running re-uses existing Meta secrets and re-installs the CRM app (new token family),
 * which is also how an operator re-authorizes a tenant after its refresh grant was revoked.
 */
export async function provisionTenant(container: Container, sim: SimulatorAdminClient, fx: TenantFixture): Promise<Tenant> {
  const { repos, config } = container;
  const tenant =
    repos.tenants.getBySlug(fx.slug) ??
    repos.tenants.create({ slug: fx.slug, name: fx.name, metaPageId: fx.metaPageId, crmLocationId: fx.crmLocationId });

  const existingMeta = repos.credentials.get(tenant.id, 'meta');
  const meta = existingMeta?.secrets ?? { appSecret: secret(), pageAccessToken: `pat_${secret()}` };
  await sim.upsertPage({
    pageId: tenant.metaPageId,
    name: tenant.name,
    appSecret: meta.appSecret,
    pageAccessToken: meta.pageAccessToken,
    webhookUrl: `${config.APP_PUBLIC_URL}/webhooks/meta/${tenant.slug}`,
  });
  if (!existingMeta) repos.credentials.upsert(tenant.id, 'meta', meta, null);

  const existingCrm = repos.credentials.get(tenant.id, 'crm');
  const client = existingCrm
    ? { clientId: existingCrm.secrets.clientId, clientSecret: existingCrm.secrets.clientSecret }
    : { clientId: `client_${fx.slug}`, clientSecret: secret() };
  const grant = await sim.installCrmLocation({ locationId: tenant.crmLocationId, name: tenant.name, ...client });
  repos.credentials.upsert(
    tenant.id,
    'crm',
    { ...client, accessToken: grant.access_token, refreshToken: grant.refresh_token },
    container.clock.now() + grant.expires_in * 1000,
  );
  repos.audit.record({ tenantId: tenant.id, actor: 'operator', action: 'tenant.provisioned', entityType: 'tenant', entityId: tenant.id, data: { slug: tenant.slug } });
  return tenant;
}
