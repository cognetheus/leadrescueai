import type { AppConfig } from '../config/env';
import { fetchWithTimeout } from '../shared/http';

/**
 * Local Ollama through Mastra's model router.
 *
 * The router's built-in `ollama-cloud` provider targets the paid hosted service, so we
 * use the router's OpenAI-compatible config against the local daemon's `/v1` endpoint.
 * Ollama ignores the API key, but the OpenAI-compatible client requires a non-empty one.
 */
export function ollamaModel(config: Pick<AppConfig, 'OLLAMA_BASE_URL' | 'OLLAMA_MODEL'>) {
  return {
    providerId: 'ollama',
    modelId: config.OLLAMA_MODEL,
    url: `${config.OLLAMA_BASE_URL.replace(/\/$/, '')}/v1`,
    apiKey: 'ollama-local',
  };
}

export type OllamaStatus =
  | { state: 'ready'; model: string; capabilities: string[]; latencyMs: number }
  | { state: 'model_missing'; model: string; installed: string[]; latencyMs: number }
  | { state: 'model_unsuitable'; model: string; capabilities: string[]; latencyMs: number }
  | { state: 'disabled' }
  | { state: 'unreachable'; error: string; latencyMs: number };

/**
 * Probes the local daemon. Never throws: AI is an optional dependency, and callers
 * (readiness probe, incident analysis) degrade to deterministic fallbacks on any non-ready state.
 */
export async function checkOllama(
  config: Pick<AppConfig, 'OLLAMA_BASE_URL' | 'OLLAMA_MODEL' | 'AI_ENABLED'>,
  timeoutMs = 2_000,
): Promise<OllamaStatus> {
  if (!config.AI_ENABLED) return { state: 'disabled' };
  const started = Date.now();
  const base = config.OLLAMA_BASE_URL.replace(/\/$/, '');
  try {
    const tagsRes = await fetchWithTimeout(`${base}/api/tags`, { timeoutMs });
    if (!tagsRes.ok) throw new Error(`/api/tags returned HTTP ${tagsRes.status}`);
    const tags = (await tagsRes.json()) as { models?: Array<{ name: string; remote_host?: string }> };
    // Remote ("-cloud") models proxy to a hosted service; they do not count as local inference.
    const installed = (tags.models ?? []).filter((m) => !m.remote_host).map((m) => m.name);
    const wanted = normalizeTag(config.OLLAMA_MODEL);
    if (!installed.some((n) => normalizeTag(n) === wanted)) {
      return { state: 'model_missing', model: config.OLLAMA_MODEL, installed, latencyMs: Date.now() - started };
    }
    const showRes = await fetchWithTimeout(`${base}/api/show`, {
      timeoutMs,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.OLLAMA_MODEL }),
    });
    const show = showRes.ok ? ((await showRes.json()) as { capabilities?: string[] }) : {};
    const capabilities = show.capabilities ?? [];
    // The Incident Analyst calls read-only tools, so the model must support tool calling.
    if (!capabilities.includes('tools')) {
      return { state: 'model_unsuitable', model: config.OLLAMA_MODEL, capabilities, latencyMs: Date.now() - started };
    }
    return { state: 'ready', model: config.OLLAMA_MODEL, capabilities, latencyMs: Date.now() - started };
  } catch (err) {
    return { state: 'unreachable', error: (err as Error).message, latencyMs: Date.now() - started };
  }
}

function normalizeTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}
