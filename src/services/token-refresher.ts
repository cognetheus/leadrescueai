import type { Repositories } from '../db/repositories';
import { isIntegrationError } from '../integrations/errors';
import type { CrmClient } from '../integrations/crm';
import type { Clock } from '../shared/clock';
import type { AppLogger } from '../shared/logger';

export type RefreshOutcome =
  | { outcome: 'refreshed'; version: number }
  | { outcome: 'already_refreshed'; version: number }
  | { outcome: 'revoked'; reason: string }
  | { outcome: 'unavailable'; reason: string };

/**
 * CRM token refresh with rotation safety.
 *
 * The CRM rotates refresh tokens and revokes the grant if a spent one is replayed, so
 * refreshes are serialized per tenant (lock) and committed with optimistic versioning.
 * A worker that finds the token was refreshed after its attempt started reuses it.
 */
export class TokenRefresher {
  constructor(private repos: Repositories, private crm: CrmClient, private clock: Clock, private logger: AppLogger) {}

  async refresh(tenantId: string, opts: { owner: string; staleSince: number; waitMs?: number }): Promise<RefreshOutcome> {
    const before = this.repos.credentials.get(tenantId, 'crm');
    if (!before) return { outcome: 'revoked', reason: 'tenant has no CRM connection' };
    if (before.status === 'revoked') return { outcome: 'revoked', reason: 'CRM connection already revoked' };
    if (before.lastRefreshedAt !== null && before.lastRefreshedAt >= opts.staleSince) return { outcome: 'already_refreshed', version: before.version };

    if (!this.repos.credentials.tryAcquireRefreshLock(tenantId, opts.owner, 15_000)) {
      // Someone else is refreshing: wait for their result instead of racing them.
      const deadline = Date.now() + (opts.waitMs ?? 5_000);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const now = this.repos.credentials.get(tenantId, 'crm');
        if (now?.status === 'revoked') return { outcome: 'revoked', reason: 'CRM connection revoked during concurrent refresh' };
        if (now && now.version !== before.version) return { outcome: 'already_refreshed', version: now.version };
      }
      return { outcome: 'unavailable', reason: 'another worker holds the refresh lock' };
    }

    const cred = this.repos.credentials.get(tenantId, 'crm')!;
    try {
      const grant = await this.crm.refreshToken({ clientId: cred.secrets.clientId, clientSecret: cred.secrets.clientSecret, refreshToken: cred.secrets.refreshToken });
      const saved = this.repos.credentials.saveRefreshed(
        tenantId, cred.version,
        { ...cred.secrets, accessToken: grant.accessToken, refreshToken: grant.refreshToken },
        this.clock.now() + grant.expiresInSec * 1000,
      );
      const version = this.repos.credentials.get(tenantId, 'crm')!.version;
      this.repos.audit.record({ tenantId, actor: opts.owner, action: 'credential.refreshed', entityType: 'credential', entityId: cred.id, data: { provider: 'crm', version, rotated: true } });
      this.logger.info('CRM access token refreshed', { tenantId, version });
      return saved ? { outcome: 'refreshed', version } : { outcome: 'already_refreshed', version };
    } catch (err) {
      this.repos.credentials.releaseRefreshLock(tenantId, opts.owner);
      if (isIntegrationError(err) && (err.details.providerCode === 'invalid_grant' || err.details.providerCode === 'invalid_client')) {
        this.repos.credentials.markRevoked(tenantId, 'crm');
        this.repos.audit.record({ tenantId, actor: opts.owner, action: 'credential.revoked', entityType: 'credential', entityId: cred.id, data: { provider: 'crm', providerCode: err.details.providerCode } });
        this.logger.error('CRM refresh grant revoked; re-authorization required', { tenantId });
        return { outcome: 'revoked', reason: `token endpoint answered ${String(err.details.providerCode)}` };
      }
      return { outcome: 'unavailable', reason: (err as Error).message };
    }
  }
}
