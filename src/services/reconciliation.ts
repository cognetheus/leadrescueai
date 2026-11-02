import type { Repositories } from '../db/repositories';
import type { Tenant } from '../db/repositories/tenants';
import type { MetaSourceClient } from '../integrations/meta-source';
import type { Clock } from '../shared/clock';
import type { AppLogger } from '../shared/logger';
import type { CredentialService } from './credentials';

export const RECONCILE_SOURCE = 'meta_lead_ads';
/** First scan of a tenant without a checkpoint looks back this far. */
export const INITIAL_SCAN_WINDOW_MS = 7 * 24 * 3600_000;
/** Hard bound on pages per tenant scan (25k leads at 25/page) so a broken cursor cannot loop forever. */
export const MAX_PAGES = 1_000;

export interface SourceLeadRef {
  id: string;
  createdTime: string | null;
}

export interface TenantScan {
  tenantId: string;
  windowStart: number;
  scanStartedAt: number;
  pages: number;
  leads: SourceLeadRef[];
}

export interface ReconciliationDeps {
  repos: Repositories;
  source: MetaSourceClient;
  credentials: CredentialService;
  clock: Clock;
  logger: AppLogger;
  lookbackMs: number;
  pageSize: number;
}

/**
 * Source scanning for reconciliation (Workflow C, part 1).
 *
 * Each scan covers [checkpoint − lookback, now]. The overlap re-reads recent leads on
 * every run so records that materialize late at the source (or behind a moving cursor)
 * are still found; comparison against deliveries makes the overlap harmless.
 */
export class SourceScanner {
  constructor(private deps: ReconciliationDeps) {}

  window(tenant: Tenant): { windowStart: number; scanStartedAt: number } {
    const scanStartedAt = this.deps.clock.now();
    const cp = this.deps.repos.reconciliation.getCheckpoint(tenant.id, RECONCILE_SOURCE);
    const windowStart = cp ? Math.max(0, cp.checkpointAt - this.deps.lookbackMs) : scanStartedAt - INITIAL_SCAN_WINDOW_MS;
    return { windowStart, scanStartedAt };
  }

  /** Reads every source lead in the tenant's window, following cursors until exhausted. */
  async scan(tenant: Tenant): Promise<TenantScan> {
    const { windowStart, scanStartedAt } = this.window(tenant);
    const token = this.deps.credentials.metaPageToken(tenant.id);
    const seen = new Map<string, SourceLeadRef>();
    let after: string | null = null;
    let pages = 0;
    do {
      if (++pages > MAX_PAGES) throw new Error(`pagination exceeded ${MAX_PAGES} pages for tenant ${tenant.slug}`);
      const page = await this.deps.source.listLeads(token, tenant.metaPageId, { sinceMs: windowStart, limit: this.deps.pageSize, after });
      for (const l of page.leads) seen.set(l.id, { id: l.id, createdTime: typeof l.created_time === 'string' ? l.created_time : null });
      if (page.nextCursor !== null && page.nextCursor === after) throw new Error('source returned a non-advancing cursor');
      after = page.nextCursor;
    } while (after);
    return { tenantId: tenant.id, windowStart, scanStartedAt, pages, leads: [...seen.values()] };
  }

  /** Called only after the whole tenant segment (scan, compare, backfill) succeeded. */
  commitCheckpoint(scan: TenantScan, runId: string): void {
    this.deps.repos.reconciliation.advanceCheckpoint(scan.tenantId, RECONCILE_SOURCE, scan.scanStartedAt, runId);
  }
}
