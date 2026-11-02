import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getConfig, loadConfig, type AppConfig } from '../../src/config/env';

/** Harness env for live-LLM tests: the provider, endpoint, model and key from `.env`. */
export function liveLlmEnv(): Record<string, string> {
  const c = getConfig();
  return { AI_ENABLED: 'true', LLM_PROVIDER: c.LLM_PROVIDER, OLLAMA_BASE_URL: c.OLLAMA_BASE_URL, OLLAMA_MODEL: c.OLLAMA_MODEL, OLLAMA_API_KEY: c.OLLAMA_API_KEY ?? '' };
}

/** Isolated configuration with every database in a fresh temporary directory. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig & { cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'leadrescue-test-'));
  const cfg = loadConfig({
    APP_ENV: 'test',
    LOG_LEVEL: 'error',
    DATA_DIR: dir,
    ADMIN_API_TOKEN: 'test-admin-token-0123456789',
    SIMULATOR_ADMIN_TOKEN: 'test-sim-admin-token-0123456789',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    RETRY_BASE_DELAY_MS: '1000',
    ...overrides,
  });
  return { ...cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
