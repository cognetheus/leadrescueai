import type { FaultRule, FaultRuleInput } from './faults/engine';
import type { GraphLead } from './meta/app';

/**
 * Typed client for the simulators' admin API. Used by seeding, demo controls and tests;
 * never by the delivery pipeline (which only uses the public provider APIs).
 */
export class SimulatorAdminClient {
  constructor(private baseUrl: string, private adminToken: string, private timeoutMs = 15_000) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.adminToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as T;
    if (!res.ok) throw new Error(`Simulator ${method} ${path} failed: HTTP ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  health() {
    return this.call<{ status: string }>('GET', '/health');
  }
  upsertPage(page: { pageId: string; name: string; appSecret: string; pageAccessToken: string; webhookUrl: string | null }) {
    return this.call('POST', '/sim-admin/meta/pages', page);
  }
  createLead(pageId: string, lead: { id?: string; formId?: string; fields: Record<string, string>; createdTime?: string }) {
    return this.call<{ lead: GraphLead; webhook: { outcome: string; sent: number; faultRuleId?: string } }>('POST', `/sim-admin/meta/pages/${pageId}/leads`, lead);
  }
  redeliverWebhook(leadId: string) {
    return this.call<{ webhook: { outcome: string; sent: number } }>('POST', `/sim-admin/meta/leads/${leadId}/redeliver`);
  }
  listSourceLeads(pageId: string) {
    return this.call<{ leads: GraphLead[] }>('GET', `/sim-admin/meta/pages/${pageId}/leads`);
  }
  installCrmLocation(loc: { locationId: string; name: string; clientId: string; clientSecret: string; accessTokenTtlSec?: number }) {
    return this.call<{ access_token: string; refresh_token: string; expires_in: number }>('POST', '/sim-admin/crm/locations', loc);
  }
  expireAccessTokens(locationId: string) {
    return this.call<{ expired: number }>('POST', `/sim-admin/crm/locations/${locationId}/expire-access-tokens`);
  }
  revokeRefreshTokens(locationId: string) {
    return this.call<{ revoked: number }>('POST', `/sim-admin/crm/locations/${locationId}/revoke-refresh-tokens`);
  }
  crmContacts(locationId?: string) {
    return this.call<{ contacts: Array<Record<string, unknown> & { id: string; externalSourceId: string | null }> }>('GET', `/sim-admin/crm/contacts${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ''}`);
  }
  crmDuplicates() {
    return this.call<{ duplicates: Array<{ locationId: string; externalSourceId: string; count: number }> }>('GET', '/sim-admin/crm/duplicates');
  }
  addFault(rule: FaultRuleInput) {
    return this.call<{ rule: FaultRule }>('POST', '/sim-admin/faults', rule);
  }
  listFaults() {
    return this.call<{ rules: FaultRule[] }>('GET', '/sim-admin/faults');
  }
  clearFaults() {
    return this.call<{ removed: number }>('DELETE', '/sim-admin/faults');
  }
  faultEvents() {
    return this.call<{ events: Array<{ ruleId: string; label: string; target: string; matchKey: string | null; effectType: string; createdAt: number }> }>('GET', '/sim-admin/fault-events');
  }
  webhookDeliveries() {
    return this.call<{ deliveries: Array<Record<string, unknown>> }>('GET', '/sim-admin/meta/webhook-deliveries');
  }
  reset() {
    return this.call<{ reset: boolean }>('POST', '/sim-admin/reset');
  }
}
