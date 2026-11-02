import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS } from '../../src/db/migrate';
import { StaleStateError } from '../../src/db/repositories/deliveries';
import { InvalidTransitionError } from '../../src/domain/delivery';
import { memoryDb, seedTenant } from '../support/db';

const newDelivery = (repos: ReturnType<typeof memoryDb>['repos'], tenantId: string, leadId = 'lead-1') =>
  repos.deliveries.insertIfAbsent({ tenantId, source: 'meta_lead_ads', sourceLeadId: leadId, trigger: 'webhook', firstEventId: null, correlationId: 'cor_1', deadlineMs: 60_000 });

describe('migrations', () => {
  it('are idempotent and detect tampering', () => {
    const { db } = memoryDb();
    expect(migrate(db)).toEqual({ applied: [], current: MIGRATIONS.length });
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('tampered');
    expect(() => migrate(db)).toThrow(/modified after being applied/);
  });

  it('enforce foreign keys', () => {
    const { repos } = memoryDb();
    expect(() => newDelivery(repos, 'ten_missing')).toThrow(/FOREIGN KEY/);
  });
});

describe('delivery idempotency and state machine', () => {
  it('creates exactly one delivery per tenant/source/lead and isolates tenants', () => {
    const { repos } = memoryDb();
    const a = seedTenant(repos, 'tenant-a');
    const b = seedTenant(repos, 'tenant-b');
    const first = newDelivery(repos, a.id);
    const dup = newDelivery(repos, a.id);
    const otherTenant = newDelivery(repos, b.id);
    expect(first.created).toBe(true);
    expect(dup.created).toBe(false);
    expect(dup.delivery.id).toBe(first.delivery.id);
    expect(otherTenant.created).toBe(true);
    expect(otherTenant.delivery.id).not.toBe(first.delivery.id);
  });

  it('applies compare-and-set transitions and rejects stale writers', () => {
    const { repos } = memoryDb();
    const t = seedTenant(repos);
    const { delivery } = newDelivery(repos, t.id);
    repos.deliveries.transition(delivery.id, ['pending'], 'processing');
    expect(() => repos.deliveries.transition(delivery.id, ['pending'], 'processing')).toThrow(StaleStateError);
    expect(() => repos.deliveries.transition(delivery.id, ['pending'], 'delivered')).toThrow(InvalidTransitionError);
  });

  it('the database itself rejects illegal transitions and success without a CRM contact', () => {
    const { db, repos } = memoryDb();
    const t = seedTenant(repos);
    const { delivery } = newDelivery(repos, t.id);
    expect(() => db.prepare("UPDATE deliveries SET status = 'delivered' WHERE id = ?").run(delivery.id)).toThrow(/illegal delivery status transition/);
    db.prepare("UPDATE deliveries SET status = 'processing' WHERE id = ?").run(delivery.id);
    expect(() => db.prepare("UPDATE deliveries SET status = 'delivered', delivered_at = 1 WHERE id = ?").run(delivery.id)).toThrow(/CHECK constraint/);
  });

  it('prevents two deliveries in one tenant from claiming the same CRM contact', () => {
    const { repos } = memoryDb();
    const t = seedTenant(repos);
    const d1 = newDelivery(repos, t.id, 'lead-1').delivery;
    const d2 = newDelivery(repos, t.id, 'lead-2').delivery;
    repos.deliveries.recordContact(d1.id, 'contact-1');
    expect(() => repos.deliveries.recordContact(d2.id, 'contact-1')).toThrow(/UNIQUE/);
  });
});

