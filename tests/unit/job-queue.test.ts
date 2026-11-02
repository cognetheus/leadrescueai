import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection';
import { migrate } from '../../src/db/migrate';
import { JobQueue } from '../../src/jobs/queue';
import { JobRunner, type JobHandler } from '../../src/jobs/runner';
import { systemClock } from '../../src/shared/clock';
import { silentLogger } from '../../src/shared/logger';
import { memoryDb } from '../support/db';

const payload = (n: number) => ({ deliveryId: `dlv_${n}`, correlationId: `cor_${n}` });

describe('job queue', () => {
  it('keeps one live job per dedupe key', () => {
    const { db, clock } = memoryDb();
    const q = new JobQueue(db, clock);
    const a = q.enqueue('deliver_lead', payload(1), { dedupeKey: 'deliver:1' });
    const b = q.enqueue('deliver_lead', payload(1), { dedupeKey: 'deliver:1' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    const leased = q.claim('w1', 1_000)!;
    q.complete(leased.id, leased.leaseToken);
    expect(q.enqueue('deliver_lead', payload(1), { dedupeKey: 'deliver:1' }).created).toBe(true); // finished jobs free the key
  });

  it('respects run_after and priority', () => {
    const { db, clock } = memoryDb();
    const q = new JobQueue(db, clock);
    q.enqueue('deliver_lead', payload(1), { dedupeKey: 'late', runAfter: clock.now() + 5_000 });
    q.enqueue('deliver_lead', payload(2), { dedupeKey: 'low', priority: 200 });
    q.enqueue('analyze_incident', { incidentId: 'inc_1', correlationId: 'c' }, { dedupeKey: 'high', priority: 10 });
    for (const expected of ['high', 'low']) {
      const j = q.claim('w', 1_000)!;
      expect(j.dedupeKey).toBe(expected);
      q.complete(j.id, j.leaseToken);
    }
    expect(q.claim('w', 1_000)).toBeNull();
    clock.advance(5_000);
    expect(q.claim('w', 1_000)!.dedupeKey).toBe('late');
  });

  it('fences a worker whose lease expired and was taken over', () => {
    const { db, clock } = memoryDb();
    const q = new JobQueue(db, clock);
    q.enqueue('deliver_lead', payload(1), { dedupeKey: 'k' });
    const a = q.claim('worker-a', 1_000)!;
    expect(q.claim('worker-b', 1_000)).toBeNull(); // exclusive while the lease is valid
    clock.advance(1_001);
    const b = q.claim('worker-b', 1_000)!;
    expect(b.reclaimedFrom).toEqual({ owner: 'worker-a', expiredAt: a.leaseExpiresAt });
    expect(q.holdsLease(a.id, a.leaseToken)).toBe(false);
    expect(q.complete(a.id, a.leaseToken)).toBe(false); // stale worker cannot commit
    expect(q.heartbeat(a.id, a.leaseToken, 1_000)).toBe(false);
    expect(q.complete(b.id, b.leaseToken)).toBe(true);
  });

  it('heartbeats extend the lease', () => {
    const { db, clock } = memoryDb();
    const q = new JobQueue(db, clock);
    q.enqueue('deliver_lead', payload(1), { dedupeKey: 'k' });
    const a = q.claim('a', 1_000)!;
    clock.advance(900);
    expect(q.heartbeat(a.id, a.leaseToken, 1_000)).toBe(true);
    clock.advance(900);
    expect(q.claim('b', 1_000)).toBeNull();
    expect(q.holdsLease(a.id, a.leaseToken)).toBe(true);
  });

  it('moves crash-looping jobs to dead after max claims', () => {
    const { db, clock } = memoryDb();
    const q = new JobQueue(db, clock);
    const { job } = q.enqueue('deliver_lead', payload(1), { dedupeKey: 'k', maxClaims: 3 });
    for (let i = 0; i < 3; i++) {
      expect(q.claim('w', 100)).not.toBeNull();
      clock.advance(101); // worker "dies" each time
    }
    expect(q.claim('w', 100)).toBeNull();
    expect(q.get(job.id)!.status).toBe('dead');
  });
});

describe('job runner', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const fileDb = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'leadrescue-jobs-'));
    dirs.push(dir);
    const file = path.join(dir, 'app.db');
    migrate(openDatabase(file));
    return file;
  };

  it('reschedules a job whose handler throws and completes it on the next run', async () => {
    const { db, clock } = memoryDb();
    const queue = new JobQueue(db, clock);
    const { job } = queue.enqueue('deliver_lead', payload(1), { dedupeKey: 'k' });
    let calls = 0;
    const handler: JobHandler = async () => {
      if (++calls === 1) throw new Error('boom');
      return { type: 'complete' };
    };
    const runner = new JobRunner({ queue, handlers: { deliver_lead: handler }, workerId: 'w', concurrency: 1, pollMs: 10, leaseMs: 5_000, logger: silentLogger, now: () => clock.now(), crashBackoffMs: 1_000 });
    await runner.runOnce();
    expect(queue.get(job.id)).toMatchObject({ status: 'queued', lastError: 'handler error: boom' });
    expect(await runner.runOnce()).toBe(false); // backoff not elapsed
    clock.advance(1_000);
    await runner.runOnce();
    expect(queue.get(job.id)!.status).toBe('succeeded');
  });

  it('competing workers on separate connections process every job exactly once', async () => {
    const file = fileDb();
    const setup = openDatabase(file);
    setup.exec('CREATE TABLE processed (job_id TEXT NOT NULL, worker TEXT NOT NULL)');
    const seedQueue = new JobQueue(setup, systemClock);
    for (let i = 0; i < 60; i++) seedQueue.enqueue('deliver_lead', payload(i), { dedupeKey: `k${i}` });

    const runners = Array.from({ length: 4 }, (_, w) => {
      const db = openDatabase(file); // independent connection, like a separate process
      const queue = new JobQueue(db, systemClock);
      const handler: JobHandler = async (lease) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        db.prepare('INSERT INTO processed (job_id, worker) VALUES (?, ?)').run(lease.job.id, `w${w}`);
        return { type: 'complete' };
      };
      return new JobRunner({ queue, handlers: { deliver_lead: handler }, workerId: `w${w}`, concurrency: 3, pollMs: 5, leaseMs: 10_000, logger: silentLogger, now: Date.now });
    });
    runners.forEach((r) => r.start());
    for (let i = 0; i < 400; i++) {
      const done = (setup.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'succeeded'").get() as { n: number }).n;
      if (done === 60) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await Promise.all(runners.map((r) => r.stop()));
    const perJob = setup.prepare('SELECT job_id, count(*) AS n FROM processed GROUP BY job_id').all() as Array<{ n: number }>;
    const workers = setup.prepare('SELECT count(DISTINCT worker) AS n FROM processed').get() as { n: number };
    expect(perJob).toHaveLength(60);
    expect(perJob.every((r) => r.n === 1)).toBe(true);
    expect(workers.n).toBeGreaterThan(1);
  });

  it('recovers a job from a crashed worker after its lease expires (restart recovery)', async () => {
    const file = fileDb();
    const q0 = new JobQueue(openDatabase(file), systemClock);
    const { job } = q0.enqueue('deliver_lead', payload(1), { dedupeKey: 'k' });

    // Worker A claims the job and then "crashes": its handler never returns and its process is gone.
    const dbA = openDatabase(file);
    const queueA = new JobQueue(dbA, systemClock);
    const leasedByA = queueA.claim('worker-a', 300)!;
    expect(leasedByA.id).toBe(job.id);
    dbA.close();

    // A new worker process starts later and takes over once the lease has expired.
    const seen: Array<{ owner: string | null } | null> = [];
    const queueB = new JobQueue(openDatabase(file), systemClock);
    const runnerB = new JobRunner({
      queue: queueB, workerId: 'worker-b', concurrency: 1, pollMs: 20, leaseMs: 5_000, logger: silentLogger, now: Date.now,
      handlers: { deliver_lead: async (lease) => { seen.push(lease.job.reclaimedFrom); return { type: 'complete' }; } },
    });
    expect(await runnerB.runOnce()).toBe(false); // lease still valid
    await new Promise((r) => setTimeout(r, 350));
    expect(await runnerB.runOnce()).toBe(true);
    expect(seen[0]?.owner).toBe('worker-a');
    expect(q0.get(job.id)).toMatchObject({ status: 'succeeded', claimCount: 2 });
  });

  it('aborts the handler and discards its outcome when the lease is lost mid-flight', async () => {
    const file = fileDb();
    const db = openDatabase(file);
    const queue = new JobQueue(db, systemClock);
    const { job } = queue.enqueue('deliver_lead', payload(1), { dedupeKey: 'k' });
    let aborted = false;
    const runner = new JobRunner({
      queue, workerId: 'slow', concurrency: 1, pollMs: 10, leaseMs: 300, logger: silentLogger, now: Date.now,
      handlers: {
        deliver_lead: async (lease) => {
          // Another worker steals the lease (simulating a long GC pause on this one).
          db.prepare("UPDATE jobs SET lease_token = 'stolen' WHERE id = ?").run(job.id);
          await new Promise((r) => setTimeout(r, 400));
          aborted = lease.signal.aborted;
          return { type: 'complete' };
        },
      },
    });
    await runner.runOnce();
    expect(aborted).toBe(true);
    expect(queue.get(job.id)!.status).toBe('leased'); // the stale completion was not applied
  });
});
