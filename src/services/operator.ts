import type { AppDatabase } from '../db/connection';
import type { Repositories } from '../db/repositories';
import type { Delivery } from '../db/repositories/deliveries';
import type { JobQueue } from '../jobs/queue';
import type { Clock } from '../shared/clock';

export class OperatorActionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'OperatorActionError';
  }
}

/**
 * Human-in-the-loop actions for escalated work. Replays reuse the normal delivery path
 * (idempotency, read-before-write, verification) and are fully audited.
 */
export class OperatorService {
  constructor(private deps: { db: AppDatabase; repos: Repositories; queue: JobQueue; clock: Clock; deadlineMs: number; onEnqueued: () => void }) {}

  replayDelivery(deliveryId: string, actor: string, note?: string): Delivery {
    const { repos, db, queue } = this.deps;
    const result = db.transaction(() => {
      const d = repos.deliveries.get(deliveryId);
      if (!d) throw new OperatorActionError('delivery not found', 404);
      if (d.status !== 'escalated') throw new OperatorActionError(`only escalated deliveries can be replayed (status: ${d.status})`, 409);
      const cred = repos.credentials.describe(d.tenantId, 'crm');
      if (cred?.status === 'revoked') throw new OperatorActionError('CRM connection is revoked; re-authorize it before replaying', 409);
      const replayed = repos.deliveries.transition(d.id, ['escalated'], 'pending', { nextAttemptAt: null });
      repos.deliveries.extendDeadline(d.id, this.deps.clock.now() + this.deps.deadlineMs);
      queue.enqueue('deliver_lead', { deliveryId: d.id, correlationId: d.correlationId }, { dedupeKey: `deliver:${d.id}`, tenantId: d.tenantId });
      for (const incident of repos.incidents.forDelivery(d.id).filter((i) => i.status === 'escalated')) {
        repos.incidents.appendEvent({ incidentId: incident.id, tenantId: d.tenantId, type: 'operator_action', message: `Delivery replayed by ${actor}${note ? `: ${note}` : ''}`, data: { action: 'replay_delivery' } });
      }
      repos.audit.record({ tenantId: d.tenantId, actor, action: 'operator.replay_delivery', entityType: 'delivery', entityId: d.id, correlationId: d.correlationId, data: { note: note ?? null } });
      return replayed;
    }).immediate();
    this.deps.onEnqueued();
    return result;
  }

  resolveIncident(incidentId: string, actor: string, note: string) {
    const { repos } = this.deps;
    const incident = repos.incidents.get(incidentId);
    if (!incident) throw new OperatorActionError('incident not found', 404);
    if (incident.status !== 'escalated') throw new OperatorActionError(`only escalated incidents can be resolved (status: ${incident.status})`, 409);
    repos.incidents.appendEvent({ incidentId, tenantId: incident.tenantId, type: 'operator_action', message: `Resolved by ${actor}: ${note}`, data: { action: 'resolve' } });
    repos.audit.record({ tenantId: incident.tenantId, actor, action: 'operator.resolve_incident', entityType: 'incident', entityId: incidentId, data: { note } });
    return repos.incidents.markResolved(incidentId);
  }
}
