import type { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { CONTAINER_KEY, containerRef, type Container } from '../container';
import type { FailureEvidence } from '../domain/failure';
import type { JobKind } from '../domain/job';
import { ATTEMPT_KEY, attemptRuntimes, type AttemptRuntime } from '../mastra/workflows/lead-delivery';
import type { AttemptContext } from '../services/delivery-pipeline';
import type { JobHandler, JobOutcome, LeaseHandle } from './runner';

/** Runs one delivery attempt as a `lead-delivery` workflow run, then applies remediation on failure. */
export function deliverLeadHandler(container: Container, mastra: Mastra): JobHandler {
  return async (lease) => {
    const { deliveryId } = lease.job.payload as { deliveryId: string };
    const fence = { jobId: lease.job.id, leaseToken: lease.job.leaseToken, workerId: lease.workerId, stillHeld: lease.stillHeld };
    const begun = container.services.pipeline.begin(deliveryId, fence);
    if (begun.kind === 'skip') {
      container.logger.info('Delivery job skipped', { deliveryId, reason: begun.reason });
      return { type: 'complete' };
    }
    if (begun.interruptedAttempts.length) {
      container.services.incidents.recordInterruption(begun.ctx, begun.interruptedAttempts);
      container.logger.warn('Recovered delivery from an interrupted worker', { deliveryId, interrupted: begun.interruptedAttempts.map((a) => a.id) });
    }
    const runtime: AttemptRuntime = { ctx: begun.ctx, pipeline: container.services.pipeline };
    attemptRuntimes.register(runtime, begun.ctx.attempt.id);
    try {
      return await runAttempt(container, mastra, lease, runtime);
    } finally {
      attemptRuntimes.release(begun.ctx.attempt.id);
    }
  };
}

async function runAttempt(container: Container, mastra: Mastra, lease: LeaseHandle, runtime: AttemptRuntime): Promise<JobOutcome> {
  const { ctx } = runtime;
  const log = container.logger.child({ tenantId: ctx.tenant.id, deliveryId: ctx.delivery.id, attemptId: ctx.attempt.id, correlationId: ctx.delivery.correlationId, leadId: ctx.delivery.sourceLeadId });

  // Only opaque references go into the request context: Mastra persists it with the run snapshot.
  const requestContext = new RequestContext();
  requestContext.set(CONTAINER_KEY, containerRef(container));
  requestContext.set(ATTEMPT_KEY, ctx.attempt.id);

  const run = await mastra.getWorkflow('leadDeliveryWorkflow').createRun({ runId: ctx.attempt.id, resourceId: ctx.tenant.id });
  container.repos.attempts.setWorkflowRun(ctx.attempt.id, run.runId);
  const result = await run.start({
    inputData: {
      attemptId: ctx.attempt.id, attemptNumber: ctx.attempt.attemptNumber, deliveryId: ctx.delivery.id, tenantId: ctx.tenant.id,
      sourceLeadId: ctx.delivery.sourceLeadId, correlationId: ctx.delivery.correlationId, status: 'in_progress',
    },
    requestContext,
    tracingOptions: tracingFor(ctx, lease.job.id),
  });

  if (result.status === 'success') {
    log.info('Lead delivered', { crmContactId: result.result.contactId, origin: result.result.contactOrigin });
    container.services.incidents.recordRecoveryIfOpen(ctx, result.result.contactId!, run.runId);
    return { type: 'complete' };
  }
  const failure: FailureEvidence = runtime.failure ?? {
    failureClass: 'transient', code: 'workflow_failed', stage: 'load',
    message: result.status === 'failed' ? String(result.error?.message ?? result.error) : `workflow ended with status ${result.status}`,
    occurredAt: new Date(container.clock.now()).toISOString(),
  };
  log.warn('Delivery attempt failed', { failureClass: failure.failureClass, code: failure.code, stage: failure.stage });
  return container.services.failureHandler.handle(ctx, failure);
}

export function tracingFor(ctx: AttemptContext, jobId: string) {
  return {
    rootSpanName: `lead-delivery ${ctx.tenant.slug}/${ctx.delivery.sourceLeadId} #${ctx.attempt.attemptNumber}`,
    metadata: {
      tenantId: ctx.tenant.id, tenant: ctx.tenant.slug, deliveryId: ctx.delivery.id, attemptId: ctx.attempt.id, attemptNumber: ctx.attempt.attemptNumber,
      sourceLeadId: ctx.delivery.sourceLeadId, correlationId: ctx.delivery.correlationId, jobId,
    },
    tags: ['lead-delivery', ctx.tenant.slug],
  };
}

export function createJobHandlers(container: Container, mastra: Mastra): Partial<Record<JobKind, JobHandler>> {
  return { deliver_lead: deliverLeadHandler(container, mastra) };
}
