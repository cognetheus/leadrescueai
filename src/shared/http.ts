/**
 * Bounded HTTP calls. Every outbound request has a deadline; callers receive a
 * typed transport error instead of hanging or leaking a raw `AbortError`.
 */
export class HttpTransportError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'network',
    /** True when the request may have reached the server (ambiguous outcome). */
    readonly requestSent: boolean,
  ) {
    super(message);
    this.name = 'HttpTransportError';
  }
}

export interface FetchOptions extends RequestInit {
  timeoutMs: number;
}

export async function fetchWithTimeout(url: string, opts: FetchOptions): Promise<Response> {
  const { timeoutMs, ...init } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      // The request was dispatched and we stopped waiting: the remote side may have committed.
      throw new HttpTransportError(`Request to ${new URL(url).pathname} timed out after ${timeoutMs}ms`, 'timeout', true);
    }
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    const refused = cause === 'ECONNREFUSED' || cause === 'ENOTFOUND';
    throw new HttpTransportError(
      `Network error calling ${new URL(url).pathname}: ${cause ?? (err as Error).message}`,
      'network',
      !refused,
    );
  } finally {
    clearTimeout(timer);
  }
}
