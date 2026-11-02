import { z } from 'zod';
import { fetchWithTimeout } from '../shared/http';
import { fromTransport, httpError, IntegrationError } from './errors';

const LeadEnvelope = z.object({ id: z.string() }).passthrough();
const ListResponse = z.object({
  data: z.array(LeadEnvelope),
  paging: z.object({ cursors: z.object({ after: z.string().nullable() }), next: z.string().optional() }),
});

export interface LeadPage {
  leads: Array<{ id: string; [k: string]: unknown }>;
  /** Cursor for the next page, or null when this was the last page. */
  nextCursor: string | null;
}

/**
 * HTTP client for the advertising source. Returns raw canonical leads; validation
 * and normalization are domain concerns (see `validateAndNormalizeLead`).
 */
export class MetaSourceClient {
  constructor(private baseUrl: string, private timeoutMs: number) {}

  async getLead(pageAccessToken: string, leadId: string): Promise<unknown> {
    const endpoint = `/meta/v1/leads/${encodeURIComponent(leadId)}`;
    const res = await this.call('get_lead', endpoint, pageAccessToken);
    return res.json();
  }

  async listLeads(pageAccessToken: string, pageId: string, opts: { sinceMs: number; limit: number; after?: string | null }): Promise<LeadPage> {
    const params = new URLSearchParams({ since: String(Math.floor(opts.sinceMs / 1000)), limit: String(opts.limit) });
    if (opts.after) params.set('after', opts.after);
    const endpoint = `/meta/v1/${encodeURIComponent(pageId)}/leads?${params}`;
    const res = await this.call('list_leads', endpoint, pageAccessToken);
    const parsed = ListResponse.safeParse(await res.json());
    if (!parsed.success) {
      throw new IntegrationError('meta', 'list_leads', 'protocol', 'Malformed lead list response', { requestSent: true, endpoint: `/meta/v1/${pageId}/leads` });
    }
    return { leads: parsed.data.data, nextCursor: parsed.data.paging.next ? parsed.data.paging.cursors.after : null };
  }

  private async call(operation: string, endpoint: string, token: string): Promise<Response> {
    const path = endpoint.split('?')[0]!;
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}${endpoint}`, { timeoutMs: this.timeoutMs, headers: { authorization: `Bearer ${token}` } });
    } catch (err) {
      throw fromTransport('meta', operation, path, err);
    }
    if (!res.ok) throw await httpError('meta', operation, path, res);
    return res;
  }
}
