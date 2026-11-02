import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env';
import { redact } from '../../src/shared/redact';
import { newId } from '../../src/shared/ids';

const base = {
  ADMIN_API_TOKEN: 'a'.repeat(24),
  SIMULATOR_ADMIN_TOKEN: 'b'.repeat(24),
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('configuration', () => {
  it('applies defaults and resolves absolute data paths', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.APP_ENV).toBe('development');
    expect(cfg.appDbPath.endsWith('/data/leadrescue.db')).toBe(true);
    expect(cfg.mastraDbUrl.startsWith('file:/')).toBe(true);
    expect(cfg.WORKER_CONCURRENCY).toBe(4);
    expect(cfg.AI_ENABLED).toBe(true);
  });

  it('rejects missing secrets and malformed keys with an actionable message', () => {
    expect(() => loadConfig({})).toThrow(/ADMIN_API_TOKEN/);
    expect(() => loadConfig({ ...base, CREDENTIALS_ENCRYPTION_KEY: 'short' })).toThrow(/32 bytes/);
  });

  it('refuses to run production against local simulators', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'production' })).toThrow(/production/);
  });
});

describe('redaction', () => {
  it('removes secrets and masks customer contact data', () => {
    const out = redact({
      accessToken: 'at_abcdefghijklmnop',
      nested: { email: 'jane.doe@example.com', phone: '+15125550123', note: 'Bearer abc.def' },
      list: ['tok_ABCDEFGHIJKLMNOP'],
    });
    expect(out).toEqual({
      accessToken: '[REDACTED]',
      nested: { email: 'j***@example.com', phone: '***0123', note: 'Bearer [REDACTED]' },
      list: ['[REDACTED]'],
    });
  });
});

describe('ids', () => {
  it('are prefixed and sortable by creation time', () => {
    const a = newId('dlv', 1_000);
    const b = newId('dlv', 2_000);
    expect(a.startsWith('dlv_')).toBe(true);
    expect(a < b).toBe(true);
  });
});
