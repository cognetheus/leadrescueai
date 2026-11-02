import { z } from 'zod';
import { fetchWithTimeout } from '../shared/http';
import { fromTransport, httpError, IntegrationError } from './errors';

export const CrmContactSchema = z.object({
  id: z.string(),
  locationId: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  postalCode: z.string().nullable(),
  source: z.string().nullable(),
  externalSourceId: z.string().nullable(),
  tags: z.array(z.string()),
  customFields: z.record(z.string(), z.string()),
  dateAdded: z.string(),
});
export type CrmContact = z.infer<typeof CrmContactSchema>;

export interface NewCrmContact {
  locationId: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  postalCode: string | null;
  source: string;
  externalSourceId: string;
  tags: string[];
  customFields: Record<string, string>;
}

const TokenResponse = z.object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number() });

export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

/** HTTP client for the CRM. Stateless: credentials are supplied per call by the credential service. */
export class CrmClient {
  constructor(private baseUrl: string, private timeoutMs: number) {}

  async refreshToken(input: { clientId: string; clientSecret: string; refreshToken: string }): Promise<TokenGrant> {
    const endpoint = '/crm/oauth/token';
    const res = await this.send('refresh_token', endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: input.clientId, client_secret: input.clientSecret, refresh_token: input.refreshToken }).toString(),
    });
    const parsed = TokenResponse.parse(await res.json());
    return { accessToken: parsed.access_token, refreshToken: parsed.refresh_token, expiresInSec: parsed.expires_in };
  }

  async findByExternalId(accessToken: string, locationId: string, externalSourceId: string): Promise<CrmContact[]> {
    const params = new URLSearchParams({ locationId, externalSourceId });
    const res = await this.send('search_contacts', `/crm/v1/contacts?${params}`, { headers: this.auth(accessToken) });
    return this.parse('search_contacts', '/crm/v1/contacts', z.object({ contacts: z.array(CrmContactSchema) }), await res.json()).contacts;
  }

  async createContact(accessToken: string, contact: NewCrmContact): Promise<CrmContact> {
    const res = await this.send('create_contact', '/crm/v1/contacts', {
      method: 'POST',
      headers: { ...this.auth(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify(contact),
    });
    return this.parse('create_contact', '/crm/v1/contacts', z.object({ contact: CrmContactSchema }), await res.json()).contact;
  }

  async getContact(accessToken: string, contactId: string): Promise<CrmContact> {
    const res = await this.send('get_contact', `/crm/v1/contacts/${encodeURIComponent(contactId)}`, { headers: this.auth(accessToken) });
    return this.parse('get_contact', '/crm/v1/contacts/:id', z.object({ contact: CrmContactSchema }), await res.json()).contact;
  }

  private auth(token: string) {
    return { authorization: `Bearer ${token}`, version: '2021-07-28' };
  }

  private parse<T>(operation: string, endpoint: string, schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new IntegrationError('crm', operation, 'protocol', `Malformed CRM ${operation} response`, { requestSent: true, endpoint });
    return parsed.data;
  }

  private async send(operation: string, endpoint: string, init: RequestInit): Promise<Response> {
    const path = endpoint.split('?')[0]!;
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}${endpoint}`, { ...init, timeoutMs: this.timeoutMs });
    } catch (err) {
      throw fromTransport('crm', operation, path, err);
    }
    if (!res.ok) throw await httpError('crm', operation, path, res);
    return res;
  }
}
