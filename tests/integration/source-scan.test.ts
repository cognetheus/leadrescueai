import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECONCILE_SOURCE, SourceScanner } from '../../src/services/reconciliation';
import { createHarness, type Harness } from '../support/harness';

describe('source pagination and checkpoints (P05.01)', () => {
  let h: Harness;
  let scanner: SourceScanner;
  beforeAll(async () => {
    h = await createHarness({ RECONCILE_PAGE_SIZE: '7', RECONCILE_LOOKBACK_MS: String(10 * 60_000) });
    const c = h.container;
    scanner = new SourceScanner({ repos: c.repos, source: c.services.source, credentials: c.services.credentials, clock: c.clock, logger: c.logger, lookbackMs: c.config.RECONCILE_LOOKBACK_MS, pageSize: c.config.RECONCILE_PAGE_SIZE });
  });
  afterAll(() => h.close());

  const tenant = () => h.tenants['acme-roofing']!;
  const create = (id: string, createdMs: number) =>
    h.sim.createLead(tenant().metaPageId, { id, fields: { full_name: `Lead ${id}`, email: `l${id}@example.com` }, createdTime: new Date(createdMs).toISOString() });

  it('reads every lead across many pages, including timestamp ties at page boundaries', async () => {
    const t0 = h.clock.now() - 3600_000;
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = String(9_031_000 + i);
      ids.push(id);
      await create(id, t0 + Math.floor(i / 5) * 1000); // runs of 5 identical timestamps vs page size 7
    }
    const scan = await scanner.scan(tenant());
    expect(scan.pages).toBeGreaterThanOrEqual(6);
    const found = scan.leads.map((l) => l.id);
    expect(new Set(found).size).toBe(found.length);
    for (const id of ids) expect(found).toContain(id);
  });

  it('advances the checkpoint only when told the segment succeeded', async () => {
    const scan = await scanner.scan(tenant());
    expect(h.container.repos.reconciliation.getCheckpoint(tenant().id, RECONCILE_SOURCE)).toBeUndefined();
    scanner.commitCheckpoint(scan, 'rec_test');
    expect(h.container.repos.reconciliation.getCheckpoint(tenant().id, RECONCILE_SOURCE)!.checkpointAt).toBe(scan.scanStartedAt);
  });

  it('a failed page aborts the scan and leaves the checkpoint untouched', async () => {
    const before = h.container.repos.reconciliation.getCheckpoint(tenant().id, RECONCILE_SOURCE)!;
    await h.sim.addFault({ target: 'meta.list_leads', scopeKey: tenant().metaPageId, effect: { type: 'http_error', status: 503 }, remaining: 1, label: 'list 503' });
    h.clock.advance(60_000);
    await expect(scanner.scan(tenant())).rejects.toMatchObject({ details: { httpStatus: 503 } });
    expect(h.container.repos.reconciliation.getCheckpoint(tenant().id, RECONCILE_SOURCE)).toEqual(before);
  });

  it('the lookback window catches late-arriving leads created before the checkpoint', async () => {
    const cp = h.container.repos.reconciliation.getCheckpoint(tenant().id, RECONCILE_SOURCE)!;
    await create('9039999', cp.checkpointAt - 5 * 60_000); // inside the 10 min lookback
    await create('9039998', cp.checkpointAt - 60 * 60_000); // older than lookback: covered by the first scan already
    h.clock.advance(60_000);
    const scan = await scanner.scan(tenant());
    expect(scan.windowStart).toBe(cp.checkpointAt - 10 * 60_000);
    expect(scan.leads.map((l) => l.id)).toContain('9039999');
    expect(scan.leads.map((l) => l.id)).not.toContain('9039998');
  });
});
