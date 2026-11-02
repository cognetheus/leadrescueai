import type { AppDatabase } from '../connection';
import type { Clock } from '../../shared/clock';
import { newId } from '../../shared/ids';
import { assertTransition, type AttemptOutcome, type DeliveryStatus, type DeliveryTrigger, type LeadSource } from '../../domain/delivery';
import type { FailureClass, FailureEvidence, PipelineStage } from '../../domain/failure';
import type { RemediationDecision } from '../../domain/remediation';

export interface Delivery {
  id: string;
  tenantId: string;
  source: LeadSource;
  sourceLeadId: string;
  status: DeliveryStatus;
  trigger: DeliveryTrigger;
  firstEventId: string | null;
  correlationId: string;
  crmContactId: string | null;
  attemptCount: number;
  lastFailureClass: FailureClass | null;
  lastFailureCode: string | null;
  nextAttemptAt: number | null;
  deadlineAt: number;
  receivedAt: number;
  deliveredAt: number | null;
  escalatedAt: number | null;
  updatedAt: number;
}

interface Row {
  id: string; tenant_id: string; source: LeadSource; source_lead_id: string; status: DeliveryStatus; trigger: DeliveryTrigger;
  first_event_id: string | null; correlation_id: string; crm_contact_id: string | null; attempt_count: number;
  last_failure_class: FailureClass | null; last_failure_code: string | null; next_attempt_at: number | null; deadline_at: number;
  received_at: number; delivered_at: number | null; escalated_at: number | null; updated_at: number;
}
const map = (r: Row): Delivery => ({
  id: r.id, tenantId: r.tenant_id, source: r.source, sourceLeadId: r.source_lead_id, status: r.status, trigger: r.trigger,
  firstEventId: r.first_event_id, correlationId: r.correlation_id, crmContactId: r.crm_contact_id, attemptCount: r.attempt_count,
  lastFailureClass: r.last_failure_class, lastFailureCode: r.last_failure_code, nextAttemptAt: r.next_attempt_at,
  deadlineAt: r.deadline_at, receivedAt: r.received_at, deliveredAt: r.delivered_at, escalatedAt: r.escalated_at, updatedAt: r.updated_at,
});

export class StaleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleStateError';
  }
}

export interface DeliveryFilter {
  tenantId?: string;
  status?: DeliveryStatus;
  limit?: number;
}

export class DeliveryRepository {
  constructor(private db: AppDatabase, private clock: Clock) {}

  /**
   * Idempotent creation keyed by (tenant, source, source lead id). Returns the existing
   * delivery when the lead was already seen (duplicate webhook or reconciliation overlap).
   */
  insertIfAbsent(input: {
    tenantId: string; source: LeadSource; sourceLeadId: string; trigger: DeliveryTrigger;
    firstEventId: string | null; correlationId: string; deadlineMs: number;
  }): { delivery: Delivery; created: boolean } {
    const now = this.clock.now();
    const id = newId('dlv', now);
    const res = this.db
      .prepare(
        `INSERT INTO deliveries (id, tenant_id, source, source_lead_id, status, trigger, first_event_id, correlation_id, deadline_at, received_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, source, source_lead_id) DO NOTHING`,
      )
      .run(id, input.tenantId, input.source, input.sourceLeadId, input.trigger, input.firstEventId, input.correlationId, now + input.deadlineMs, now, now);
    const delivery = this.getByLead(input.tenantId, input.source, input.sourceLeadId)!;
    return { delivery, created: res.changes === 1 };
  }

  get(id: string): Delivery | undefined {
    const r = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as Row | undefined;
    return r && map(r);
  }

  getByLead(tenantId: string, source: LeadSource, sourceLeadId: string): Delivery | undefined {
    const r = this.db.prepare('SELECT * FROM deliveries WHERE tenant_id = ? AND source = ? AND source_lead_id = ?').get(tenantId, source, sourceLeadId) as Row | undefined;
    return r && map(r);
  }

