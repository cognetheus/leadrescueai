import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Mastra } from '@mastra/core/mastra';
import type { Container } from '../container';
import { createJobHandlers } from './handlers';
import { JobRunner } from './runner';

export function workerId(prefix = 'worker'): string {
  return `${prefix}:${hostname().split('.')[0]}:${process.pid}:${randomBytes(3).toString('hex')}`;
}

export function createJobRunner(container: Container, mastra: Mastra, opts: { workerId?: string; concurrency?: number; leaseMs?: number } = {}): JobRunner {
  const { config } = container;
  const runner = new JobRunner({
    queue: container.queue,
    handlers: createJobHandlers(container, mastra),
    workerId: opts.workerId ?? workerId(),
    concurrency: opts.concurrency ?? config.WORKER_CONCURRENCY,
    pollMs: config.WORKER_POLL_MS,
    leaseMs: opts.leaseMs ?? config.JOB_LEASE_MS,
    logger: container.logger,
    now: () => container.clock.now(),
  });
  container.jobListeners.add(() => runner.notify());
  return runner;
}
