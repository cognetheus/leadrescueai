import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkOllama, ollamaModel } from '../../src/ai/ollama';
import { createHealthApp } from '../../src/api/health';
import { createContainer } from '../../src/container';
import { silentLogger } from '../../src/shared/logger';
import { testConfig } from '../support/config';
import { startServer } from '../support/http-server';

/** Minimal fake of the Ollama endpoints the probe uses. */
function fakeOllama(models: Array<{ name: string; remote_host?: string }>, capabilities: string[]) {
  const app = new Hono();
  app.get('/api/tags', (c) => c.json({ models }));
  app.post('/api/show', (c) => c.json({ capabilities }));
  return app;
}

describe('Ollama probe', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterAll(async () => Promise.all(servers.map((s) => s.close())));
  const start = async (app: Hono) => {
    const s = await startServer(app);
    servers.push(s);
    return s.url;
  };
  const cfg = (url: string, model = 'qwen2.5:7b') => ({ OLLAMA_BASE_URL: url, OLLAMA_MODEL: model, AI_ENABLED: true });

  it('reports ready when the model is installed locally with tool support', async () => {
    const url = await start(fakeOllama([{ name: 'qwen2.5:7b' }], ['completion', 'tools']));
    expect((await checkOllama(cfg(url))).state).toBe('ready');
  });

  it('treats cloud-proxied models as not installed', async () => {
    const url = await start(fakeOllama([{ name: 'gpt-oss:120b-cloud', remote_host: 'https://ollama.com' }], ['tools']));
    const status = await checkOllama(cfg(url, 'gpt-oss:120b-cloud'));
    expect(status.state).toBe('model_missing');
  });

  it('rejects models that cannot call tools', async () => {
    const url = await start(fakeOllama([{ name: 'gemma3:latest' }], ['completion']));
    expect((await checkOllama(cfg(url, 'gemma3'))).state).toBe('model_unsuitable');
  });

  it('never throws when the daemon is down', async () => {
    const status = await checkOllama(cfg('http://127.0.0.1:1'), 500);
    expect(status.state).toBe('unreachable');
  });

  it('is skipped entirely when AI is disabled', async () => {
    expect((await checkOllama({ ...cfg('http://127.0.0.1:1'), AI_ENABLED: false })).state).toBe('disabled');
  });

  it('builds an OpenAI-compatible router config for the local daemon', () => {
    expect(ollamaModel({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434/', OLLAMA_MODEL: 'qwen2.5:7b' })).toMatchObject({
      providerId: 'ollama',
      modelId: 'qwen2.5:7b',
      url: 'http://127.0.0.1:11434/v1',
    });
  });
});

describe('health endpoints', () => {
  const config = testConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:1' });
  const container = createContainer({ config, logger: silentLogger });
  const app = createHealthApp(() => container);
  beforeAll(() => undefined);
  afterAll(() => {
    container.db.close();
    config.cleanup();
  });

  it('liveness is unconditional', async () => {
    expect((await app.request('/health/live')).status).toBe(200);
  });

  it('stays ready when Ollama is unreachable (AI is optional)', async () => {
    const res = await app.request('/health/ready');
    const body = (await res.json()) as { ready: boolean; checks: { ai: { state: string } } };
    expect(res.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.checks.ai.state).toBe('unreachable');
  });

  it('reports not ready when the database is unavailable', async () => {
    const broken = createContainer({ config, logger: silentLogger });
    broken.db.close();
    const res = await createHealthApp(() => broken).request('/health/ready');
    expect(res.status).toBe(503);
  });
});
