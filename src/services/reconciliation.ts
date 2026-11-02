import type { AppDatabase } from '../db/connection';
import type { Delivery } from '../db/repositories/deliveries';
import type { FindingType } from '../db/repositories/reconciliation';
import type { CrmClient } from '../integrations/crm';
import type { JobQueue } from '../jobs/queue';
import type { IncidentService } from './incidents';
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

const IN_FLIGHT = new Set(['pending', 'processing', 'retry_scheduled']);

export interface SegmentResult {
  tenantId: string;
  tenant: string;
  status: 'completed' | 'failed';
  scanned: number;
  pages: number;
  alreadyDelivered: number;
  inFlight: number;
  missing: number;
  stalled: number;
  escalated: number;
  backfilled: number;
  backfillVerified: number;
  backfillPending: number;
  checkpointAdvancedTo: string | null;
  error: string | null;
}

export interface ReconcilerDeps extends ReconciliationDeps {
  db: AppDatabase;
  queue: JobQueue;
  crm: CrmClient;
  incidents: IncidentService;
  deliveryDeadlineMs: number;
  /** Claims and runs a job inline (backfill verification); resolves when it has run or is owned elsewhere. */
  processJob: (jobId: string) => Promise<void>;
}

/**
 * Workflow C: compares the source of truth with delivery records and repairs gaps through
 * the normal delivery mechanism (never by writing to the CRM directly).
 */
export class Reconciler {
  readonly scanner: SourceScanner;
  constructor(private deps: ReconcilerDeps) {
    this.scanner = new SourceScanner(deps);
  }

  async reconcileTenant(tenant: Tenant, runId: string): Promise<SegmentResult> {
    const r: SegmentResult = {
      tenantId: tenant.id, tenant: tenant.slug, status: 'completed', scanned: 0, pages: 0, alreadyDelivered: 0, inFlight: 0, missing: 0,
      stalled: 0, escalated: 0, backfilled: 0, backfillVerified: 0, backfillPending: 0, checkpointAdvancedTo: null, error: null,
    };
    const log = this.deps.logger.child({ tenantId: tenant.id, reconciliationRunId: runId });
    try {
      const scan = await this.scanner.scan(tenant);
      r.scanned = scan.leads.length;
      r.pages = scan.pages;
      const toVerify: Array<{ delivery: Delivery; jobId: string; sourceLeadId: string; finding: FindingType }> = [];

      for (let i = 0; i < scan.leads.length; i += 200) {
        const batch = scan.leads.slice(i, i + 200);
        const known = this.deps.repos.deliveries.getManyByLead(tenant.id, RECONCILE_SOURCE, batch.map((l) => l.id));
        for (const lead of batch) {
          const d = known.get(lead.id);
          if (!d) {
            r.missing++;
            toVerify.push({ ...this.backfill(tenant, lead.id, runId), sourceLeadId: lead.id, finding: 'missing' });
          } else if (d.status === 'delivered') {
            r.alreadyDelivered++;
          } else if (d.status === 'escalated') {
            r.escalated++;
            this.deps.repos.reconciliation.addFinding({ runId, tenantId: tenant.id, sourceLeadId: lead.id, finding: 'escalated', action: 'report_only', deliveryId: d.id, outcome: 'awaiting operator' });
          } else if (IN_FLIGHT.has(d.status)) {
            const live = this.deps.queue.liveByDedupeKey(`deliver:${d.id}`);
            if (live) {
              r.inFlight++;
              continue;
            }
            // In-flight with no job behind it: state is uncertain, so ask the CRM before acting.
            r.stalled++;
            const stalled = await this.requeueStalled(tenant, d, runId);
            toVerify.push({ delivery: d, jobId: stalled.jobId, sourceLeadId: lead.id, finding: stalled.finding });
          }
        }
      }

      for (const item of toVerify) {
        await this.deps.processJob(item.jobId);
        const verified = await this.verifyBackfill(tenant, item.delivery.id, item.sourceLeadId);
        if (item.finding === 'missing') r.backfilled++;
        if (verified === 'verified') r.backfillVerified++;
        else r.backfillPending++;
        this.deps.repos.reconciliation.addFinding({
          runId, tenantId: tenant.id, sourceLeadId: item.sourceLeadId, finding: item.finding,
          action: item.finding === 'missing' ? 'reconciliation_backfill' : 'requeue_delivery', deliveryId: item.delivery.id,
          outcome: verified === 'verified' ? 'delivered and verified in CRM' : `not yet delivered (${verified})`,
        });
      }

      // The segment completed: only now may the checkpoint move forward.
      this.scanner.commitCheckpoint(scan, runId);
      r.checkpointAdvancedTo = new Date(scan.scanStartedAt).toISOString();
      log.info('Reconciliation segment completed', { scanned: r.scanned, missing: r.missing, backfillVerified: r.backfillVerified });
    } catch (err) {
      r.status = 'failed';
      r.error = (err as Error).message;
      log.error('Reconciliation segment failed; checkpoint not advanced', { error: r.error });
    }
    return r;
  }

