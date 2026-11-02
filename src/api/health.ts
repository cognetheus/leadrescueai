import { Hono } from 'hono';
import { checkOllama, type OllamaStatus } from '../ai/ollama';
import type { Container } from '../container';

export interface ReadinessReport {
  ready: boolean;
  checks: {
    appDatabase: { ok: boolean; error?: string };
    ai: OllamaStatus & { required: false };
  };
}

/**
 * Liveness: the process can serve HTTP. Readiness: it can durably accept work.
 * The local LLM is reported but never gates readiness, because deterministic
 * delivery and recovery must keep running when Ollama is down.
 */
export async function readiness(container: Container): Promise<ReadinessReport> {
  let appDatabase: ReadinessReport['checks']['appDatabase'];
  try {
    container.db.prepare('select 1').get();
    appDatabase = { ok: true };
  } catch (err) {
    appDatabase = { ok: false, error: (err as Error).message };
  }
  const ai = await checkOllama(container.config);
  return { ready: appDatabase.ok, checks: { appDatabase, ai: { ...ai, required: false } } };
}

export function createHealthApp(getContainer: () => Container): Hono {
  const app = new Hono();
  app.get('/health/live', (c) => c.json({ status: 'ok' }));
  app.get('/health/ready', async (c) => {
    const report = await readiness(getContainer());
    return c.json(report, report.ready ? 200 : 503);
  });
  return app;
}
