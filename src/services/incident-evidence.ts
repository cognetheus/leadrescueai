import type { Repositories } from '../db/repositories';
import type { FailureClass } from '../domain/failure';
import { severityFor, type IncidentKind, type IncidentStatus, type Severity } from '../domain/incident';
import type { RemediationAction } from '../domain/remediation';
import type { CrmClient } from '../integrations/crm';
import { redactString } from '../shared/redact';
import type { CredentialService } from './credentials';

/** Identifiers that may appear in assessments; anything else id-shaped is treated as fabricated. */
export const ID_PATTERN = /\b(?:inc|ine|dlv|att|job|evt|cor|rec|asm|scn|aud)_[0-9a-f]{12,}\b|\bct_[0-9a-f]{8,}\b/g;

export interface EvidenceBundle {
  incident: {
    ref: string;
    kind: IncidentKind;
    status: IncidentStatus;
    severity: Severity;
    title: string;
    failureClass: FailureClass | null;
    failureCode: string | null;
    tenant: string;
    openedAt: string;
    closedAt: string | null;
  };
  delivery: {
    ref: string;
    sourceLeadId: string;
    status: string;
    trigger: string;
    attemptCount: number;
    crmContactRef: string | null;
    receivedAt: string;
    deliveredAt: string | null;
    escalatedAt: string | null;
  } | null;
  timeline: Array<{ ref: string; type: string; message: string; at: string; attemptRef: string | null }>;
  attempts: Array<{
    ref: string;
    number: number;
    status: string;
    stageReached: string | null;
    workflowRunRef: string | null;
    failure: { failureClass: string; code: string; stage: string; httpStatus: number | null; message: string } | null;
    remediation: { action: RemediationAction; reason: string } | null;
  }>;
  credential: { status: string; version: number; lastRefreshedAt: string | null } | null;
  crm: { contactsWithExternalId: number; refs: string[] } | { unavailable: string } | null;
  /** Recovery actions the system actually performed, oldest first (deterministic, from the audit trail). */
  actionsPerformed: RemediationAction[];
  /** Every evidence reference an assessment may cite. */
  refs: string[];
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * Read-only evidence collection for incident analysis. Contact details never enter the
 * bundle (only identifiers and statuses), so neither prompts nor outputs can leak them.
 */
export class IncidentEvidenceService {
  constructor(private repos: Repositories, private crm: CrmClient, private credentials: CredentialService) {}

  async gather(incidentId: string, opts: { includeCrm?: boolean } = {}): Promise<EvidenceBundle | null> {
    const incident = this.repos.incidents.get(incidentId);
    if (!incident) return null;
    const tenant = this.repos.tenants.get(incident.tenantId)!;
    const d = incident.deliveryId ? this.repos.deliveries.get(incident.deliveryId) ?? null : null;
    const events = this.repos.incidents.events(incident.id);
    const attempts = d ? this.repos.attempts.forDelivery(d.id) : [];
    const cred = this.repos.credentials.describe(tenant.id, 'crm');

    const actionsPerformed: RemediationAction[] = attempts.filter((a) => a.remediation).map((a) => a.remediation!.action);
    if (incident.kind === 'lost_webhook' && events.some((e) => e.type === 'remediation_selected')) actionsPerformed.unshift('reconciliation_backfill');

    let crm: EvidenceBundle['crm'] = null;
    if (opts.includeCrm && d) {
      try {
        const contacts = await this.crm.findByExternalId(this.credentials.crmAccessToken(tenant.id), tenant.crmLocationId, d.sourceLeadId);
        crm = { contactsWithExternalId: contacts.length, refs: contacts.map((c) => c.id) };
      } catch (err) {
        crm = { unavailable: redactString((err as Error).message).slice(0, 200) };
      }
    }

    const bundle: EvidenceBundle = {
      incident: {
        ref: incident.id, kind: incident.kind, status: incident.status,
        severity: severityFor({ status: incident.status, failureClass: incident.failureClass, kind: incident.kind }),
        title: incident.title, failureClass: incident.failureClass, failureCode: incident.failureCode, tenant: tenant.slug,
        openedAt: iso(incident.openedAt)!, closedAt: iso(incident.closedAt),
      },
      delivery: d && {
        ref: d.id, sourceLeadId: d.sourceLeadId, status: d.status, trigger: d.trigger, attemptCount: d.attemptCount,
        crmContactRef: d.crmContactId, receivedAt: iso(d.receivedAt)!, deliveredAt: iso(d.deliveredAt), escalatedAt: iso(d.escalatedAt),
      },
      timeline: events.map((e) => ({ ref: e.id, type: e.type, message: redactString(e.message), at: iso(e.createdAt)!, attemptRef: e.attemptId })),
      attempts: attempts.map((a) => ({
        ref: a.id, number: a.attemptNumber, status: a.status, stageReached: a.stageReached, workflowRunRef: a.workflowRunId,
        failure: a.failure && { failureClass: a.failure.failureClass, code: a.failure.code, stage: a.failure.stage, httpStatus: a.failure.httpStatus ?? null, message: redactString(a.failure.message).slice(0, 300) },
        remediation: a.remediation && { action: a.remediation.action, reason: a.remediation.reason },
      })),
      credential: cred ? { status: cred.status, version: cred.version, lastRefreshedAt: iso(cred.lastRefreshedAt) } : null,
      crm,
      actionsPerformed,
      refs: [],
    };
    bundle.refs = collectRefs(bundle);
    return bundle;
  }
}

function collectRefs(b: EvidenceBundle): string[] {
  const refs = new Set<string>([b.incident.ref]);
  if (b.delivery) {
    refs.add(b.delivery.ref);
    if (b.delivery.crmContactRef) refs.add(b.delivery.crmContactRef);
  }
  for (const e of b.timeline) {
    refs.add(e.ref);
    for (const m of e.message.matchAll(ID_PATTERN)) refs.add(m[0]);
  }
  for (const a of b.attempts) {
    refs.add(a.ref);
    if (a.workflowRunRef) refs.add(a.workflowRunRef);
  }
  if (b.crm && 'refs' in b.crm) b.crm.refs.forEach((r) => refs.add(r));
  return [...refs];
}