  /** Creates the missing delivery and its job exactly like a webhook would, plus a lost-webhook incident. */
  private backfill(tenant: Tenant, sourceLeadId: string, runId: string): { delivery: Delivery; jobId: string } {
    const { repos, queue, db } = this.deps;
    const correlationId = `cor_${runId}`;
    return db.transaction(() => {
      const { delivery, created } = repos.deliveries.insertIfAbsent({
        tenantId: tenant.id, source: RECONCILE_SOURCE, sourceLeadId, trigger: 'reconciliation', firstEventId: null, correlationId, deadlineMs: this.deps.deliveryDeadlineMs,
      });
      const { job } = queue.enqueue('deliver_lead', { deliveryId: delivery.id, correlationId: delivery.correlationId }, { dedupeKey: `deliver:${delivery.id}`, tenantId: tenant.id });
      if (created) {
        const incident = repos.incidents.create({
          tenantId: tenant.id, deliveryId: delivery.id, kind: 'lost_webhook', title: `Lead ${sourceLeadId} never arrived by webhook`,
          severity: 'medium', failureClass: null, failureCode: 'webhook_not_received', correlationId: delivery.correlationId,
        });
        this.deps.incidents.event(incident, 'detected', `Reconciliation run ${runId} found lead ${sourceLeadId} at the source with no delivery record`, null, { runId });
        this.deps.incidents.event(incident, 'remediation_selected', 'Selected reconciliation_backfill: deliver through the standard pipeline (read-before-write, verification)', null, { action: 'reconciliation_backfill' });
        repos.audit.record({ tenantId: tenant.id, actor: 'reconciler', action: 'delivery.backfilled', entityType: 'delivery', entityId: delivery.id, correlationId: delivery.correlationId, data: { sourceLeadId, runId, jobId: job.id } });
      }
      return { delivery, jobId: job.id };
    }).immediate();
  }

  private async requeueStalled(tenant: Tenant, d: Delivery, runId: string): Promise<{ jobId: string; finding: FindingType }> {
    const token = this.deps.credentials.crmAccessToken(tenant.id);
    const contacts = await this.deps.crm.findByExternalId(token, tenant.crmLocationId, d.sourceLeadId);
    const { job } = this.deps.queue.enqueue('deliver_lead', { deliveryId: d.id, correlationId: d.correlationId }, { dedupeKey: `deliver:${d.id}`, tenantId: tenant.id });
    this.deps.repos.audit.record({
      tenantId: tenant.id, actor: 'reconciler', action: 'delivery.requeued_stalled', entityType: 'delivery', entityId: d.id, correlationId: d.correlationId,
      data: { runId, crmContactsFound: contacts.length, status: d.status },
    });
    return { jobId: job.id, finding: contacts.length ? 'crm_contact_exists' : 'stalled' };
  }

  /** Verification is independent of the pipeline's own: the CRM must hold exactly one matching contact. */
  private async verifyBackfill(tenant: Tenant, deliveryId: string, sourceLeadId: string): Promise<'verified' | string> {
    const d = this.deps.repos.deliveries.get(deliveryId)!;
    if (d.status !== 'delivered') return d.status;
    const contacts = await this.deps.crm.findByExternalId(this.deps.credentials.crmAccessToken(tenant.id), tenant.crmLocationId, sourceLeadId);
    return contacts.length === 1 && contacts[0]!.id === d.crmContactId ? 'verified' : `crm has ${contacts.length} contacts`;
  }
}
