import { z } from 'zod';

/**
 * Canonical lead as returned by the advertising source (Meta Lead Ads, Graph API shape).
 * This is the only trusted lead payload: webhooks carry identifiers, never contact data.
 */
export const SourceLeadSchema = z.object({
  id: z.string().min(1).max(64),
  created_time: z.string().datetime({ offset: true }),
  form_id: z.string().min(1).max(64),
  page_id: z.string().min(1).max(64),
  field_data: z
    .array(z.object({ name: z.string().min(1).max(100), values: z.array(z.string().max(1000)).max(20) }))
    .max(50),
});
export type SourceLead = z.infer<typeof SourceLeadSchema>;

export const NormalizedLeadSchema = z.object({
  sourceLeadId: z.string(),
  formId: z.string(),
  pageId: z.string(),
  createdAt: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  postalCode: z.string().nullable(),
  serviceType: z.string().nullable(),
  answers: z.record(z.string(), z.string()),
});
export type NormalizedLead = z.infer<typeof NormalizedLeadSchema>;

export interface LeadIssue {
  field: string;
  code: 'missing' | 'invalid' | 'too_long';
  message: string;
}

export type LeadValidationResult =
  | { ok: true; lead: NormalizedLead; warnings: LeadIssue[] }
  | { ok: false; issues: LeadIssue[]; warnings: LeadIssue[] };

const KNOWN_FIELDS = new Set([
  'full_name', 'first_name', 'last_name', 'email', 'phone_number', 'phone', 'zip_code', 'post_code', 'service_type',
]);
const MAX_TEXT = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Removes control characters and collapses whitespace; never invents content. */
export function cleanText(value: string | undefined): string | null {
  if (value === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length ? cleaned : null;
}

export function normalizeEmail(value: string | null): string | null | 'invalid' {
  if (!value) return null;
  const lower = value.toLowerCase();
  return EMAIL.test(lower) && lower.length <= 254 ? lower : 'invalid';
}

/** E.164 normalization with North American defaults (the platform serves US/CA contractors). */
export function normalizePhone(value: string | null): string | null | 'invalid' {
  if (!value) return null;
  const hasPlus = value.trim().startsWith('+');
  const digits = value.replace(/\D/g, '');
  if (!hasPlus && digits.length === 10) return `+1${digits}`;
  if (!hasPlus && digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (hasPlus && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return 'invalid';
}

function field(lead: SourceLead, ...names: string[]): string | undefined {
  for (const name of names) {
    const f = lead.field_data.find((d) => d.name === name);
    if (f?.values[0] !== undefined) return f.values[0];
  }
  return undefined;
}

/**
 * Validates and normalizes a canonical lead.
 *
 * Required: a name and at least one valid contact method (email or phone).
 * Invalid optional values are dropped with a warning. Missing data is reported,
 * never synthesized, because a CRM contact with fabricated details is worse than none.
 */
export function validateAndNormalizeLead(input: unknown): LeadValidationResult {
  const parsed = SourceLeadSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      warnings: [],
      issues: parsed.error.issues.map((i) => ({
        field: i.path.join('.') || 'payload',
        code: 'invalid' as const,
        message: i.message,
      })),
    };
  }
  const lead = parsed.data;
  const issues: LeadIssue[] = [];
  const warnings: LeadIssue[] = [];

  let first = cleanText(field(lead, 'first_name'));
  let last = cleanText(field(lead, 'last_name'));
  const full = cleanText(field(lead, 'full_name'));
  if (!first && full) {
    const [head, ...rest] = full.split(' ');
    first = head ?? null;
    last = last ?? (rest.length ? rest.join(' ') : null);
  }
  for (const [name, value] of [['first_name', first], ['last_name', last]] as const) {
    if (value && value.length > MAX_TEXT) issues.push({ field: name, code: 'too_long', message: `${name} exceeds ${MAX_TEXT} characters` });
  }
  if (!first) issues.push({ field: 'full_name', code: 'missing', message: 'Lead has no name' });

  const email = normalizeEmail(cleanText(field(lead, 'email')));
  const phone = normalizePhone(cleanText(field(lead, 'phone_number', 'phone')));
  if (email === 'invalid') warnings.push({ field: 'email', code: 'invalid', message: 'Email address is malformed and was dropped' });
  if (phone === 'invalid') warnings.push({ field: 'phone_number', code: 'invalid', message: 'Phone number is not a valid E.164/NANP number and was dropped' });
  const validEmail = email === 'invalid' ? null : email;
  const validPhone = phone === 'invalid' ? null : phone;
  if (!validEmail && !validPhone) {
    issues.push({ field: 'email|phone_number', code: 'missing', message: 'Lead has no valid email or phone number' });
  }

  const answers: Record<string, string> = {};
  for (const f of lead.field_data) {
    if (KNOWN_FIELDS.has(f.name)) continue;
    const v = cleanText(f.values.join(', '));
    if (v) answers[f.name] = v.slice(0, 500);
  }

  if (issues.length) return { ok: false, issues, warnings };
  return {
    ok: true,
    warnings,
    lead: {
      sourceLeadId: lead.id,
      formId: lead.form_id,
      pageId: lead.page_id,
      createdAt: new Date(lead.created_time).toISOString(),
      firstName: first!,
      lastName: last,
      email: validEmail,
      phone: validPhone,
      postalCode: cleanText(field(lead, 'zip_code', 'post_code'))?.slice(0, 12) ?? null,
      serviceType: cleanText(field(lead, 'service_type'))?.slice(0, 100) ?? null,
      answers,
    },
  };
}
