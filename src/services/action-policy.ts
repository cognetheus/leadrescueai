import type { OperatorAction, PolicyDecision } from '../domain/assessment';
import type { EvidenceBundle } from './incident-evidence';

const CREDENTIAL_CODES = new Set(['crm_refresh_grant_revoked', 'crm_credentials_revoked', 'crm_client_credentials_invalid', 'crm_not_connected']);
const SOURCE_CODES = new Set(['source_lead_not_found', 'source_page_token_invalid', 'source_not_connected', 'source_identity_mismatch']);

/**
 * Deterministic policy engine for operator actions. The analyst may only *propose*; this
 * decides which proposals are acceptable for the recorded state of the incident.
 */
export function allowedOperatorActions(b: EvidenceBundle): OperatorAction[] {
  const { status, failureClass } = b.incident;
  const code = b.attempts.at(-1)?.failure?.code ?? b.incident.failureCode ?? '';
  if (status === 'recovered' || status === 'resolved') return ['no_action_required', 'monitor'];
  if (status === 'open') return ['monitor'];
  if (CREDENTIAL_CODES.has(code) || b.credential?.status === 'revoked') return ['reauthorize_crm_connection'];
  if (failureClass === 'validation' || code.startsWith('source_lead_invalid') || code.endsWith('_rejected')) return ['correct_source_lead_data'];
  if (failureClass === 'verification' || code === 'crm_duplicate_contacts_detected') return ['investigate_crm_data_consistency', 'contact_provider_support'];
  if (SOURCE_CODES.has(code)) return ['contact_provider_support', 'correct_source_lead_data'];
  // Escalated after exhausting transient retries: a replay is safe (idempotent pipeline) once the provider is healthy.
  return b.credential?.status === 'active' ? ['replay_delivery', 'contact_provider_support', 'monitor'] : ['contact_provider_support'];
}

export function authorizeOperatorAction(b: EvidenceBundle, proposed: OperatorAction): PolicyDecision {
  const allowed = allowedOperatorActions(b);
  if (allowed.includes(proposed)) {
    return { proposed, authorized: true, finalAction: proposed, reason: `allowed for a ${b.incident.status} incident (${b.incident.failureCode ?? b.incident.kind})` };
  }
  return {
    proposed,
    authorized: false,
    finalAction: allowed[0]!,
    reason: `rejected: ${proposed} is not permitted for a ${b.incident.status} incident with ${b.incident.failureCode ?? b.incident.kind}; allowed: ${allowed.join(', ')}`,
  };
}
