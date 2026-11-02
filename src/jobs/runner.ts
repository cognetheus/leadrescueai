import type { JobKind } from '../domain/job';
import type { AppLogger } from '../shared/logger';
import type { JobQueue, LeasedJob } from './queue';

/** What a handler wants done with its job. Applied by the runner under the lease. */
export type JobOutcome =
  | { type: 'complete' }
  | { type: 'reschedule'; runAfter: number; reason: string }
  | { type: 'dead'; reason: string };

export interface LeaseHandle {
  readonly job: LeasedJob;
  readonly workerId: string;
  /** Aborted as soon as a heartbeat discovers the lease was lost. */
  readonly signal: AbortSignal;
  /** Re-checks ownership in the database (fencing) right before a commit. */
  stillHeld(): boolean;
}

export type JobHandler = (lease: LeaseHandle) => Promise<JobOutcome>;

export interface RunnerOptions {
  queue: JobQueue;
  handlers: Partial<Record<JobKind, JobHandler>>;
  workerId: string;
  concurrency: number;
  pollMs: number;
  leaseMs: number;
  logger: AppLogger;
  now: () => number;
  /** Delay before re-running a job whose handler threw unexpectedly. */
  crashBackoffMs?: number;
}

/**
 * Polls the durable queue with N concurrent slots. Handlers are kept free of queue
 * mechanics: they return an outcome and the runner applies it, fenced by the lease token.
 */
export class JobRunner {
  private running = false;
  private slots: Promise<void>[] = [];
  private wake: (() => void) | null = null;
  readonly inFlight = new Set<string>();

  constructor(private readonly opts: RunnerOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.logger.info('Job runner started', { workerId: this.opts.workerId, concurrency: this.opts.concurrency });
    this.slots = Array.from({ length: this.opts.concurrency }, (_, i) => this.loop(i));
  }

  async stop(drainTimeoutMs = 10_000): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    const drained = Promise.all(this.slots).then(() => true);
    const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), drainTimeoutMs).unref());
    const ok = await Promise.race([drained, timeout]);
    // Undrained jobs keep their leases, which expire and are reclaimed by the next worker.
    this.opts.logger.info('Job runner stopped', { workerId: this.opts.workerId, drained: ok, abandoned: [...this.inFlight] });
  }

  /** Nudges idle slots to poll immediately (e.g. after a webhook enqueued work). */
  notify(): void {
    this.wake?.();
  }

  private async loop(slot: number): Promise<void> {
    while (this.running) {
      let processed = false;
      try {
        processed = await this.runOnce();
      } catch (err) {
        this.opts.logger.error('Job runner slot error', { slot, error: (err as Error).message });
      }
      if (!processed && this.running) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.opts.pollMs);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
    }
  }

  /** Claims and processes at most one job. Returns whether a job was processed. */
  async runOnce(kinds?: JobKind[]): Promise<boolean> {
    const job = this.opts.queue.claim(this.opts.workerId, this.opts.leaseMs, kinds);
    if (!job) return false;
    await this.process(job);
    return true;
  }

  /** Processes an already-claimed job (also used for inline, targeted processing). */
  async process(job: LeasedJob): Promise<JobOutcome | null> {
    const { queue, leaseMs, logger, workerId } = this.opts;
    const log = logger.child({ jobId: job.id, workerId, kind: job.kind, tenantId: job.tenantId ?? undefined });
    if (job.reclaimedFrom) log.warn('Reclaimed job with expired lease', { previousOwner: job.reclaimedFrom.owner });
    const handler = this.opts.handlers[job.kind];
    if (!handler) {
      queue.kill(job.id, job.leaseToken, `no handler registered for ${job.kind}`);
      return { type: 'dead', reason: 'no handler' };
    }

    const controller = new AbortController();
    const beat = setInterval(() => {
      if (!queue.heartbeat(job.id, job.leaseToken, leaseMs)) {
        log.warn('Lease lost during processing; aborting');
        controller.abort(new Error('lease lost'));
      }
    }, Math.max(250, Math.floor(leaseMs / 3)));
    beat.unref();
    this.inFlight.add(job.id);

    const lease: LeaseHandle = {
      job, workerId, signal: controller.signal,
      stillHeld: () => queue.holdsLease(job.id, job.leaseToken),
    };
    let outcome: JobOutcome;
    try {
      outcome = await handler(lease);
    } catch (err) {
      const message = (err as Error).message;
      log.error('Job handler threw; rescheduling', { error: message });
      outcome = { type: 'reschedule', runAfter: this.opts.now() + (this.opts.crashBackoffMs ?? 5_000), reason: `handler error: ${message}` };
    } finally {
      clearInterval(beat);
      this.inFlight.delete(job.id);
    }

    const applied =
      outcome.type === 'complete'
        ? queue.complete(job.id, job.leaseToken)
        : outcome.type === 'reschedule'
          ? queue.reschedule(job.id, job.leaseToken, outcome.runAfter, outcome.reason)
          : queue.kill(job.id, job.leaseToken, outcome.reason);
    if (!applied) {
      log.warn('Job outcome discarded: lease no longer held', { outcome: outcome.type });
      return null;
    }
    log.debug('Job finished', { outcome: outcome.type });
    return outcome;
  }
}