  /** Bulk lookup used by reconciliation to compare a page of source leads. */
  getManyByLead(tenantId: string, source: LeadSource, sourceLeadIds: string[]): Map<string, Delivery> {
    if (!sourceLeadIds.length) return new Map();
    const placeholders = sourceLeadIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM deliveries WHERE tenant_id = ? AND source = ? AND source_lead_id IN (${placeholders})`)
      .all(tenantId, source, ...sourceLeadIds) as Row[];
    return new Map(rows.map((r) => [r.source_lead_id, map(r)]));
  }

  list(filter: DeliveryFilter = {}): Delivery[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.tenantId) { where.push('tenant_id = ?'); args.push(filter.tenantId); }
    if (filter.status) { where.push('status = ?'); args.push(filter.status); }
    const sql = `SELECT * FROM deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_at DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, filter.limit ?? 100) as Row[]).map(map);
  }

  countByStatus(): Record<DeliveryStatus, number> {
    const out = { pending: 0, processing: 0, retry_scheduled: 0, delivered: 0, escalated: 0 } as Record<DeliveryStatus, number>;
    for (const r of this.db.prepare('SELECT status, count(*) AS n FROM deliveries GROUP BY status').all() as Array<{ status: DeliveryStatus; n: number }>) {
      out[r.status] = r.n;
    }
    return out;
  }

  /**
   * Compare-and-set status change. Fails with StaleStateError when the row is no longer
   * in one of the expected states (another worker or operator changed it first).
   */
  transition(
    id: string,
    expectedFrom: DeliveryStatus[],
    to: DeliveryStatus,
    patch: Partial<Pick<Delivery, 'crmContactId' | 'lastFailureClass' | 'lastFailureCode' | 'nextAttemptAt' | 'attemptCount'>> = {},
  ): Delivery {
    for (const from of expectedFrom) assertTransition(from, to);
    const now = this.clock.now();
    const sets = ['status = ?', 'updated_at = ?'];
    const args: unknown[] = [to, now];
    const columns: Record<string, string> = {
      crmContactId: 'crm_contact_id', lastFailureClass: 'last_failure_class', lastFailureCode: 'last_failure_code',
      nextAttemptAt: 'next_attempt_at', attemptCount: 'attempt_count',
    };
    for (const [key, col] of Object.entries(columns)) {
      if (key in patch) { sets.push(`${col} = ?`); args.push((patch as Record<string, unknown>)[key] ?? null); }
    }
    if (to === 'delivered') { sets.push('delivered_at = ?', 'next_attempt_at = NULL'); args.push(now); }
    if (to === 'escalated') { sets.push('escalated_at = ?', 'next_attempt_at = NULL'); args.push(now); }
    if (to === 'pending') { sets.push('escalated_at = NULL'); }
    const placeholders = expectedFrom.map(() => '?').join(',');
    const res = this.db
      .prepare(`UPDATE deliveries SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`)
      .run(...args, id, ...expectedFrom);
    if (res.changes !== 1) {
      const current = this.get(id);
      throw new StaleStateError(`Delivery ${id} is ${current?.status ?? 'missing'}, expected ${expectedFrom.join('|')}`);
    }
    return this.get(id)!;
  }

  /** Records which CRM contact belongs to this delivery before verification completes. */
  recordContact(id: string, crmContactId: string): void {
    this.db.prepare('UPDATE deliveries SET crm_contact_id = ?, updated_at = ? WHERE id = ? AND (crm_contact_id IS NULL OR crm_contact_id = ?)')
      .run(crmContactId, this.clock.now(), id, crmContactId);
  }

  extendDeadline(id: string, deadlineAt: number): void {
    this.db.prepare('UPDATE deliveries SET deadline_at = ?, updated_at = ? WHERE id = ?').run(deadlineAt, this.clock.now(), id);
  }
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  tenantId: string;
  attemptNumber: number;
  jobId: string | null;
  leaseToken: string | null;
  workerId: string | null;
  workflowRunId: string | null;
  status: AttemptOutcome;
  stageReached: PipelineStage | null;
  failure: FailureEvidence | null;
  remediation: RemediationDecision | null;
  startedAt: number;
  finishedAt: number | null;
}

interface AttemptRow {
  id: string; delivery_id: string; tenant_id: string; attempt_number: number; job_id: string | null; lease_token: string | null;
  worker_id: string | null; workflow_run_id: string | null; status: AttemptOutcome; stage_reached: PipelineStage | null;
  failure_json: string | null; remediation_json: string | null; started_at: number; finished_at: number | null;
}
const mapAttempt = (r: AttemptRow): DeliveryAttempt => ({
  id: r.id, deliveryId: r.delivery_id, tenantId: r.tenant_id, attemptNumber: r.attempt_number, jobId: r.job_id,
  leaseToken: r.lease_token, workerId: r.worker_id, workflowRunId: r.workflow_run_id, status: r.status, stageReached: r.stage_reached,
  failure: r.failure_json ? (JSON.parse(r.failure_json) as FailureEvidence) : null,
  remediation: r.remediation_json ? (JSON.parse(r.remediation_json) as RemediationDecision) : null,
  startedAt: r.started_at, finishedAt: r.finished_at,
});

