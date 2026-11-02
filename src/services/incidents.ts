import type { Repositories } from '../db/repositories';
import type { DeliveryAttempt } from '../db/repositories/deliveries';
import type { Incident } from '../db/repositories/incidents';
import type { FailureEvidence } from '../domain/failure';
import { severityFor, type IncidentEventType } from '../domain/incident';
import type { RemediationDecision } from '../domain/remediation';
import type { JobQueue } from '../jobs/queue';
import type { AttemptContext } from './delivery-pipeline';

/**
 * Incident lifecycle bookkeeping. One open incident per delivery collects the whole
 * failure → remediation → verification timeline as append-only events.
 */
export class IncidentService {
  constructor(private repos: Repositories, private queue: JobQueue, private opts: { assessRecovered: boolean }) {}

  openFor(ctx: AttemptContext, failure: Pick<FailureEvidence, 'failureClass' | 'code' | 'message'>): Incident {
    const { incident, created } = this.repos.incidents.openForDelivery({
      tenantId: ctx.tenant.id, deliveryId: ctx.delivery.id, kind: 'delivery_failure',
      title: `Lead ${ctx.delivery.sourceLeadId} delivery failing: ${failure.code}`,
      severity: 'medium', failureClass: failure.failureClass, failureCode: failure.code, correlationId: ctx.delivery.correlationId,
    });
    if (created) this.event(incident, 'detected', `Delivery failure detected: ${failure.message}`, ctx.attempt.id, { code: failure.code });
    return incident;
  }

  event(incident: Incident, type: IncidentEventType, message: string, attemptId: string | null, data?: Record<string, unknown>): void {
    this.repos.incidents.appendEvent({ incidentId: incident.id, tenantId: incident.tenantId, type, message, attemptId, ...(data ? { data } : {}) });
  }

  recordFailure(ctx: AttemptContext, failure: FailureEvidence, decision: RemediationDecision): Incident {
    const incident = this.openFor(ctx, failure);
    this.event(incident, 'classified', `Attempt ${ctx.attempt.attemptNumber} failed at ${failure.stage}: ${failure.failureClass}/${failure.code}`, ctx.attempt.id, {
      failureClass: failure.failureClass, code: failure.code, stage: failure.stage, httpStatus: failure.httpStatus ?? null,
    });
    this.event(incident, 'remediation_selected', `Selected ${decision.action}: ${decision.reason}`, ctx.attempt.id, {
      action: decision.action, retryAt: decision.retryAt ?? null, limits: decision.limits,
    });
    return incident;
  }

  recordInterruption(ctx: AttemptContext, interrupted: DeliveryAttempt[]): void {
    const incident = this.openFor(ctx, { failureClass: 'transient', code: 'worker_interrupted', message: 'A worker stopped mid-delivery' });
    for (const a of interrupted) {
      this.event(incident, 'worker_interrupted', `Attempt ${a.attemptNumber} on ${a.workerId ?? 'unknown worker'} was interrupted at stage ${a.stageReached ?? 'start'}; lease expired and the job was reclaimed`, a.id, {
        stageReached: a.stageReached, workerId: a.workerId,
      });
    }
  }

  /** Called after a verified delivery: closes the open incident (if any) as recovered. */
  recordRecoveryIfOpen(ctx: AttemptContext, contactId: string, workflowRunId: string): void {
    const incident = this.repos.incidents.openIncidentForDelivery(ctx.delivery.id);
    if (!incident) return;
    this.event(incident, 'verification_passed', `CRM contact ${contactId} read back and verified on attempt ${ctx.attempt.attemptNumber}`, ctx.attempt.id, { contactId, workflowRunId });
    this.event(incident, 'recovered', `Lead delivered after ${ctx.attempt.attemptNumber} attempts without operator involvement`, ctx.attempt.id);
    const closed = this.repos.incidents.close(incident.id, 'recovered', severityFor({ status: 'recovered', failureClass: incident.failureClass, kind: incident.kind }));
    if (this.opts.assessRecovered) this.requestAssessment(closed);
  }

  escalate(ctx: AttemptContext, failure: FailureEvidence, reason: string): Incident {
    const incident = this.openFor(ctx, failure);
    this.event(incident, 'escalated', `Escalated to an operator: ${reason}`, ctx.attempt.id, { failureClass: failure.failureClass, code: failure.code });
    const closed = this.repos.incidents.close(incident.id, 'escalated', severityFor({ status: 'escalated', failureClass: failure.failureClass, kind: incident.kind }));
    this.requestAssessment(closed);
    return closed;
  }

  /** Incident analysis runs asynchronously so delivery never waits on (or fails because of) the LLM. */
  requestAssessment(incident: Incident): void {
    this.queue.enqueue('analyze_incident', { incidentId: incident.id, correlationId: incident.correlationId }, {
      dedupeKey: `analyze:${incident.id}`, tenantId: incident.tenantId, priority: 200, maxClaims: 3,
    });
  }
}
