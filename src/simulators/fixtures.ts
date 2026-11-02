/**
 * Deterministic fixture generation. The same seed always yields the same lead, so demos
 * and tests are reproducible. Contact data is fictional by construction: phone numbers
 * use the reserved 555-01xx range and emails use the reserved example.com domain.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Maria', 'James', 'Priya', 'Daniel', 'Aisha', 'Tom', 'Elena', 'Marcus', 'Grace', 'Luis', 'Hannah', 'Omar', 'Chloe', 'Wei', 'Sofia', 'Ethan'];
const LAST = ['Garcia', 'Okafor', 'Patel', 'Nguyen', 'Johnson', 'Kowalski', 'Rossi', 'Haddad', 'Bennett', 'Silva', 'Kim', 'Moreau', 'Fischer', 'Torres'];
const ZIPS = ['78701', '78704', '78745', '78758', '78613', '78664', '78681', '78726'];

export const TENANT_FIXTURES = [
  {
    slug: 'acme-roofing', name: 'Acme Roofing & Exteriors', metaPageId: '104729384710001', crmLocationId: 'loc_acme_roofing',
    services: ['Roof repair', 'Full roof replacement', 'Storm damage inspection', 'Gutter installation'],
  },
  {
    slug: 'summit-hvac', name: 'Summit Heating & Air', metaPageId: '104729384710002', crmLocationId: 'loc_summit_hvac',
    services: ['AC repair', 'Furnace replacement', 'Heat pump install', 'Duct cleaning'],
  },
] as const;
export type TenantFixture = (typeof TENANT_FIXTURES)[number];

export interface LeadFixture {
  id: string;
  formId: string;
  fields: Record<string, string>;
}

export function generateLead(seed: number, tenant: TenantFixture, variant: 'complete' | 'missing_contact' = 'complete'): LeadFixture {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const first = pick(FIRST);
  const last = pick(LAST);
  const fields: Record<string, string> = {
    full_name: `${first} ${last}`,
    email: `${first}.${last}${Math.floor(rnd() * 90 + 10)}@example.com`.toLowerCase(),
    phone_number: `(512) 555-01${String(Math.floor(rnd() * 100)).padStart(2, '0')}`,
    zip_code: pick(ZIPS),
    service_type: pick(tenant.services),
    project_timeline: pick(['ASAP', 'Within 2 weeks', 'Within a month', 'Just researching']),
  };
  if (variant === 'missing_contact') {
    delete fields.email;
    delete fields.phone_number;
  }
  // Meta lead ids are numeric strings; derive one from the seed for repeatability.
  return { id: String(2_000_000_000_000 + (seed % 1_000_000_000)), formId: `form-${tenant.slug}`, fields };
}
