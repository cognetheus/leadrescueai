import { HttpTransportError } from '../shared/http';

export type Provider = 'meta' | 'crm';

/**
 * Normalized integration failure. Carries the facts the classifier needs
 * (status, retry hint, whether a write may have been applied) and nothing secret.
 */
export class IntegrationError extends Error {
  constructor(
    readonly provider: Provider,
    readonly operation: string,
    readonly kind: 'http' | 'timeout' | 'network' | 'protocol',
    message: string,
    readonly details: {
      httpStatus?: number;
      retryAfterMs?: number;
      requestSent: boolean;
      providerCode?: string | number;
      endpoint: string;
    },
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export function isIntegrationError(err: unknown): err is IntegrationError {
  return err instanceof IntegrationError || (err as { name?: string })?.name === 'IntegrationError';
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function fromTransport(provider: Provider, operation: string, endpoint: string, err: unknown): IntegrationError {
  if (err instanceof HttpTransportError) {
    return new IntegrationError(provider, operation, err.kind, err.message, { requestSent: err.requestSent, endpoint });
  }
  return new IntegrationError(provider, operation, 'network', (err as Error).message, { requestSent: true, endpoint });
}

export async function httpError(provider: Provider, operation: string, endpoint: string, res: Response): Promise<IntegrationError> {
  let providerCode: string | number | undefined;
  let message = `${provider} ${operation} failed with HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const e = body.error;
    if (e && typeof e === 'object' && 'code' in e) providerCode = (e as { code: number }).code;
    else if (typeof e === 'string') providerCode = e;
    const detail = (e && typeof e === 'object' && 'message' in e ? (e as { message: unknown }).message : body.message) ?? null;
    if (typeof detail === 'string') message += `: ${detail.slice(0, 200)}`;
  } catch {
    // Non-JSON error body; status code is enough.
  }
  return new IntegrationError(provider, operation, 'http', message, {
    httpStatus: res.status,
    retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    // The server answered; for writes, 5xx/timeouts are still ambiguous and handled by the classifier.
    requestSent: true,
    providerCode,
    endpoint,
  });
}
