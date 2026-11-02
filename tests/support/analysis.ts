import type { IncidentAssessment } from '../../src/domain/assessment';
import { GENERATOR_KEY, generators } from '../../src/mastra/workflows/incident-analysis';
import type { AssessmentGenerator } from '../../src/services/incident-analysis';
import type { EvidenceBundle } from '../../src/services/incident-evidence';
import type { Harness } from './harness';

/** A grounded assessment built only from the bundle, like a well-behaved model would produce. */
export function groundedAssessment(b: EvidenceBundle, over: Partial<IncidentAssessment> = {}): IncidentAssessment {
  const attempt = b.attempts.find((a) => a.failure) ?? b.attempts[0];
  const ref = attempt?.ref ?? b.incident.ref;
  return {
    incidentId: b.incident.ref,
    observedFacts: [{ statement: `Incident is ${b.incident.status} after ${b.attempts.length} attempts.`, evidenceRefs: [b.incident.ref, ref] }],
    rootCauseHypothesis: { statement: 'The CRM API was briefly unavailable.', confidence: 'medium', evidenceRefs: [ref] },
    recoveryActionsPerformed: [...b.actionsPerformed],
    recoveryOutcome: b.incident.status === 'escalated' ? 'escalated' : b.incident.status === 'open' ? 'in_progress' : 'recovered',
    suggestedAction: b.incident.status === 'escalated' ? 'reauthorize_crm_connection' : 'monitor',
    severity: b.incident.severity,
    requiresHuman: b.incident.status === 'escalated',
    operatorInstructions: 'Review the timeline; no further action is needed unless failures repeat.',
    ...over,
  };
}

export function fakeGenerator(fn: (b: EvidenceBundle, signal: AbortSignal) => Promise<unknown> | unknown): AssessmentGenerator {
  return { model: 'fake/test-model', generate: async (b, { signal }) => fn(b, signal) };
}

/** Runs Workflow D for an incident with an injected generator; returns the latest stored assessment. */
export async function analyzeWith(h: Harness, incidentId: string, generator?: AssessmentGenerator) {
  const rc = h.requestContext();
  const key = generator ? generators.register(generator) : undefined;
  if (key) rc.set(GENERATOR_KEY, key);
  try {
    const run = await h.mastra.getWorkflow('incidentAnalysisWorkflow').createRun();
    const res = await run.start({ inputData: { incidentId }, requestContext: rc });
    if (res.status !== 'success') throw new Error(`incident-analysis ${res.status}: ${res.status === 'failed' ? res.error?.message : ''}`);
    return { stored: h.container.repos.incidents.assessments(incidentId).at(-1)!, runId: run.runId };
  } finally {
    if (key) generators.release(key);
  }
}
