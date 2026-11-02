import type { AppConfig } from '../config/env';
import { fetchWithTimeout } from '../shared/http';

type LlmConfig = Pick<AppConfig, 'LLM_PROVIDER' | 'OLLAMA_BASE_URL' | 'OLLAMA_MODEL' | 'OLLAMA_API_KEY'>;

/**
 * Model config for Mastra's model router.
 *
 * - `ollama-cloud`: the router's `ollama-cloud` provider (OpenAI-compatible `https://ollama.com/v1`),
 *   authenticated with OLLAMA_API_KEY. The key is passed explicitly from validated config.
 * - `ollama-local`: a local daemon's OpenAI-compatible `/v1` endpoint (it ignores the key,
 *   but the client requires a non-empty one).
 */
export function ollamaModel(config: LlmConfig) {
  const base = config.OLLAMA_BASE_URL.replace(/\/$/, '');
  return config.LLM_PROVIDER === 'ollama-cloud'
    ? { providerId: 'ollama-cloud', modelId: config.OLLAMA_MODEL, url: `${base}/v1`, apiKey: config.OLLAMA_API_KEY ?? '' }
    : { providerId: 'ollama', modelId: config.OLLAMA_MODEL, url: `${base}/v1`, apiKey: 'ollama-local' };
}

export type OllamaStatus =
  | { state: 'ready'; provider: string; model: string; capabilities: string[]; latencyMs: number }
  | { state: 'model_missing'; provider: string; model: string; available: string[]; latencyMs: number }
  | { state: 'model_unsuitable'; provider: string; model: string; capabilities: string[]; latencyMs: number }
  | { state: 'not_configured'; provider: string; reason: string }
  | { state: 'disabled' }
  | { state: 'unreachable'; provider: string; error: string; latencyMs: number };

interface TagEntry {
  name: string;
  remote_host?: string;
  capabilities?: string[];
}

/**
 * Probes the configured Ollama endpoint. Never throws: AI is optional, and callers
 * (readiness, incident analysis) degrade to deterministic fallbacks on any non-ready state.
 *
 * The probe spends no tokens: it checks the model catalog (`/api/tags`, public on ollama.com)
 * for the model and its tool-calling capability. API-key validity is only provable by an
 * inference call, which `pnpm ollama:smoke` performs on demand.
 */
export async function checkOllama(config: LlmConfig & Pick<AppConfig, 'AI_ENABLED'>, timeoutMs = 3_000): Promise<OllamaStatus> {
  if (!config.AI_ENABLED) return { state: 'disabled' };
  const provider = config.LLM_PROVIDER;
  if (provider === 'ollama-cloud' && !config.OLLAMA_API_KEY) {
    return { state: 'not_configured', provider, reason: 'OLLAMA_API_KEY is not set (create one at https://ollama.com/settings/keys)' };
  }
  const started = Date.now();
  const base = config.OLLAMA_BASE_URL.replace(/\/$/, '');
  try {
    const tagsRes = await fetchWithTimeout(`${base}/api/tags`, { timeoutMs });
    if (!tagsRes.ok) throw new Error(`/api/tags returned HTTP ${tagsRes.status}`);
    const tags = ((await tagsRes.json()) as { models?: TagEntry[] }).models ?? [];
    // Locally, "-cloud" entries proxy to the hosted service and do not count as local models.
    const available = provider === 'ollama-local' ? tags.filter((m) => !m.remote_host) : tags;
    const wanted = normalizeTag(config.OLLAMA_MODEL);
    const entry = available.find((m) => normalizeTag(m.name) === wanted);
    if (!entry) {
      return { state: 'model_missing', provider, model: config.OLLAMA_MODEL, available: available.map((m) => m.name), latencyMs: Date.now() - started };
    }
    let capabilities = entry.capabilities;
    if (!capabilities) {
      const showRes = await fetchWithTimeout(`${base}/api/show`, {
        timeoutMs, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: config.OLLAMA_MODEL }),
      });
      capabilities = showRes.ok ? (((await showRes.json()) as { capabilities?: string[] }).capabilities ?? []) : [];
    }
    // The Incident Analyst calls read-only tools, so the model must support tool calling.
    if (!capabilities.includes('tools')) {
      return { state: 'model_unsuitable', provider, model: config.OLLAMA_MODEL, capabilities, latencyMs: Date.now() - started };
    }
    return { state: 'ready', provider, model: config.OLLAMA_MODEL, capabilities, latencyMs: Date.now() - started };
  } catch (err) {
    return { state: 'unreachable', provider, error: (err as Error).message, latencyMs: Date.now() - started };
  }
}

function normalizeTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}
