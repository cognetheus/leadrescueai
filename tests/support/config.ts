import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type AppConfig } from '../../src/config/env';

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
