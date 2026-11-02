/** Runs the baseline workflow from a separate process to prove shared durable Mastra storage. */
import { mastra } from '../src/mastra/index';

const run = await mastra.getWorkflow('platformHeartbeatWorkflow').createRun();
const result = await run.start({ inputData: { requestedBy: 'smoke-process' } });
console.log(JSON.stringify({ runId: run.runId, status: result.status, result: result.status === 'success' ? result.result : null }));
await mastra.shutdown?.();
process.exit(result.status === 'success' ? 0 : 1);
