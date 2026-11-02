import { createHash } from 'node:crypto';
import type { AppDatabase } from './connection';
import * as m0001 from './migrations/0001_initial_schema';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered migrations. Embedded as modules so they survive bundling by `mastra build`. */
export const MIGRATIONS: Migration[] = [{ version: 1, name: m0001.name, sql: m0001.sql }];

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

/**
 * Applies pending migrations in order, each in its own IMMEDIATE transaction.
 * Safe to run concurrently from several processes: the write lock serializes them
 * and the version check inside the transaction makes re-application a no-op.
 * A checksum mismatch on an applied migration aborts startup (schema drift).
 */
export function migrate(db: AppDatabase): { applied: number[]; current: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    db.transaction(() => {
      const row = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(m.version) as
        | { checksum: string }
        | undefined;
      if (row) {
        if (row.checksum !== checksum(m.sql)) {
          throw new Error(`Migration ${m.version} (${m.name}) was modified after being applied`);
        }
        return;
      }
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        m.version, m.name, checksum(m.sql), Date.now(),
      );
      applied.push(m.version);
    }).immediate();
  }
  const current = (db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number }).v;
  return { applied, current };
}
