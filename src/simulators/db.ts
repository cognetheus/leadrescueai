import { openDatabase, type AppDatabase } from '../db/connection';

/**
 * Simulator state lives in its own database file. The application never opens it:
 * all access goes through the simulators' HTTP APIs, exactly as with real providers.
 */
const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS meta_pages (
  page_id            TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  app_secret         TEXT NOT NULL,
  page_access_token  TEXT NOT NULL UNIQUE,
  webhook_url        TEXT,
  created_at         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta_leads (
  id             TEXT PRIMARY KEY,
  page_id        TEXT NOT NULL REFERENCES meta_pages(page_id),
  form_id        TEXT NOT NULL,
  created_time   INTEGER NOT NULL,
  field_data     TEXT NOT NULL,
  inserted_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS meta_leads_keyset ON meta_leads (page_id, created_time, id);
CREATE TABLE IF NOT EXISTS meta_webhook_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       TEXT NOT NULL,
  lead_id       TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  http_status   INTEGER,
  fault_rule_id TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_locations (
  location_id    TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  client_id      TEXT NOT NULL UNIQUE,
  client_secret  TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_access_tokens (
  token        TEXT PRIMARY KEY,
  location_id  TEXT NOT NULL REFERENCES crm_locations(location_id),
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_refresh_tokens (
  token        TEXT PRIMARY KEY,
  location_id  TEXT NOT NULL REFERENCES crm_locations(location_id),
  family_id    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active', 'used', 'revoked')),
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_contacts (
  id                  TEXT PRIMARY KEY,
  location_id         TEXT NOT NULL REFERENCES crm_locations(location_id),
  first_name          TEXT,
  last_name           TEXT,
  email               TEXT,
  phone               TEXT,
  postal_code         TEXT,
  source              TEXT,
  external_source_id  TEXT,
  tags                TEXT NOT NULL DEFAULT '[]',
  custom_fields       TEXT NOT NULL DEFAULT '{}',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
-- Like real CRMs, uniqueness of the external id is NOT enforced: preventing duplicates is the caller's job.
CREATE INDEX IF NOT EXISTS crm_contacts_external ON crm_contacts (location_id, external_source_id);

CREATE TABLE IF NOT EXISTS fault_rules (
  id          TEXT PRIMARY KEY,
  target      TEXT NOT NULL,
  scope_key   TEXT,
  match_key   TEXT,
  effect      TEXT NOT NULL,
  remaining   INTEGER,
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fault_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     TEXT NOT NULL,
  label       TEXT NOT NULL,
  target      TEXT NOT NULL,
  scope_key   TEXT,
  match_key   TEXT,
  effect_type TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
`;

export function openSimulatorDb(file: string): AppDatabase {
  const db = openDatabase(file);
  db.exec(SCHEMA);
  return db;
}

export function resetSimulatorDb(db: AppDatabase): void {
  db.exec(`DELETE FROM fault_events; DELETE FROM fault_rules; DELETE FROM crm_contacts; DELETE FROM crm_refresh_tokens;
    DELETE FROM crm_access_tokens; DELETE FROM crm_locations; DELETE FROM meta_webhook_deliveries; DELETE FROM meta_leads; DELETE FROM meta_pages;`);
}
