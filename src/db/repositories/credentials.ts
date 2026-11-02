import type { AppDatabase } from '../connection';
import type { Clock } from '../../shared/clock';
import type { SecretBox } from '../../shared/crypto';
import { newId } from '../../shared/ids';

export interface MetaSecrets {
  appSecret: string;
  pageAccessToken: string;
}
export interface CrmSecrets {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
}
export interface SecretsByProvider {
  meta: MetaSecrets;
  crm: CrmSecrets;
}
export type Provider = keyof SecretsByProvider;

export interface Credential<P extends Provider> {
  id: string;
  tenantId: string;
  provider: P;
  secrets: SecretsByProvider[P];
  accessExpiresAt: number | null;
  status: 'active' | 'revoked';
  version: number;
  lastRefreshedAt: number | null;
}

interface Row {
  id: string; tenant_id: string; provider: Provider; secret_ciphertext: string; access_expires_at: number | null;
  status: 'active' | 'revoked'; version: number; last_refreshed_at: number | null;
}

/**
 * Credential storage. Refreshes are serialized per tenant with a short-lived lock and
 * committed with optimistic versioning, because the CRM rotates refresh tokens:
 * two concurrent refreshes would replay a spent refresh token and get the grant revoked.
 */
export class CredentialRepository {
  constructor(private db: AppDatabase, private clock: Clock, private box: SecretBox) {}

  private aad(tenantId: string, provider: Provider) {
    return `${tenantId}:${provider}`;
  }

  upsert<P extends Provider>(tenantId: string, provider: P, secrets: SecretsByProvider[P], accessExpiresAt: number | null): void {
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO credentials (id, tenant_id, provider, secret_ciphertext, access_expires_at, status, version, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 1, ?)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           secret_ciphertext = excluded.secret_ciphertext, access_expires_at = excluded.access_expires_at,
           status = 'active', version = credentials.version + 1, updated_at = excluded.updated_at`,
      )
      .run(newId('cred'), tenantId, provider, this.box.seal(secrets, this.aad(tenantId, provider)), accessExpiresAt, now);
  }

  get<P extends Provider>(tenantId: string, provider: P): Credential<P> | undefined {
    const r = this.db.prepare('SELECT * FROM credentials WHERE tenant_id = ? AND provider = ?').get(tenantId, provider) as Row | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      provider: provider,
      secrets: this.box.open<SecretsByProvider[P]>(r.secret_ciphertext, this.aad(tenantId, provider)),
      accessExpiresAt: r.access_expires_at,
      status: r.status,
      version: r.version,
      lastRefreshedAt: r.last_refreshed_at,
    };
  }

  /** Non-secret view for dashboards and AI evidence. */
  describe(tenantId: string, provider: Provider) {
    return this.db
      .prepare('SELECT provider, status, version, access_expires_at AS accessExpiresAt, last_refreshed_at AS lastRefreshedAt FROM credentials WHERE tenant_id = ? AND provider = ?')
      .get(tenantId, provider) as
      | { provider: Provider; status: string; version: number; accessExpiresAt: number | null; lastRefreshedAt: number | null }
      | undefined;
  }

  tryAcquireRefreshLock(tenantId: string, owner: string, ttlMs: number): boolean {
    const now = this.clock.now();
    const res = this.db
      .prepare(
        `UPDATE credentials SET refresh_lock_owner = ?, refresh_lock_until = ?
         WHERE tenant_id = ? AND provider = 'crm' AND status = 'active'
           AND (refresh_lock_until IS NULL OR refresh_lock_until < ? OR refresh_lock_owner = ?)`,
      )
      .run(owner, now + ttlMs, tenantId, now, owner);
    return res.changes === 1;
  }

  releaseRefreshLock(tenantId: string, owner: string): void {
    this.db
      .prepare(`UPDATE credentials SET refresh_lock_owner = NULL, refresh_lock_until = NULL WHERE tenant_id = ? AND provider = 'crm' AND refresh_lock_owner = ?`)
      .run(tenantId, owner);
  }

  /** Commits rotated tokens only if nobody else rotated them first. */
  saveRefreshed(tenantId: string, expectedVersion: number, secrets: CrmSecrets, accessExpiresAt: number): boolean {
    const now = this.clock.now();
    const res = this.db
      .prepare(
        `UPDATE credentials SET secret_ciphertext = ?, access_expires_at = ?, version = version + 1,
           last_refreshed_at = ?, updated_at = ?, refresh_lock_owner = NULL, refresh_lock_until = NULL
         WHERE tenant_id = ? AND provider = 'crm' AND version = ? AND status = 'active'`,
      )
      .run(this.box.seal(secrets, this.aad(tenantId, 'crm')), accessExpiresAt, now, now, tenantId, expectedVersion);
    return res.changes === 1;
  }

  markRevoked(tenantId: string, provider: Provider): void {
    this.db
      .prepare(`UPDATE credentials SET status = 'revoked', version = version + 1, updated_at = ?, refresh_lock_owner = NULL, refresh_lock_until = NULL WHERE tenant_id = ? AND provider = ?`)
      .run(this.clock.now(), tenantId, provider);
  }
}
