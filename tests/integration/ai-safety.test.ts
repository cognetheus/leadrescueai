import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAssessment } from '../../src/services/assessment-validator';
import { IncidentEvidenceService } from '../../src/services/incident-evidence';
import { analyzeWith, fakeGenerator, groundedAssessment } from '../support/analysis';
import { createHarness, type Harness } from '../support/harness';

describe('AI hallucination protection and fallback (P06.03)', () => {
  let h: Harness;
  let incidentId: string;
  const leads: Record<string, string> = {};
  beforeAll(async () => {
    // AI enabled with an API key, but the LLM endpoint is a closed port: the real analyst is unavailable.
    h = await createHarness({ AI_ENABLED: 'true', OLLAMA_API_KEY: 'test-key-123', OLLAMA_BASE_URL: 'http://127.0.0.1:1', OLLAMA_TIMEOUT_MS: '400' });
    for (const scenario of ['crm_503', 'revoked_refresh_token', 'timeout_after_commit', 'missing_required_field', 'verification_mismatch', 'expired_token'] as const) {
      leads[scenario] = (await h.submitLead({ tenant: scenario === 'revoked_refresh_token' ? 'summit-hvac' : 'acme-roofing', seed: 1100 + Object.keys(leads).length, scenario })).leadId;
    }
    await h.drain();
    const d = h.container.repos.deliveries.getByLead(h.tenants['acme-roofing']!.id, 'meta_lead_ads', leads.crm_503!)!;
    incidentId = h.container.repos.incidents.forDelivery(d.id)[0]!.id;
  });
  afterAll(() => h.close());

  it('Ollama being down never interrupts deterministic delivery', () => {
    const status = (scenario: string) =>
      h.container.repos.deliveries.getByLead(h.tenants[scenario === 'revoked_refresh_token' ? 'summit-hvac' : 'acme-roofing']!.id, 'meta_lead_ads', leads[scenario]!)!.status;
    expect(status('crm_503')).toBe('delivered');
    expect(status('timeout_after_commit')).toBe('delivered');
    expect(status('expired_token')).toBe('delivered');
    expect(status('revoked_refresh_token')).toBe('escalated');
    // ...and every closed incident still received a (deterministic) assessment.
    for (const inc of h.container.repos.incidents.list().filter((i) => i.status !== 'open')) {
      const [a] = h.container.repos.incidents.assessments(inc.id);
      expect(a, inc.id).toBeDefined();
      expect(a!.source).toBe('fallback');
      expect(a!.validationIssues[0]).toMatch(/Ollama unreachable/);
    }
  });

  it.each([
    ['cites an evidence ref that does not exist', (b: Parameters<typeof groundedAssessment>[0]) => groundedAssessment(b, { rootCauseHypothesis: { statement: 'CRM outage.', confidence: 'high', evidenceRefs: ['att_ffffffffffffffffffffffffffffffff'] } }), /unknown evidence ref/],
    ['mentions an identifier it invented', (b: Parameters<typeof groundedAssessment>[0]) => groundedAssessment(b, { operatorInstructions: 'Re-run job_0123456789abcdef0123 to fix the delivery.' }), /not in the evidence/],
    ['leaks contact data', (b: Parameters<typeof groundedAssessment>[0]) => groundedAssessment(b, { operatorInstructions: 'Call the lead at (512) 555-0199 or email jane@example.com.' }), /email|phone/],
    ['answers about a different incident', (b: Parameters<typeof groundedAssessment>[0]) => groundedAssessment(b, { incidentId: 'inc_00000000000000000000000000000000' }), /does not match/],
    ['returns an action outside the allowlist', (b: Parameters<typeof groundedAssessment>[0]) => ({ ...groundedAssessment(b), suggestedAction: 'delete_crm_contact' }), /schema/],
    ['returns unstructured text', () => 'The CRM was down, probably. Restart everything.', /schema/],
  ])('discards output that %s and stores a grounded fallback', async (_name, make, issue) => {
    const { stored } = await analyzeWith(h, incidentId, fakeGenerator((b) => make(b)));
    expect(stored.source).toBe('fallback');
    expect(stored.validationIssues.join(' ')).toMatch(issue);
    expect(JSON.stringify(stored.assessment)).not.toMatch(/delete_crm_contact|jane@example|555-0199|job_0123/);
  });

  it('falls back when the model errors or exceeds the timeout', async () => {
    const thrown = await analyzeWith(h, incidentId, fakeGenerator(() => { throw new Error('model crashed'); }));
    expect(thrown.stored).toMatchObject({ source: 'fallback', validationIssues: [expect.stringMatching(/model crashed/)] });
    const started = Date.now();
    const hung = await analyzeWith(h, incidentId, fakeGenerator(() => new Promise(() => {})));
    expect(hung.stored.validationIssues[0]).toMatch(/timed out after 400ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('every stored assessment, AI or fallback, is grounded in recorded evidence', async () => {
    const svc = new IncidentEvidenceService(h.container.repos, h.container.services.crm, h.container.services.credentials);
    let checked = 0;
    for (const inc of h.container.repos.incidents.list()) {
      const bundle = (await svc.gather(inc.id))!;
      for (const stored of h.container.repos.incidents.assessments(inc.id)) {
        const v = validateAssessment(stored.assessment, bundle);
        expect(v.critical, `${inc.id}: ${v.issues.join('; ')}`).toBe(false);
        expect(stored.assessment.recoveryActionsPerformed).toEqual(bundle.actionsPerformed);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(12);
  });
});

describe('evidence ref normalization', () => {
  it('accepts a real ref with different casing (recorded as a correction) but still rejects invented refs', async () => {
    const { validateAssessment: validate } = await import('../../src/services/assessment-validator');
    const ref = 'ine_0123456789abcdef0123';
    const bundle = {
      incident: { ref: 'inc_0123456789abcdef', kind: 'delivery_failure', status: 'recovered', severity: 'low', title: 't', failureClass: 'transient', failureCode: 'x', tenant: 't', openedAt: '', closedAt: '' },
      delivery: null, timeline: [], attempts: [], credential: null, crm: null, actionsPerformed: [], refs: ['inc_0123456789abcdef', ref],
    } as never;
    const make = (r: string) => ({
      incidentId: 'inc_0123456789abcdef', observedFacts: [{ statement: 'Recovered fine.', evidenceRefs: [r] }],
      rootCauseHypothesis: { statement: 'Outage.', confidence: 'low', evidenceRefs: [r] },
      recoveryActionsPerformed: [], recoveryOutcome: 'recovered', suggestedAction: 'monitor', severity: 'low', requiresHuman: false, operatorInstructions: 'Nothing to do here.',
    });
    const upper = validate(make(' INE_0123456789ABCDEF0123 '), bundle);
    expect(upper.critical).toBe(false);
    expect(upper.assessment!.observedFacts[0]!.evidenceRefs).toEqual([ref]);
    expect(upper.issues.join()).toMatch(/normalized evidence ref/);
    expect(validate(make('INE_FFFFFFFFFFFFFFFFFFFF'), bundle).critical).toBe(true);
  });
});
