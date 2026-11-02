import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { checkOllama, ollamaModel } from '../../src/ai/ollama';
import { createHealthApp } from '../../src/api/health';
import { createContainer } from '../../src/container';
import { silentLogger } from '../../src/shared/logger';
import { testConfig } from '../support/config';
import { startServer } from '../support/http-server';

/** Fake of the catalog endpoints. ollama.com returns capabilities inline in /api/tags. */
function fakeCatalog(models: Array<{ name: string; remote_host?: string; capabilities?: string[] }>, showCapabilities: string[] = []) {
  const app = new Hono();
  app.get('/api/tags', (c) => c.json({ models }));
  app.post('/api/show', (c) => c.json({ capabilities: showCapabilities }));
  return app;
}

const servers: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => Promise.all(servers.map((s) => s.close())));
const start = async (app: Hono) => {
  const s = await startServer(app);
  servers.push(s);
  return s.url;
};

describe('Ollama Cloud probe (default provider)', () => {
  const cloud = (url: string, over: Record<string, unknown> = {}) => ({
    LLM_PROVIDER: 'ollama-cloud' as const, OLLAMA_BASE_URL: url, OLLAMA_MODEL: 'gpt-oss:120b', OLLAMA_API_KEY: 'test-key-123', AI_ENABLED: true, ...over,
  });

  it('is not_configured without an API key, without making any request', async () => {
    const status = await checkOllama(cloud('http://127.0.0.1:1', { OLLAMA_API_KEY: undefined }));
    expect(status).toMatchObject({ state: 'not_configured', reason: expect.stringMatching(/OLLAMA_API_KEY/) });
  });

  it('is ready when the catalog lists the model with tool support', async () => {
    const url = await start(fakeCatalog([{ name: 'gpt-oss:120b', capabilities: ['completion', 'tools', 'thinking'] }]));
    expect(await checkOllama(cloud(url))).toMatchObject({ state: 'ready', provider: 'ollama-cloud' });
  });

  it('reports models missing from the catalog or lacking tool calls', async () => {
    const url = await start(fakeCatalog([{ name: 'gpt-oss:20b', capabilities: ['tools'] }, { name: 'plain-model', capabilities: ['completion'] }]));
    expect((await checkOllama(cloud(url))).state).toBe('model_missing');
    expect((await checkOllama(cloud(url, { OLLAMA_MODEL: 'plain-model' }))).state).toBe('model_unsuitable');
  });

  it('never throws when the service is unreachable', async () => {
    expect((await checkOllama(cloud('http://127.0.0.1:1'), 500)).state).toBe('unreachable');
  });

  it('builds a router config for ollama.com with the API key', () => {
    expect(ollamaModel(cloud('https://ollama.com'))).toEqual({ providerId: 'ollama-cloud', modelId: 'gpt-oss:120b', url: 'https://ollama.com/v1', apiKey: 'test-key-123' });
  });

  it('is skipped entirely when AI is disabled', async () => {
    expect((await checkOllama(cloud('http://127.0.0.1:1', { AI_ENABLED: false }))).state).toBe('disabled');
  });
});

describe('local Ollama probe (optional provider)', () => {
  const local = (url: string, model = 'qwen2.5:7b') => ({ LLM_PROVIDER: 'ollama-local' as const, OLLAMA_BASE_URL: url, OLLAMA_MODEL: model, OLLAMA_API_KEY: undefined, AI_ENABLED: true });

  it('needs no key and checks capabilities via /api/show', async () => {
    const url = await start(fakeCatalog([{ name: 'qwen2.5:7b' }], ['completion', 'tools']));
    expect((await checkOllama(local(url))).state).toBe('ready');
  });

  it('does not count cloud-proxied entries as local models', async () => {
    const url = await start(fakeCatalog([{ name: 'gpt-oss:120b-cloud', remote_host: 'https://ollama.com' }], ['tools']));
    expect((await checkOllama(local(url, 'gpt-oss:120b-cloud'))).state).toBe('model_missing');
  });

  it('builds a router config for the local daemon', () => {
    expect(ollamaModel(local('http://127.0.0.1:11434/'))).toMatchObject({ providerId: 'ollama', url: 'http://127.0.0.1:11434/v1' });
  });
});

describe('health endpoints', () => {
  const config = testConfig({ OLLAMA_API_KEY: 'test-key-123', OLLAMA_BASE_URL: 'http://127.0.0.1:1' });
  const container = createContainer({ config, logger: silentLogger });
  const app = createHealthApp(() => container);
  afterAll(() => {
    container.db.close();
    config.cleanup();
  });

  it('liveness is unconditional', async () => {
    expect((await app.request('/health/live')).status).toBe(200);
  });

  it('stays ready when the LLM is unreachable (AI is optional)', async () => {
    const res = await app.request('/health/ready');
    const body = (await res.json()) as { ready: boolean; checks: { ai: { state: string } } };
    expect(res.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.checks.ai.state).toBe('unreachable');
  });

  it('stays ready when no API key is configured', async () => {
    const noKey = testConfig();
    const c = createContainer({ config: noKey, logger: silentLogger });
    const body = (await (await createHealthApp(() => c).request('/health/ready')).json()) as { ready: boolean; checks: { ai: { state: string } } };
    expect(body).toMatchObject({ ready: true, checks: { ai: { state: 'not_configured' } } });
    c.db.close();
    noKey.cleanup();
  });

  it('reports not ready when the database is unavailable', async () => {
    const broken = createContainer({ config, logger: silentLogger });
    broken.db.close();
    expect((await createHealthApp(() => broken).request('/health/ready')).status).toBe(503);
  });
});
