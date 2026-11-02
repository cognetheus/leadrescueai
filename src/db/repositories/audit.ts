import type { AppDatabase } from '../connection';
import type { Clock } from '../../shared/clock';
import { newId } from '../../shared/ids';
import { redact } from '../../shared/redact';

export interface AuditEvent {
  id: string;
  tenantId: string | null;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  correlationId: string | null;
  data: Record<string, unknown> | null;
  createdAt: number;
}

interface Row {
  id: string; tenant_id: string | null; actor: string; action: string; entity_type: string; entity_id: string;
  correlation_id: string | null; data_json: string | null; created_at: number;
}
const map = (r: Row): AuditEvent => ({
  id: r.id, tenantId: r.tenant_id, actor: r.actor, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
  correlationId: r.correlation_id, data: r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : null, createdAt: r.created_at,
});

/** Append-only audit trail (UPDATE/DELETE are rejected by triggers). Data is redacted on write. */
export class AuditRepository {
  constructor(private db: AppDatabase, private clock: Clock) {}

  record(e: { tenantId?: string | null; actor: string; action: string; entityType: string; entityId: string; correlationId?: string | null; data?: Record<string, unknown> }): string {
    const id = newId('aud');
    this.db
      .prepare('INSERT INTO audit_events (id, tenant_id, actor, action, entity_type, entity_id, correlation_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, e.tenantId ?? null, e.actor, e.action, e.entityType, e.entityId, e.correlationId ?? null, e.data ? JSON.stringify(redact(e.data)) : null, this.clock.now());
    return id;
  }

  forEntity(entityType: string, entityId: string): AuditEvent[] {
    return (this.db.prepare('SELECT * FROM audit_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at, id').all(entityType, entityId) as Row[]).map(map);
  }

  forCorrelation(correlationId: string): AuditEvent[] {
    return (this.db.prepare('SELECT * FROM audit_events WHERE correlation_id = ? ORDER BY created_at, id').all(correlationId) as Row[]).map(map);
  }

  recent(limit = 100, tenantId?: string): AuditEvent[] {
    const rows = tenantId
      ? this.db.prepare('SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(tenantId, limit)
      : this.db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
    return (rows as Row[]).map(map);
  }
}
