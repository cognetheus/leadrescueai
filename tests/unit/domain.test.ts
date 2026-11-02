import { describe, expect, it } from 'vitest';
import { IncidentAssessmentSchema } from '../../src/domain/assessment';
import { assertTransition, canTransition, DELIVERY_STATUSES } from '../../src/domain/delivery';
import { severityFor } from '../../src/domain/incident';
import { normalizePhone, validateAndNormalizeLead } from '../../src/domain/lead';

const lead = (fields: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  id: 'lead_1',
  created_time: '2026-01-01T10:00:00Z',
  form_id: 'form_1',
  page_id: 'page_1',
  field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })),
  ...extra,
});

describe('lead validation and normalization', () => {
  it('normalizes names, email case and NANP phone numbers', () => {
    const r = validateAndNormalizeLead(
      lead({ full_name: '  Maria   de la Cruz ', email: 'Maria@Example.COM', phone_number: '(512) 555-0142', zip_code: '78701', service_type: 'Roof repair', budget: '$10k' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead).toMatchObject({
      firstName: 'Maria',
      lastName: 'de la Cruz',
      email: 'maria@example.com',
      phone: '+15125550142',
      postalCode: '78701',
      serviceType: 'Roof repair',
      answers: { budget: '$10k' },
    });
  });

  it('accepts a lead with only one valid contact method', () => {
    expect(validateAndNormalizeLead(lead({ first_name: 'Sam', phone_number: '+44 20 7946 0958' })).ok).toBe(true);
  });

  it('drops an invalid optional value with a warning instead of failing', () => {
    const r = validateAndNormalizeLead(lead({ full_name: 'Al B', email: 'not-an-email', phone_number: '5125550100' }));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.field)).toEqual(['email']);
  });

  it('rejects leads without any contact method and never fabricates one', () => {
    const r = validateAndNormalizeLead(lead({ full_name: 'No Contact', email: 'bad@', phone_number: '12' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.field)).toContain('email|phone_number');
  });

  it('rejects leads without a name', () => {
    const r = validateAndNormalizeLead(lead({ email: 'a@b.co' }));
    expect(r.ok).toBe(false);
  });

  it('rejects structurally invalid payloads safely', () => {
    for (const bad of [null, 'x', {}, lead({}, { created_time: 'yesterday' }), lead({}, { field_data: 'nope' })]) {
      const r = validateAndNormalizeLead(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('strips control characters', () => {
    const r = validateAndNormalizeLead(lead({ full_name: 'Eve\u0000\u0007 Smith', email: 'e@x.io' }));
    expect(r.ok && r.lead.firstName).toBe('Eve');
  });

  it.each([
    ['5125550100', '+15125550100'],
    ['1-512-555-0100', '+15125550100'],
    ['+61 2 9374 4000', '+61293744000'],
    ['555-0100', 'invalid'],
    ['', null],
  ])('phone %s -> %s', (input, expected) => {
    expect(normalizePhone(input || null)).toBe(expected);
  });
});

describe('delivery state machine', () => {
  it('delivered is terminal', () => {
    for (const to of DELIVERY_STATUSES) expect(canTransition('delivered', to)).toBe(false);
  });
  it('allows reclaiming a crashed processing delivery and operator replay of escalations', () => {
    expect(canTransition('processing', 'processing')).toBe(true);
    expect(canTransition('escalated', 'pending')).toBe(true);
  });
  it('throws on illegal transitions', () => {
    expect(() => assertTransition('pending', 'delivered')).toThrow(/pending -> delivered/);
  });
});

describe('incident severity', () => {
  it('ranks escalated credential failures as critical and recovered blips as low', () => {
    expect(severityFor({ status: 'escalated', failureClass: 'authentication', kind: 'delivery_failure' })).toBe('critical');
    expect(severityFor({ status: 'recovered', failureClass: 'transient', kind: 'delivery_failure' })).toBe('low');
  });
});

describe('assessment contract', () => {
  const valid = {
    incidentId: 'inc_1',
    observedFacts: [{ statement: 'CRM returned HTTP 503 twice', evidenceRefs: ['att_1'] }],
    rootCauseHypothesis: { statement: 'Temporary CRM outage', confidence: 'medium', evidenceRefs: ['att_1'] },
    recoveryActionsPerformed: ['retry_with_backoff'],
    recoveryOutcome: 'recovered',
    suggestedAction: 'monitor',
    severity: 'low',
    requiresHuman: false,
    operatorInstructions: 'No action needed; watch CRM error rates.',
  };
  it('accepts a well-formed assessment', () => {
    expect(IncidentAssessmentSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects actions outside the allowlist and facts without evidence', () => {
    expect(IncidentAssessmentSchema.safeParse({ ...valid, suggestedAction: 'delete_contact' }).success).toBe(false);
    expect(IncidentAssessmentSchema.safeParse({ ...valid, recoveryActionsPerformed: ['drop_database'] }).success).toBe(false);
    expect(
      IncidentAssessmentSchema.safeParse({ ...valid, observedFacts: [{ statement: 'Something happened', evidenceRefs: [] }] }).success,
    ).toBe(false);
  });
});
