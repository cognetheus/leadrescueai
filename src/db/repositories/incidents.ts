import type { AppDatabase } from '../connection';
import type { Clock } from '../../shared/clock';
import { newId } from '../../shared/ids';
import { redact } from '../../shared/redact';
import type { IncidentEventType, IncidentKind, IncidentStatus, Severity } from '../../domain/incident';
import type { FailureClass } from '../../domain/failure';
import type { IncidentAssessment, PolicyDecision, StoredAssessment } from '../../domain/assessment';

export interface Incident {
  id: string;
  tenantId: string;
  deliveryId: string | null;
  kind: IncidentKind;
  status: IncidentStatus;
  severity: Severity;
  title: string;
  failureClass: FailureClass | null;
  failureCode: string | null;
  correlationId: string;
  openedAt: number;
  closedAt: number | null;
  updatedAt: number;
}

export interface IncidentEvent {
  id: string;
  incidentId: string;
  type: IncidentEventType;
  message: string;
  attemptId: string | null;
  data: Record<string, unknown> | null;
  createdAt: number;
}

interface Row {
  id: string; tenant_id: string; delivery_id: string | null; kind: IncidentKind; status: IncidentStatus; severity: Severity;
  title: string; failure_class: FailureClass | null; failure_code: string | null; correlation_id: string;
  opened_at: number; closed_at: number | null; updated_at: number;
}
const map = (r: Row): Incident => ({
  id: r.id, tenantId: r.tenant_id, deliveryId: r.delivery_id, kind: r.kind, status: r.status, severity: r.severity,
  title: r.title, failureClass: r.failure_class, failureCode: r.failure_code, correlationId: r.correlation_id,
  openedAt: r.opened_at, closedAt: r.closed_at, updatedAt: r.updated_at,
});

export class IncidentRepository {
  constructor(private db: AppDatabase, private clock: Clock) {}

  /** Returns the open incident for a delivery, or opens one. Repeated failures share a timeline. */
  openForDelivery(input: {
    tenantId: string; deliveryId: string; kind: IncidentKind; title: string; severity: Severity;
    failureClass: FailureClass | null; failureCode: string | null; correlationId: string;
  }): { incident: Incident; created: boolean } {
    const existing = this.openIncidentForDelivery(input.deliveryId);
    if (existing) {
      this.db.prepare('UPDATE incidents SET failure_class = ?, failure_code = ?, updated_at = ? WHERE id = ?')
        .run(input.failureClass, input.failureCode, this.clock.now(), existing.id);
      return { incident: this.get(existing.id)!, created: false };
    }
    return { incident: this.create(input), created: true };
  }

  create(input: {
    tenantId: string; deliveryId: string | null; kind: IncidentKind; title: string; severity: Severity;
    failureClass: FailureClass | null; failureCode: string | null; correlationId: string; status?: IncidentStatus;
  }): Incident {
    const now = this.clock.now();
    const id = newId('inc', now);
    const status = input.status ?? 'open';
    this.db
      .prepare(
        `INSERT INTO incidents (id, tenant_id, delivery_id, kind, status, severity, title, failure_class, failure_code, correlation_id, opened_at, closed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.tenantId, input.deliveryId, input.kind, status, input.severity, input.title, input.failureClass, input.failureCode,
        input.correlationId, now, status === 'open' ? null : now, now);
    return this.get(id)!;
  }

  openIncidentForDelivery(deliveryId: string): Incident | undefined {
    const r = this.db.prepare("SELECT * FROM incidents WHERE delivery_id = ? AND status = 'open'").get(deliveryId) as Row | undefined;
    return r && map(r);
  }

  close(id: string, status: Exclude<IncidentStatus, 'open'>, severity: Severity): Incident {
    const now = this.clock.now();
    this.db.prepare("UPDATE incidents SET status = ?, severity = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'")
      .run(status, severity, now, now, id);
    return this.get(id)!;
  }

  /** Operator acknowledgement of an escalated incident after manual remediation. */
  markResolved(id: string): Incident {
    const now = this.clock.now();
    this.db.prepare("UPDATE incidents SET status = 'resolved', updated_at = ? WHERE id = ? AND status = 'escalated'").run(now, id);
    return this.get(id)!;
  }

  get(id: string): Incident | undefined {
    const r = this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as Row | undefined;
    return r && map(r);
  }

  forDelivery(deliveryId: string): Incident[] {
    return (this.db.prepare('SELECT * FROM incidents WHERE delivery_id = ? ORDER BY opened_at').all(deliveryId) as Row[]).map(map);
  }

  list(filter: { tenantId?: string; status?: IncidentStatus; limit?: number } = {}): Incident[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.tenantId) { where.push('tenant_id = ?'); args.push(filter.tenantId); }
    if (filter.status) { where.push('status = ?'); args.push(filter.status); }
    const sql = `SELECT * FROM incidents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY opened_at DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, filter.limit ?? 100) as Row[]).map(map);
  }

  appendEvent(e: { incidentId: string; tenantId: string; type: IncidentEventType; message: string; attemptId?: string | null; data?: Record<string, unknown> }): string {
    const id = newId('ine');
    this.db
      .prepare('INSERT INTO incident_events (id, incident_id, tenant_id, type, message, attempt_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, e.incidentId, e.tenantId, e.type, e.message, e.attemptId ?? null, e.data ? JSON.stringify(redact(e.data)) : null, this.clock.now());
    this.db.prepare('UPDATE incidents SET updated_at = ? WHERE id = ?').run(this.clock.now(), e.incidentId);
    return id;
  }

  events(incidentId: string): IncidentEvent[] {
    const rows = this.db
      .prepare('SELECT id, incident_id, type, message, attempt_id, data_json, created_at FROM incident_events WHERE incident_id = ? ORDER BY created_at, rowid')
      .all(incidentId) as Array<{ id: string; incident_id: string; type: IncidentEventType; message: string; attempt_id: string | null; data_json: string | null; created_at: number }>;
    return rows.map((r) => ({
      id: r.id, incidentId: r.incident_id, type: r.type, message: r.message, attemptId: r.attempt_id,
      data: r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : null, createdAt: r.created_at,
    }));
  }

  saveAssessment(a: { incidentId: string; source: 'ai' | 'fallback'; model: string | null; assessment: IncidentAssessment; policy: PolicyDecision; validationIssues: string[]; latencyMs: number }): StoredAssessment {
    const now = this.clock.now();
    const id = newId('asm', now);
    this.db
      .prepare(
        `INSERT INTO incident_assessments (id, incident_id, source, model, assessment_json, policy_json, validation_issues_json, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, a.incidentId, a.source, a.model, JSON.stringify(a.assessment), JSON.stringify(a.policy), JSON.stringify(a.validationIssues), a.latencyMs, now);
    return { id, ...a, createdAt: new Date(now).toISOString() };
  }

  assessments(incidentId: string): StoredAssessment[] {
    const rows = this.db.prepare('SELECT * FROM incident_assessments WHERE incident_id = ? ORDER BY created_at, rowid').all(incidentId) as Array<{
      id: string; incident_id: string; source: 'ai' | 'fallback'; model: string | null; assessment_json: string; policy_json: string;
      validation_issues_json: string; latency_ms: number; created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id, incidentId: r.incident_id, source: r.source, model: r.model,
      assessment: JSON.parse(r.assessment_json) as IncidentAssessment, policy: JSON.parse(r.policy_json) as PolicyDecision,
      validationIssues: JSON.parse(r.validation_issues_json) as string[], latencyMs: r.latency_ms, createdAt: new Date(r.created_at).toISOString(),
    }));
  }
}
