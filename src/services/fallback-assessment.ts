import type { IncidentAssessment } from '../domain/assessment';
import { allowedOperatorActions } from './action-policy';
import { expectedOutcome } from './assessment-validator';
import type { EvidenceBundle } from './incident-evidence';

/** Known failure codes → plain-language hypotheses (deterministic, no LLM). */
const HYPOTHESES: Array<[RegExp, string]> = [
  [/_unavailable$|_http_5\d\d$|_timeout$|_network$/, 'The CRM or lead source API was temporarily unavailable.'],
  [/_rate_limited$/, 'The CRM rate-limited requests for this tenant.'],
  [/outcome_unknown$/, 'The CRM accepted the write but the response did not arrive in time, leaving the outcome ambiguous.'],
  [/access_token_(expired|rejected)$/, 'The stored CRM access token had expired.'],
  [/refresh_grant_revoked$|credentials_revoked$|client_credentials_invalid$/, 'The CRM connection was revoked (for example the app was uninstalled or re-authorized elsewhere).'],
  [/^source_lead_invalid$/, 'The lead was submitted at the source without the required contact information.'],
  [/verification_mismatch$/, 'The CRM returned data different from what was written (inconsistent or stale reads).'],
  [/duplicate_contacts_detected$/, 'The CRM already holds several contacts for this lead, so the system refused to choose one.'],
  [/^webhook_not_received$/, 'The advertising platform never delivered the webhook for this lead.'],
  [/worker_interrupted$/, 'A worker stopped mid-delivery; its lease expired and the work was resumed by another worker.'],
];

export function buildFallbackAssessment(b: EvidenceBundle, reason: string): IncidentAssessment {
  const code = b.attempts.findLast((a) => a.failure)?.failure?.code ?? b.incident.failureCode ?? '';
  const hypothesis = HYPOTHESES.find(([re]) => re.test(code))?.[1] ?? 'The root cause could not be determined automatically from the recorded evidence.';
  const failedAttempts = b.attempts.filter((a) => a.failure);
  const facts: IncidentAssessment['observedFacts'] = [
    { statement: `Incident ${b.incident.ref} (${b.incident.kind}) is ${b.incident.status}.`, evidenceRefs: [b.incident.ref] },
  ];
  for (const a of failedAttempts.slice(0, 6)) {
    facts.push({
      statement: `Attempt ${a.number} failed at ${a.failure!.stage} with ${a.failure!.failureClass}/${a.failure!.code}${a.failure!.httpStatus ? ` (HTTP ${a.failure!.httpStatus})` : ''}; system chose ${a.remediation?.action ?? 'no action'}.`,
      evidenceRefs: [a.ref],
    });
  }
  const terminal = b.timeline.findLast((e) => e.type === 'recovered' || e.type === 'escalated');
  if (terminal) facts.push({ statement: terminal.message.slice(0, 290), evidenceRefs: [terminal.ref] });
  const action = allowedOperatorActions(b)[0]!;
  const instructions: Record<string, string> = {
    no_action_required: 'Recovered automatically and verified in the CRM. No action required.',
    monitor: 'Watch for repeats of this failure for the tenant; no immediate action is required.',
    reauthorize_crm_connection: 'Re-authorize the CRM connection for this tenant, then replay the escalated deliveries from the dashboard.',
    correct_source_lead_data: 'Obtain the missing contact details from the lead source or the customer; do not create the CRM contact with guessed data.',
    investigate_crm_data_consistency: 'Inspect the CRM record(s) for this lead, confirm which data is correct, then resolve or replay the delivery.',
    replay_delivery: 'Confirm the provider is healthy, then replay the delivery; the pipeline is idempotent and will not duplicate the contact.',
    contact_provider_support: 'Contact the provider with the recorded error codes and timestamps.',
  };
  return {
    incidentId: b.incident.ref,
    observedFacts: facts.slice(0, 10),
    rootCauseHypothesis: { statement: hypothesis, confidence: HYPOTHESES.some(([re]) => re.test(code)) ? 'medium' : 'low', evidenceRefs: [failedAttempts.at(-1)?.ref ?? b.incident.ref] },
    recoveryActionsPerformed: [...b.actionsPerformed],
    recoveryOutcome: expectedOutcome(b),
    suggestedAction: action,
    severity: b.incident.severity,
    requiresHuman: b.incident.status === 'escalated',
    operatorInstructions: `${instructions[action]} (Deterministic assessment: ${reason}.)`.slice(0, 700),
  };
}