/** Attempt history. Rows are immutable once finished (enforced by trigger). */
export class AttemptRepository {
  constructor(private db: AppDatabase, private clock: Clock) {}

  start(input: { deliveryId: string; tenantId: string; jobId: string | null; leaseToken: string | null; workerId: string | null }): DeliveryAttempt {
    const now = this.clock.now();
    const id = newId('att', now);
    const next = (this.db.prepare('SELECT coalesce(max(attempt_number), 0) + 1 AS n FROM delivery_attempts WHERE delivery_id = ?').get(input.deliveryId) as { n: number }).n;
    this.db
      .prepare(
        `INSERT INTO delivery_attempts (id, delivery_id, tenant_id, attempt_number, job_id, lease_token, worker_id, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(id, input.deliveryId, input.tenantId, next, input.jobId, input.leaseToken, input.workerId, now);
    return this.get(id)!;
  }

  setWorkflowRun(id: string, runId: string): void {
    this.db.prepare("UPDATE delivery_attempts SET workflow_run_id = ? WHERE id = ? AND status = 'running'").run(runId, id);
  }

  setStage(id: string, stage: PipelineStage): void {
    this.db.prepare("UPDATE delivery_attempts SET stage_reached = ? WHERE id = ? AND status = 'running'").run(stage, id);
  }

  finish(id: string, status: Exclude<AttemptOutcome, 'running'>, failure?: FailureEvidence | null, remediation?: RemediationDecision | null): boolean {
    const res = this.db
      .prepare("UPDATE delivery_attempts SET status = ?, failure_json = ?, remediation_json = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .run(status, failure ? JSON.stringify(failure) : null, remediation ? JSON.stringify(remediation) : null, this.clock.now(), id);
    return res.changes === 1;
  }

  get(id: string): DeliveryAttempt | undefined {
    const r = this.db.prepare('SELECT * FROM delivery_attempts WHERE id = ?').get(id) as AttemptRow | undefined;
    return r && mapAttempt(r);
  }

  forDelivery(deliveryId: string): DeliveryAttempt[] {
    return (this.db.prepare('SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number').all(deliveryId) as AttemptRow[]).map(mapAttempt);
  }

  running(deliveryId: string): DeliveryAttempt[] {
    return (this.db.prepare("SELECT * FROM delivery_attempts WHERE delivery_id = ? AND status = 'running' ORDER BY attempt_number").all(deliveryId) as AttemptRow[]).map(mapAttempt);
  }
}

export interface WebhookEventRecord {
  id: string; tenantId: string; source: string; bodySha256: string; leadCount: number; newDeliveries: number;
  duplicates: number; correlationId: string; receivedAt: number;
}

export class WebhookEventRepository {
  constructor(private db: AppDatabase) {}

  insert(e: WebhookEventRecord & { payload: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO webhook_events (id, tenant_id, source, body_sha256, payload_json, lead_count, new_deliveries, duplicates, correlation_id, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.tenantId, e.source, e.bodySha256, JSON.stringify(e.payload), e.leadCount, e.newDeliveries, e.duplicates, e.correlationId, e.receivedAt);
  }

  updateCounts(id: string, newDeliveries: number, duplicates: number): void {
    this.db.prepare('UPDATE webhook_events SET new_deliveries = ?, duplicates = ? WHERE id = ?').run(newDeliveries, duplicates, id);
  }

  recent(limit = 50): WebhookEventRecord[] {
    return this.db
      .prepare(
        `SELECT id, tenant_id AS tenantId, source, body_sha256 AS bodySha256, lead_count AS leadCount, new_deliveries AS newDeliveries,
                duplicates, correlation_id AS correlationId, received_at AS receivedAt FROM webhook_events ORDER BY received_at DESC LIMIT ?`,
      )
      .all(limit) as WebhookEventRecord[];
  }
}
