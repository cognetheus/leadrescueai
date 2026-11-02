import { IncidentAssessmentSchema, type IncidentAssessment } from '../domain/assessment';
import { ID_PATTERN, type EvidenceBundle } from './incident-evidence';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;

export interface ValidationResult {
  /** Usable assessment (possibly corrected), or null when the output must be discarded. */
  assessment: IncidentAssessment | null;
  issues: string[];
  critical: boolean;
}

export function expectedOutcome(b: EvidenceBundle): IncidentAssessment['recoveryOutcome'] {
  return b.incident.status === 'recovered' || b.incident.status === 'resolved' ? 'recovered' : b.incident.status === 'escalated' ? 'escalated' : 'in_progress';
}

/**
 * Hallucination protection. Critical violations (schema, unknown evidence, invented
 * identifiers, contact data, wrong incident) discard the output. Facts the system already
 * knows deterministically are corrected to the recorded truth and the discrepancy is kept.
 */
export function validateAssessment(raw: unknown, b: EvidenceBundle): ValidationResult {
  const parsed = IncidentAssessmentSchema.safeParse(raw);
  if (!parsed.success) {
    return { assessment: null, critical: true, issues: parsed.error.issues.slice(0, 8).map((i) => `schema: ${i.path.join('.') || '(root)'} ${i.message}`) };
  }
  const a = structuredClone(parsed.data);
  const issues: string[] = [];
  const critical: string[] = [];
  const known = new Set(b.refs);

  if (a.incidentId !== b.incident.ref) critical.push(`incidentId ${a.incidentId} does not match ${b.incident.ref}`);

  const cited = [...a.observedFacts.flatMap((f) => f.evidenceRefs), ...a.rootCauseHypothesis.evidenceRefs];
  for (const ref of cited) if (!known.has(ref)) critical.push(`cites unknown evidence ref "${ref}"`);

  const text = [...a.observedFacts.map((f) => f.statement), a.rootCauseHypothesis.statement, a.operatorInstructions].join('\n');
  for (const m of text.matchAll(ID_PATTERN)) if (!known.has(m[0])) critical.push(`mentions identifier "${m[0]}" that is not in the evidence`);
  if (EMAIL.test(text)) critical.push('contains an email address');
  if (PHONE.test(text)) critical.push('contains a phone number');

  if (JSON.stringify(a.recoveryActionsPerformed) !== JSON.stringify(b.actionsPerformed)) {
    issues.push(`recoveryActionsPerformed corrected from [${a.recoveryActionsPerformed.join(', ')}] to recorded [${b.actionsPerformed.join(', ')}]`);
    a.recoveryActionsPerformed = [...b.actionsPerformed];
  }
  const outcome = expectedOutcome(b);
  if (a.recoveryOutcome !== outcome) {
    issues.push(`recoveryOutcome corrected from ${a.recoveryOutcome} to ${outcome}`);
    a.recoveryOutcome = outcome;
  }
  if (a.severity !== b.incident.severity) {
    issues.push(`severity corrected from ${a.severity} to deterministic ${b.incident.severity}`);
    a.severity = b.incident.severity;
  }
  const mustInvolveHuman = b.incident.status === 'escalated';
  if (a.requiresHuman !== mustInvolveHuman) {
    issues.push(`requiresHuman corrected to ${mustInvolveHuman}`);
    a.requiresHuman = mustInvolveHuman;
  }

  return critical.length ? { assessment: null, critical: true, issues: [...critical, ...issues] } : { assessment: a, critical: false, issues };
}
