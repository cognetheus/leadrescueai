import { MastraWorker, type WorkerStopOptions } from '@mastra/core/worker';
import type { JobRunner } from './runner';

/**
 * Hosts the durable job runner inside Mastra's worker lifecycle, so `mastra dev`,
 * `mastra build` output and `mastra.startWorkers()` start and drain it with the
 * built-in scheduler. The runner is created lazily: Mastra constructs workers at
 * import time, before the container (and its database) should be opened.
 */
export class LeadJobWorker extends MastraWorker {
  readonly name = 'leadrescue-jobs';
  private runner: JobRunner | null = null;

  constructor(private readonly createRunner: () => JobRunner) {
    super();
  }

  async start(): Promise<void> {
    this.runner ??= this.createRunner();
    this.runner.start();
  }

  async stop(options?: WorkerStopOptions): Promise<void> {
    await this.runner?.stop(options?.drainTimeout ?? 10_000);
  }

  get isRunning(): boolean {
    return this.runner?.isRunning ?? false;
  }

  get jobRunner(): JobRunner | null {
    return this.runner;
  }
}
