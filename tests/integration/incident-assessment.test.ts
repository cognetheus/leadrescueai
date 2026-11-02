import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IncidentAssessmentSchema } from '../../src/domain/assessment';
import { analyzeWith, fakeGenerator, groundedAssessment } from '../support/analysis';
import { createHarness, type Harness } from '../support/harness';

describe('structured incident assessments and policy validation (P06.02)', () => {
  let h: Harness;
  let recovered: string;
  let escalated: string;
  beforeAll(async () => {
    h = await createHarness();
    const a = await h.submitLead({ seed: 1001, scenario: 'crm_503' });
    const b = await h.submitLead({ tenant: 'summit-hvac', seed: 1002, scenario: 'revoked_refresh_token' });
    // Deliver only; analysis jobs are run explicitly below.
    await h.drain({ kinds: ['deliver_lead'] });
    const inc = (t: string, l: string) => h.container.repos.incidents.forDelivery(h.container.repos.deliveries.getByLead(h.tenants[t]!.id, 'meta_lead_ads', l)!.id)[0]!.id;
    recovered = inc('acme-roofing', a.leadId);
    escalated = inc('summit-hvac', b.leadId);
  });
  afterAll(() => h.close());

  it('accepts a grounded AI assessment and records it through every workflow step', async () => {
    const { stored, runId } = await analyzeWith(h, recovered, fakeGenerator((b) => groundedAssessment(b)));
    expect(stored).toMatchObject({ source: 'ai', model: 'fake/test-model', validationIssues: [], policy: { authorized: true, finalAction: 'monitor' } });
    expect(stored.assessment.recoveryActionsPerformed).toEqual(['retry_with_backoff', 'retry_with_backoff']);
    expect(h.container.repos.incidents.events(recovered).at(-1)).toMatchObject({ type: 'assessment_generated' });
    const run = await (await h.mastra.getStorage()!.getStore('workflows'))!.getWorkflowRunById({ runId, workflowName: 'incident-analysis' });
    const ctx = (run!.snapshot as { context: Record<string, { status: string }> }).context;
    for (const s of ['gather-evidence', 'generate-assessment', 'validate-grounding', 'authorize-action', 'persist-assessment']) expect(ctx[s]?.status, s).toBe('success');
  });

  it('the policy engine overrides an unauthorized suggestion', async () => {
    const { stored } = await analyzeWith(h, escalated, fakeGenerator((b) => groundedAssessment(b, { suggestedAction: 'replay_delivery' })));
    expect(stored.source).toBe('ai');
    expect(stored.policy).toMatchObject({ proposed: 'replay_delivery', authorized: false, finalAction: 'reauthorize_crm_connection' });
    expect(stored.assessment.suggestedAction).toBe('reauthorize_crm_connection');
  });

  it('corrects facts the system knows deterministically and records each correction', async () => {
    const { stored } = await analyzeWith(h, escalated, fakeGenerator((b) => groundedAssessment(b, {
      recoveryActionsPerformed: ['retry_with_backoff'], recoveryOutcome: 'recovered', severity: 'low', requiresHuman: false,
    })));
    expect(stored.source).toBe('ai');
    expect(stored.assessment).toMatchObject({ recoveryActionsPerformed: ['refresh_token_and_retry'], recoveryOutcome: 'escalated', severity: 'critical', requiresHuman: true });
    expect(stored.validationIssues).toHaveLength(4);
  });

  it('analysis jobs run Workflow D for real incidents; with AI disabled a grounded fallback is stored', async () => {
    await h.drain({ kinds: ['analyze_incident'] });
    for (const id of [recovered, escalated]) {
      const fallback = h.container.repos.incidents.assessments(id).find((a) => a.source === 'fallback')!;
      expect(fallback.validationIssues[0]).toMatch(/AI analysis disabled/);
      expect(IncidentAssessmentSchema.safeParse(fallback.assessment).success).toBe(true);
      expect(fallback.assessment.incidentId).toBe(id);
    }
    const esc = h.container.repos.incidents.assessments(escalated).find((a) => a.source === 'fallback')!;
    expect(esc.assessment).toMatchObject({ suggestedAction: 'reauthorize_crm_connection', requiresHuman: true, recoveryOutcome: 'escalated' });
    expect(esc.assessment.rootCauseHypothesis.statement).toMatch(/revoked/);
  });
});
