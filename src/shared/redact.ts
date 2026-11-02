/**
 * Redaction for logs, audit evidence and AI prompts.
 *
 * Secrets are removed by key name; customer contact details are masked so that
 * operators can still correlate records without the raw values leaving the database.
 */
const SECRET_KEYS = /(token|secret|password|authorization|api[-_]?key|signature|cookie|client_secret)/i;
const EMAIL_KEYS = /^(email|e-mail)$/i;
const PHONE_KEYS = /^(phone|phone_number|mobile)$/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const TOKEN_LIKE = /\b(at|rt|tok|sk|pk)_[A-Za-z0-9]{12,}\b/g;

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '***';
  return `${user.slice(0, 1)}***@${domain}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

export function redactString(value: string): string {
  return value.replace(BEARER, 'Bearer [REDACTED]').replace(TOKEN_LIKE, '[REDACTED]');
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return '[TRUNCATED]' as T;
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) } as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k)) out[k] = '[REDACTED]';
      else if (EMAIL_KEYS.test(k) && typeof v === 'string') out[k] = maskEmail(v);
      else if (PHONE_KEYS.test(k) && typeof v === 'string') out[k] = maskPhone(v);
      else out[k] = redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