describe('append-only histories', () => {
  it('audit and incident events cannot be modified or deleted', () => {
    const { db, repos } = memoryDb();
    const t = seedTenant(repos);
    repos.audit.record({ tenantId: t.id, actor: 'test', action: 'x', entityType: 'tenant', entityId: t.id });
    expect(() => db.prepare("UPDATE audit_events SET action = 'y'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_events').run()).toThrow(/append-only/);
    const inc = repos.incidents.create({ tenantId: t.id, deliveryId: null, kind: 'lost_webhook', title: 't', severity: 'low', failureClass: null, failureCode: null, correlationId: 'c' });
    repos.incidents.appendEvent({ incidentId: inc.id, tenantId: t.id, type: 'detected', message: 'm' });
    expect(() => db.prepare("UPDATE incident_events SET message = 'z'").run()).toThrow(/append-only/);
  });

  it('finished attempts are immutable and numbered per delivery', () => {
    const { db, repos } = memoryDb();
    const t = seedTenant(repos);
    const { delivery } = newDelivery(repos, t.id);
    const a1 = repos.attempts.start({ deliveryId: delivery.id, tenantId: t.id, jobId: null, leaseToken: null, workerId: 'w1' });
    expect(repos.attempts.finish(a1.id, 'failed')).toBe(true);
    const a2 = repos.attempts.start({ deliveryId: delivery.id, tenantId: t.id, jobId: null, leaseToken: null, workerId: 'w1' });
    expect([a1.attemptNumber, a2.attemptNumber]).toEqual([1, 2]);
    expect(repos.attempts.finish(a1.id, 'succeeded')).toBe(false);
    expect(() => db.prepare("UPDATE delivery_attempts SET status = 'succeeded' WHERE id = ?").run(a1.id)).toThrow(/immutable/);
  });

  it('audit data is redacted before it is stored', () => {
    const { repos } = memoryDb();
    repos.audit.record({ actor: 'test', action: 'x', entityType: 'e', entityId: '1', data: { accessToken: 'at_secretsecretsecret', email: 'jo@example.com' } });
    expect(repos.audit.forEntity('e', '1')[0]!.data).toEqual({ accessToken: '[REDACTED]', email: 'j***@example.com' });
  });
});

describe('incidents', () => {
  it('keeps one open incident per delivery', () => {
    const { repos } = memoryDb();
    const t = seedTenant(repos);
    const { delivery } = newDelivery(repos, t.id);
    const base = { tenantId: t.id, deliveryId: delivery.id, kind: 'delivery_failure' as const, title: 'CRM 503', severity: 'medium' as const, failureClass: 'transient' as const, failureCode: 'crm_http_503', correlationId: 'c' };
    const i1 = repos.incidents.openForDelivery(base);
    const i2 = repos.incidents.openForDelivery(base);
    expect(i1.created).toBe(true);
    expect(i2.created).toBe(false);
    expect(i2.incident.id).toBe(i1.incident.id);
    repos.incidents.close(i1.incident.id, 'recovered', 'low');
    expect(repos.incidents.openForDelivery(base).created).toBe(true);
  });
});

describe('credentials', () => {
  const crm = { clientId: 'cid', clientSecret: 'csecret', accessToken: 'at_ACCESSTOKEN0001', refreshToken: 'rt_REFRESHTOKEN0001' };

  it('are encrypted at rest and bound to their tenant', () => {
    const { db, repos } = memoryDb();
    const a = seedTenant(repos, 'tenant-a');
    const b = seedTenant(repos, 'tenant-b');
    repos.credentials.upsert(a.id, 'crm', crm, 1);
    repos.credentials.upsert(b.id, 'crm', { ...crm, accessToken: 'at_OTHER' }, 1);
    const raw = db.prepare('SELECT secret_ciphertext FROM credentials WHERE tenant_id = ?').get(a.id) as { secret_ciphertext: string };
    expect(raw.secret_ciphertext).not.toContain('ACCESSTOKEN');
    expect(repos.credentials.get(a.id, 'crm')!.secrets.accessToken).toBe(crm.accessToken);
    // Swapping ciphertexts between tenants fails authentication (AAD binding).
    db.prepare('UPDATE credentials SET secret_ciphertext = ? WHERE tenant_id = ?').run(raw.secret_ciphertext, b.id);
    expect(() => repos.credentials.get(b.id, 'crm')).toThrow();
  });

  it('serializes refreshes with a lock and optimistic versioning', () => {
    const { repos, clock } = memoryDb();
    const t = seedTenant(repos);
    repos.credentials.upsert(t.id, 'crm', crm, 1);
    const v = repos.credentials.get(t.id, 'crm')!.version;
    expect(repos.credentials.tryAcquireRefreshLock(t.id, 'w1', 10_000)).toBe(true);
    expect(repos.credentials.tryAcquireRefreshLock(t.id, 'w2', 10_000)).toBe(false);
    expect(repos.credentials.saveRefreshed(t.id, v, { ...crm, accessToken: 'at_NEW' }, 2)).toBe(true);
    expect(repos.credentials.saveRefreshed(t.id, v, { ...crm, accessToken: 'at_STALE' }, 3)).toBe(false);
    expect(repos.credentials.tryAcquireRefreshLock(t.id, 'w2', 10_000)).toBe(true);
    clock.advance(20_000);
    expect(repos.credentials.tryAcquireRefreshLock(t.id, 'w3', 10_000)).toBe(true); // expired locks are reclaimable
    expect(repos.credentials.get(t.id, 'crm')!.secrets.accessToken).toBe('at_NEW');
  });
});

describe('reconciliation checkpoints', () => {
  it('only move forward', () => {
    const { repos } = memoryDb();
    const t = seedTenant(repos);
    repos.reconciliation.advanceCheckpoint(t.id, 'meta_lead_ads', 2_000, 'rec_1');
    repos.reconciliation.advanceCheckpoint(t.id, 'meta_lead_ads', 1_000, 'rec_2');
    expect(repos.reconciliation.getCheckpoint(t.id, 'meta_lead_ads')!.checkpointAt).toBe(2_000);
  });
});
