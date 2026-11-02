import { randomBytes } from 'node:crypto';
import type { AppDatabase } from '../db/connection';
import type { Clock } from '../shared/clock';
import { newId } from '../shared/ids';
import type { JobKind, JobPayloads, JobStatus } from '../domain/job';

export interface Job<K extends JobKind = JobKind> {
  id: string;
  tenantId: string | null;
  kind: K;
  dedupeKey: string;
  payload: JobPayloads[K];
  status: JobStatus;
  priority: number;
  runAfter: number;
  claimCount: number;
  maxClaims: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A job held under an exclusive, expiring lease. */
export interface LeasedJob<K extends JobKind = JobKind> extends Job<K> {
  leaseToken: string;
  leaseExpiresAt: number;
  /** Set when this claim took over an expired lease, i.e. the previous worker died or stalled. */
  reclaimedFrom: { owner: string | null; expiredAt: number } | null;
}

interface Row {
  id: string; tenant_id: string | null; kind: JobKind; dedupe_key: string; payload_json: string; status: JobStatus; priority: number;
  run_after: number; claim_count: number; max_claims: number; lease_owner: string | null; lease_token: string | null;
  lease_expires_at: number | null; last_error: string | null; created_at: number; updated_at: number;
}
const map = (r: Row): Job => ({
  id: r.id, tenantId: r.tenant_id, kind: r.kind, dedupeKey: r.dedupe_key, payload: JSON.parse(r.payload_json) as JobPayloads[JobKind],
  status: r.status, priority: r.priority, runAfter: r.run_after, claimCount: r.claim_count, maxClaims: r.max_claims,
  leaseOwner: r.lease_owner, leaseToken: r.lease_token, leaseExpiresAt: r.lease_expires_at, lastError: r.last_error,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Durable job queue on SQLite.
 *
 * Guarantees:
 * - A job is enqueued in the same transaction as the state that requires it (callers pass their db handle).
 * - At most one live (queued/leased) job per dedupe key.
 * - At most one worker holds a job at a time; every mutation is fenced by the lease token,
 *   so a worker that lost its lease (stall, GC pause, partition) cannot complete or reschedule.
 * - Expired leases are reclaimable, which is how work survives worker crashes and restarts.
 * - A job claimed `maxClaims` times without finishing is moved to `dead` (crash-loop protection).
 */
export class JobQueue {
  constructor(private db: AppDatabase, private clock: Clock) {}

  enqueue<K extends JobKind>(
    kind: K,
    payload: JobPayloads[K],
    opts: { dedupeKey: string; tenantId?: string | null; runAfter?: number; priority?: number; maxClaims?: number },
  ): { job: Job<K>; created: boolean } {
    const now = this.clock.now();
    const id = newId('job', now);
    const res = this.db
      .prepare(
        `INSERT INTO jobs (id, tenant_id, kind, dedupe_key, payload_json, status, priority, run_after, max_claims, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'leased') DO NOTHING`,
      )
      .run(id, opts.tenantId ?? null, kind, opts.dedupeKey, JSON.stringify(payload), opts.priority ?? 100, opts.runAfter ?? now, opts.maxClaims ?? 25, now, now);
    const job = res.changes === 1 ? this.get(id)! : this.liveByDedupeKey(opts.dedupeKey)!;
    return { job: job as Job<K>, created: res.changes === 1 };
  }

  get(id: string): Job | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return r && map(r);
  }

  liveByDedupeKey(dedupeKey: string): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'leased')").get(dedupeKey) as Row | undefined;
    return r && map(r);
  }

