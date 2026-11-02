import { z } from 'zod';
import { REMEDIATION_ACTIONS } from './remediation';
import { SEVERITIES } from './incident';

/**
 * Actions an assessment may *suggest* to an operator. They are advisory and must pass
 * the deterministic policy engine; the analyst can never execute them itself.
 */
export const OPERATOR_ACTIONS = [
  'no_action_required',
  'monitor',
  'replay_delivery',
  'reauthorize_crm_connection',
  'correct_source_lead_data',
  'investigate_crm_data_consistency',
  'contact_provider_support',
] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

const EvidenceRefs = z.array(z.string().min(1).max(80)).min(1).max(12);

/** Shape the model must produce. Separates observed facts from inference. */
export const IncidentAssessmentSchema = z.object({
  incidentId: z.string().min(1),
  observedFacts: z
    .array(z.object({ statement: z.string().min(5).max(300), evidenceRefs: EvidenceRefs }))
    .min(1)
    .max(10),
  rootCauseHypothesis: z.object({
    statement: z.string().min(5).max(400),
    confidence: z.enum(['low', 'medium', 'high']),
    evidenceRefs: EvidenceRefs,
  }),
  recoveryActionsPerformed: z.array(z.enum(REMEDIATION_ACTIONS)).max(20),
  recoveryOutcome: z.enum(['recovered', 'escalated', 'in_progress']),
  suggestedAction: z.enum(OPERATOR_ACTIONS),
  severity: z.enum(SEVERITIES),
  requiresHuman: z.boolean(),
  operatorInstructions: z.string().min(10).max(700),
});
export type IncidentAssessment = z.infer<typeof IncidentAssessmentSchema>;

export interface PolicyDecision {
  proposed: OperatorAction;
  authorized: boolean;
  finalAction: OperatorAction;
  reason: string;
}

/** Persisted assessment with provenance; `source: 'fallback'` means deterministic, no LLM. */
export interface StoredAssessment {
  id: string;
  incidentId: string;
  source: 'ai' | 'fallback';
  model: string | null;
  assessment: IncidentAssessment;
  policy: PolicyDecision;
  validationIssues: string[];
  latencyMs: number;
  createdAt: string;
}
