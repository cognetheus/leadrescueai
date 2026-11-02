import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionTenant } from '../../src/services/provisioning';
import { TENANT_FIXTURES } from '../../src/simulators/fixtures';
import { createHarness, type Harness } from '../support/harness';

describe('verification, escalation and recovery audit trail (P04.03)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const delivery = (leadId: string, tenant = 'acme-roofing') => h.container.repos.deliveries.getByLead(h.tenants[tenant]!.id, 'meta_lead_ads', leadId)!;

  it('records a complete, ordered recovery timeline for a self-healed failure', async () => {
    const { leadId } = await h.submitLead({ seed: 501, scenario: 'crm_503' });
    await h.drain();
    const d = delivery(leadId);
    const [incident] = h.container.repos.incidents.forDelivery(d.id);
    expect(h.container.repos.incidents.events(incident!.id).map((e) => e.type)).toEqual([
      'detected', 'classified', 'remediation_selected', 'remediation_executed', 'retry_scheduled',
      'classified', 'remediation_selected', 'remediation_executed', 'retry_scheduled',
      'verification_passed', 'recovered',
    ]);
    const audit = h.container.repos.audit.forEntity('delivery', d.id).map((a) => a.action);
    expect(audit.filter((a) => a === 'remediation.retry_with_backoff')).toHaveLength(2);
    expect(audit.at(-1)).toBe('delivery.delivered');
    // Every audit row of this delivery shares the webhook's correlation id.
    expect(new Set(h.container.repos.audit.forEntity('delivery', d.id).map((a) => a.correlationId))).toEqual(new Set([d.correlationId]));
  });

  it('persists each remediation as a Mastra workflow run with every step', async () => {
    const { leadId } = await h.submitLead({ seed: 502, scenario: 'timeout_after_commit' });
    await h.drain();
    const [attempt] = h.container.repos.attempts.forDelivery(delivery(leadId).id);
    const store = await h.mastra.getStorage()!.getStore('workflows');
    const run = await store!.getWorkflowRunById({ runId: `${attempt!.id}-remediation`, workflowName: 'delivery-remediation' });
    const snap = run!.snapshot as { status: string; context: Record<string, { status: string; output?: Record<string, unknown> }> };
    expect(snap.status).toBe('success');
    for (const s of ['capture-evidence', 'classify-failure', 'select-remediation', 'execute-action', 'verify-outcome', 'record-outcome']) expect(snap.context[s]?.status, s).toBe('success');
    expect(snap.context['record-outcome']!.output).toMatchObject({ outcome: { deliveryStatus: 'delivered', job: 'complete' }, decision: { action: 'crm_read_before_retry' } });
    // The failed delivery run is also persisted, failing at the create step.
    const failedRun = await store!.getWorkflowRunById({ runId: attempt!.id, workflowName: 'lead-delivery' });
    expect((failedRun!.snapshot as { context: Record<string, { status: string }> }).context['create-crm-contact']!.status).toBe('failed');
  });

  it('escalation closes the incident, records why, and requests an assessment', async () => {
    const { leadId } = await h.submitLead({ tenant: 'summit-hvac', seed: 503, scenario: 'revoked_refresh_token' });
    await h.drain({ maxJobs: 10 });
    const d = delivery(leadId, 'summit-hvac');
    const [incident] = h.container.repos.incidents.forDelivery(d.id);
    expect(incident).toMatchObject({ status: 'escalated', severity: 'critical' });
    const events = h.container.repos.incidents.events(incident!.id);
    expect(events.at(-1)).toMatchObject({ type: 'escalated' });
    expect(events.at(-1)!.message).toMatch(/re-authorize/);
    expect(h.container.queue.list().some((j) => j.kind === 'analyze_incident' && (j.payload as { incidentId: string }).incidentId === incident!.id)).toBe(true);
    expect(h.container.repos.audit.forEntity('delivery', d.id).map((a) => a.action)).toContain('remediation.refresh_token_and_retry');
  });

  it('operator replay is refused until credentials are fixed, then delivers through the normal path', async () => {
    const d = h.container.repos.deliveries.list({ status: 'escalated', tenantId: h.tenants['summit-hvac']!.id })[0]!;
    expect(() => h.container.services.operator.replayDelivery(d.id, 'operator:test')).toThrow(/re-authorize/);
    await provisionTenant(h.container, h.sim, TENANT_FIXTURES[1]); // operator re-authorizes the CRM app
    h.container.services.operator.replayDelivery(d.id, 'operator:test', 'CRM re-authorized');
    await h.drain();
    expect(h.container.repos.deliveries.get(d.id)).toMatchObject({ status: 'delivered' });
    expect(await h.contactsFor('summit-hvac', d.sourceLeadId)).toHaveLength(1);
    const audit = h.container.repos.audit.forEntity('delivery', d.id).map((a) => a.action);
    expect(audit).toContain('operator.replay_delivery');
    expect(() => h.container.services.operator.replayDelivery(d.id, 'operator:test')).toThrow(/only escalated/);
  });

  it('recovery is verified: a recovered incident always has a verified, delivered lead behind it', () => {
    for (const incident of h.container.repos.incidents.list({ status: 'recovered' })) {
      const d = h.container.repos.deliveries.get(incident.deliveryId!)!;
      expect(d.status).toBe('delivered');
      expect(d.crmContactId).not.toBeNull();
      expect(h.container.repos.incidents.events(incident.id).some((e) => e.type === 'verification_passed')).toBe(true);
    }
  });
});
