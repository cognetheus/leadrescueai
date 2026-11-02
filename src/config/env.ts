import { z } from 'zod';
import { findProjectRoot, resolveFromRoot } from './paths';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'demo', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATA_DIR: z.string().default('./data'),
  APP_DB_FILE: z.string().default('leadrescue.db'),
  MASTRA_DB_FILE: z.string().default('mastra.db'),
  SIMULATOR_DB_FILE: z.string().default('simulators.db'),

  APP_PUBLIC_URL: z.string().url().default('http://localhost:4111'),
  STUDIO_URL: z.string().url().default('http://localhost:4111'),
  SIMULATOR_PORT: z.coerce.number().int().positive().default(4200),
  SIMULATOR_BASE_URL: z.string().url().default('http://localhost:4200'),
  SIMULATOR_ADMIN_TOKEN: z.string().min(16),
  ADMIN_API_TOKEN: z.string().min(16),
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),

  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen2.5:7b'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  AI_ENABLED: bool.default(true),
  AI_ASSESS_RECOVERED: bool.default(true),

  WORKER_ENABLED: bool.default(true),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  WORKER_POLL_MS: z.coerce.number().int().min(50).default(500),
  JOB_LEASE_MS: z.coerce.number().int().min(1_000).default(30_000),

  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).default(60_000),
  DELIVERY_DEADLINE_MS: z.coerce.number().int().positive().default(30 * 60_000),

  RECONCILE_CRON: z.string().default('*/5 * * * *'),
  RECONCILE_LOOKBACK_MS: z.coerce.number().int().min(0).default(15 * 60_000),
  RECONCILE_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(25),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AppConfig extends RawEnv {
  rootDir: string;
  dataDir: string;
  appDbPath: string;
  mastraDbUrl: string;
  simulatorDbPath: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid LeadRescue configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.APP_ENV === 'production' && env.SIMULATOR_BASE_URL.includes('localhost')) {
    // Simulators are demo infrastructure; a production deployment must point at real providers.
    throw new Error('Refusing to start in production against local simulators.');
  }
  const rootDir = findProjectRoot();
  const dataDir = resolveFromRoot(rootDir, env.DATA_DIR);
  return {
    ...env,
    rootDir,
    dataDir,
    appDbPath: resolveFromRoot(dataDir, env.APP_DB_FILE),
    mastraDbUrl: `file:${resolveFromRoot(dataDir, env.MASTRA_DB_FILE)}`,
    simulatorDbPath: resolveFromRoot(dataDir, env.SIMULATOR_DB_FILE),
  };
}

let cached: AppConfig | undefined;

/** Process-wide configuration, loaded once (including `.env` when present). */
export function getConfig(): AppConfig {
  if (!cached) {
    loadDotEnv();
    cached = loadConfig();
  }
  return cached;
}

function loadDotEnv(): void {
  const file = resolveFromRoot(findProjectRoot(), '.env');
  try {
    process.loadEnvFile(file);
  } catch {
    // No .env file: rely on the real environment.
  }
}
