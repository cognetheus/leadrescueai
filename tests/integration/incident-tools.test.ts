import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INCIDENT_SCOPE_KEY, incidentTools } from '../../src/mastra/tools/incident-tools';
import { createHarness, type Harness } from '../support/harness';

describe('Incident Analyst read-only tools (P06.01)', () => {
  let h: Harness;
  let recoveredId: string;
  let escalatedId: string;
  beforeAll(async () => {
    h = await createHarness();
    const a = await h.submitLead({ seed: 901, scenario: 'crm_503' });
    const b = await h.submitLead({ tenant: 'summit-hvac', seed: 902, scenario: 'revoked_refresh_token' });
    await h.drain({ maxJobs: 20 });
    const inc = (tenant: string, lead: string) => {
      const d = h.container.repos.deliveries.getByLead(h.tenants[tenant]!.id, 'meta_lead_ads', lead)!;
      return h.container.repos.incidents.forDelivery(d.id)[0]!.id;
    };
    recoveredId = inc('acme-roofing', a.leadId);
    escalatedId = inc('summit-hvac', b.leadId);
  });
  afterAll(() => h.close());

  type AnyTool = { execute?: (input: { incidentId: string }, ctx: unknown) => Promise<unknown> };
  const call = (tool: unknown, incidentId: string, scope?: string) => {
    const requestContext = h.requestContext();
    if (scope) requestContext.set(INCIDENT_SCOPE_KEY, scope);
    return (tool as AnyTool).execute!({ incidentId }, { requestContext });
  };
  const snapshot = async () => ({
    app: h.container.db.prepare("SELECT (SELECT count(*) FROM deliveries) d, (SELECT count(*) FROM delivery_attempts) a, (SELECT count(*) FROM incidents) i, (SELECT group_concat(version) FROM credentials) v, (SELECT count(*) FROM jobs WHERE status IN ('queued','leased')) j").get(),
    crm: (await h.sim.crmContacts()).contacts.length,
  });

  it('return the recorded evidence with citable refs', async () => {
    const timeline = (await call(incidentTools.getIncidentTimeline, recoveredId)) as { incident: { ref: string; status: string }; timeline: Array<{ ref: string; type: string }> };
    expect(timeline.incident).toMatchObject({ ref: recoveredId, status: 'recovered' });
    expect(timeline.timeline.map((e) => e.type)).toContain('recovered');
    expect(timeline.timeline.every((e) => e.ref.startsWith('ine_'))).toBe(true);
    const attempts = (await call(incidentTools.getDeliveryAttempts, recoveredId)) as { actionsPerformed: string[] };
    expect(attempts.actionsPerformed).toEqual(['retry_with_backoff', 'retry_with_backoff']);
    const cred = (await call(incidentTools.getCredentialStatus, escalatedId)) as { credential: { status: string } };
    expect(cred.credential.status).toBe('revoked');
    const crm = (await call(incidentTools.getCrmState, recoveredId)) as { crm: { contactsWithExternalId: number } };
    expect(crm.crm.contactsWithExternalId).toBe(1);
  });

  it('are strictly read-only', async () => {
    const before = await snapshot();
    for (const tool of Object.values(incidentTools)) {
      await call(tool, recoveredId);
      await call(tool, escalatedId);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('refuse to read outside the analysis scope', async () => {
    await expect(call(incidentTools.getIncidentTimeline, escalatedId, recoveredId)).rejects.toThrow(/scoped to/);
  });

  it('never expose customer contact details or secrets', async () => {
    const outputs = JSON.stringify(await Promise.all(Object.values(incidentTools).flatMap((t) => [call(t as AnyTool, recoveredId), call(t as AnyTool, escalatedId)])));
    expect(outputs).not.toMatch(/@example\.com/);
    expect(outputs).not.toMatch(/\+1512555/);
    expect(outputs).not.toMatch(/\b(at|rt|pat)_[A-Za-z0-9_-]{16,}/);
  });
});