  /** Claims the next runnable job (queued and due, or leased with an expired lease). */
  claim(workerId: string, leaseMs: number, kinds?: JobKind[]): LeasedJob | null {
    return this.db.transaction((): LeasedJob | null => {
      const now = this.clock.now();
      const kindFilter = kinds?.length ? `AND kind IN (${kinds.map(() => '?').join(',')})` : '';
      const candidate = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE ((status = 'queued' AND run_after <= ?) OR (status = 'leased' AND lease_expires_at < ?)) ${kindFilter}
           ORDER BY priority, run_after, id LIMIT 1`,
        )
        .get(now, now, ...(kinds ?? [])) as Row | undefined;
      if (!candidate) return null;
      return this.leaseRow(candidate, workerId, leaseMs, now);
    }).immediate();
  }

  /** Claims a specific job if it is runnable now (used to process backfills inline). */
  claimById(jobId: string, workerId: string, leaseMs: number): LeasedJob | null {
    return this.db.transaction((): LeasedJob | null => {
      const now = this.clock.now();
      const r = this.db
        .prepare(`SELECT * FROM jobs WHERE id = ? AND ((status = 'queued' AND run_after <= ?) OR (status = 'leased' AND lease_expires_at < ?))`)
        .get(jobId, now, now) as Row | undefined;
      return r ? this.leaseRow(r, workerId, leaseMs, now) : null;
    }).immediate();
  }

  private leaseRow(r: Row, workerId: string, leaseMs: number, now: number): LeasedJob | null {
    const reclaimedFrom = r.status === 'leased' ? { owner: r.lease_owner, expiredAt: r.lease_expires_at! } : null;
    if (r.claim_count >= r.max_claims) {
      this.db
        .prepare(`UPDATE jobs SET status = 'dead', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`)
        .run(`exceeded ${r.max_claims} claims without completing (crash loop?)`, now, r.id);
      return null;
    }
    const token = randomBytes(16).toString('hex');
    this.db
      .prepare(
        `UPDATE jobs SET status = 'leased', lease_owner = ?, lease_token = ?, lease_expires_at = ?, claim_count = claim_count + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(workerId, token, now + leaseMs, now, r.id);
    const job = this.get(r.id)!;
    return { ...job, leaseToken: token, leaseExpiresAt: now + leaseMs, reclaimedFrom };
  }

  /** True while the caller still owns the lease. Checked before any externally visible commit. */
  holdsLease(jobId: string, leaseToken: string): boolean {
    const r = this.db
      .prepare("SELECT 1 FROM jobs WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at >= ?")
      .get(jobId, leaseToken, this.clock.now());
    return r !== undefined;
  }

  heartbeat(jobId: string, leaseToken: string, leaseMs: number): boolean {
    const now = this.clock.now();
    const res = this.db
      .prepare("UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at >= ?")
      .run(now + leaseMs, now, jobId, leaseToken, now);
    return res.changes === 1;
  }

  complete(jobId: string, leaseToken: string): boolean {
    return this.release(jobId, leaseToken, 'succeeded', null, null);
  }

  reschedule(jobId: string, leaseToken: string, runAfter: number, lastError: string | null): boolean {
    return this.release(jobId, leaseToken, 'queued', runAfter, lastError);
  }

  kill(jobId: string, leaseToken: string, error: string): boolean {
    return this.release(jobId, leaseToken, 'dead', null, error);
  }

  private release(jobId: string, leaseToken: string, status: JobStatus, runAfter: number | null, error: string | null): boolean {
    const now = this.clock.now();
    const res = this.db
      .prepare(
        `UPDATE jobs SET status = ?, run_after = coalesce(?, run_after), last_error = coalesce(?, last_error),
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'leased' AND lease_token = ?`,
      )
      .run(status, runAfter, error, now, jobId, leaseToken);
    return res.changes === 1;
  }

  /** Operator/automation cancel of a job that is not currently running. */
  cancelQueued(jobId: string): boolean {
    const res = this.db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'").run(this.clock.now(), jobId);
    return res.changes === 1;
  }

  stats(): Record<JobStatus, number> & { expiredLeases: number; due: number } {
    const now = this.clock.now();
    const out = { queued: 0, leased: 0, succeeded: 0, dead: 0, cancelled: 0, expiredLeases: 0, due: 0 };
    for (const r of this.db.prepare('SELECT status, count(*) AS n FROM jobs GROUP BY status').all() as Array<{ status: JobStatus; n: number }>) {
      out[r.status] = r.n;
    }
    out.expiredLeases = (this.db.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'leased' AND lease_expires_at < ?").get(now) as { n: number }).n;
    out.due = (this.db.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'queued' AND run_after <= ?").get(now) as { n: number }).n;
    return out;
  }

  list(filter: { status?: JobStatus; limit?: number } = {}): Job[] {
    const rows = filter.status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(filter.status, filter.limit ?? 100)
      : this.db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?').all(filter.limit ?? 100);
    return (rows as Row[]).map(map);
  }
}
