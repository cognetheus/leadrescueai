import type { FailureClass } from './failure';

export const INCIDENT_KINDS = ['delivery_failure', 'lost_webhook', 'reconciliation_inconsistency'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_STATUSES = ['open', 'recovered', 'escalated', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INCIDENT_EVENT_TYPES = [
  'detected',
  'classified',
  'remediation_selected',
  'remediation_executed',
  'retry_scheduled',
  'worker_interrupted',
  'verification_passed',
  'verification_failed',
  'recovered',
  'escalated',
  'assessment_generated',
  'assessment_fallback',
  'operator_action',
] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];

/** Deterministic severity: escalations that lose a lead outrank recovered blips. */
export function severityFor(input: { status: IncidentStatus; failureClass: FailureClass | null; kind: IncidentKind }): Severity {
  if (input.status === 'escalated') {
    return input.failureClass === 'authentication' || input.failureClass === 'permanent' ? 'critical' : 'high';
  }
  if (input.kind === 'lost_webhook') return 'medium';
  if (input.status === 'recovered' || input.status === 'resolved') return 'low';
  return 'medium';
}
