import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type AppDatabase = Database.Database;

/**
 * Opens the application database with the pragmas every process must agree on.
 *
 * - WAL lets the API, workers and Studio read while one writer commits.
 * - busy_timeout makes concurrent writers (several worker processes) wait instead of failing.
 * - foreign_keys is per-connection in SQLite and must be enabled explicitly.
 */
export function openDatabase(file: string): AppDatabase {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE`, taking the write lock up front so that
 * read-then-write sequences (claims, transitions) cannot interleave across processes.
 */
export function immediate<T>(db: AppDatabase, fn: () => T): T {
  return db.transaction(fn).immediate();
}
