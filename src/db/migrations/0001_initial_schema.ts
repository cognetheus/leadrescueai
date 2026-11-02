/**
 * Initial schema. Timestamps are INTEGER milliseconds since epoch (UTC) so lease,
 * retry and deadline comparisons are exact and index-friendly.
 */
export const name = 'initial_schema';

export const sql = /* sql */ `
CREATE TABLE tenants (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9-]*' AND length(slug) BETWEEN 2 AND 40),
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  meta_page_id     TEXT NOT NULL UNIQUE,
  crm_location_id  TEXT NOT NULL UNIQUE,
  created_at       INTEGER NOT NULL
);

-- Secrets are AES-256-GCM encrypted at rest; only non-secret metadata is queryable.
CREATE TABLE credentials (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('meta', 'crm')),
  secret_ciphertext   TEXT NOT NULL,
  access_expires_at   INTEGER,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  version             INTEGER NOT NULL DEFAULT 1,
  refresh_lock_owner  TEXT,
  refresh_lock_until  INTEGER,
  last_refreshed_at   INTEGER,
  updated_at          INTEGER NOT NULL,
  UNIQUE (tenant_id, provider)
);

CREATE TABLE webhook_events (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  source          TEXT NOT NULL,
  body_sha256     TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  lead_count      INTEGER NOT NULL,
  new_deliveries  INTEGER NOT NULL,
  duplicates      INTEGER NOT NULL,
  correlation_id  TEXT NOT NULL,
  received_at     INTEGER NOT NULL
);
CREATE INDEX webhook_events_tenant_received ON webhook_events (tenant_id, received_at);

CREATE TABLE delivery_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO delivery_transitions VALUES
  ('pending', 'processing'), ('pending', 'escalated'),
  ('processing', 'processing'), ('processing', 'delivered'), ('processing', 'retry_scheduled'), ('processing', 'escalated'),
  ('retry_scheduled', 'processing'), ('retry_scheduled', 'escalated'),
  ('escalated', 'pending');

CREATE TABLE deliveries (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  source             TEXT NOT NULL,
  source_lead_id     TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'retry_scheduled', 'delivered', 'escalated')),
  trigger            TEXT NOT NULL CHECK (trigger IN ('webhook', 'reconciliation', 'operator_replay')),
  first_event_id     TEXT REFERENCES webhook_events(id),
  correlation_id     TEXT NOT NULL,
  crm_contact_id     TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  last_failure_class TEXT,
  last_failure_code  TEXT,
  next_attempt_at    INTEGER,
  deadline_at        INTEGER NOT NULL,
  received_at        INTEGER NOT NULL,
  delivered_at       INTEGER,
  escalated_at       INTEGER,
  updated_at         INTEGER NOT NULL,
  -- Idempotency: exactly one delivery per lead per tenant and source.
  UNIQUE (tenant_id, source, source_lead_id),
  -- Success requires a verified CRM contact.
  CHECK (status <> 'delivered' OR (crm_contact_id IS NOT NULL AND delivered_at IS NOT NULL))
);
CREATE UNIQUE INDEX deliveries_tenant_contact ON deliveries (tenant_id, crm_contact_id) WHERE crm_contact_id IS NOT NULL;
CREATE INDEX deliveries_status ON deliveries (status, updated_at);

CREATE TRIGGER deliveries_enforce_transition
BEFORE UPDATE OF status ON deliveries
WHEN NEW.status <> OLD.status
  AND NOT EXISTS (SELECT 1 FROM delivery_transitions WHERE from_status = OLD.status AND to_status = NEW.status)
BEGIN
  SELECT RAISE(ABORT, 'illegal delivery status transition');
END;

CREATE TABLE jobs (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT REFERENCES tenants(id),
  kind              TEXT NOT NULL CHECK (kind IN ('deliver_lead', 'analyze_incident')),
  dedupe_key        TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'succeeded', 'dead', 'cancelled')),
  priority          INTEGER NOT NULL DEFAULT 100,
  run_after         INTEGER NOT NULL,
  claim_count       INTEGER NOT NULL DEFAULT 0,
  max_claims        INTEGER NOT NULL DEFAULT 25,
  lease_owner       TEXT,
  lease_token       TEXT,
  lease_expires_at  INTEGER,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK ((status = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
-- At most one live job per logical unit of work (e.g. one delivery job per delivery).
CREATE UNIQUE INDEX jobs_live_dedupe ON jobs (dedupe_key) WHERE status IN ('queued', 'leased');
CREATE INDEX jobs_ready ON jobs (status, run_after, priority);
CREATE INDEX jobs_lease_expiry ON jobs (status, lease_expires_at);

CREATE TABLE delivery_attempts (
  id               TEXT PRIMARY KEY,
  delivery_id      TEXT NOT NULL REFERENCES deliveries(id),
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  attempt_number   INTEGER NOT NULL,
  job_id           TEXT REFERENCES jobs(id),
  lease_token      TEXT,
  worker_id        TEXT,
  workflow_run_id  TEXT,
  status           TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
  stage_reached    TEXT,
  failure_json     TEXT,
  remediation_json TEXT,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  UNIQUE (delivery_id, attempt_number)
);
CREATE INDEX attempts_delivery ON delivery_attempts (delivery_id, attempt_number);

-- Attempts may be updated only while running (to record their outcome), never afterwards.
CREATE TRIGGER attempts_immutable_when_final
BEFORE UPDATE ON delivery_attempts
WHEN OLD.status <> 'running'
BEGIN
  SELECT RAISE(ABORT, 'finished delivery attempts are immutable');
END;
CREATE TRIGGER attempts_no_delete BEFORE DELETE ON delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'delivery_attempts is append-only');
END;

CREATE TABLE incidents (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  delivery_id     TEXT REFERENCES deliveries(id),
  kind            TEXT NOT NULL CHECK (kind IN ('delivery_failure', 'lost_webhook', 'reconciliation_inconsistency')),
  status          TEXT NOT NULL CHECK (status IN ('open', 'recovered', 'escalated', 'resolved')),
  severity        TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title           TEXT NOT NULL,
  failure_class   TEXT,
  failure_code    TEXT,
  correlation_id  TEXT NOT NULL,
  opened_at       INTEGER NOT NULL,
  closed_at       INTEGER,
  updated_at      INTEGER NOT NULL
);
-- One open incident per delivery: repeated failures extend the same incident timeline.
CREATE UNIQUE INDEX incidents_one_open_per_delivery ON incidents (delivery_id) WHERE status = 'open' AND delivery_id IS NOT NULL;
CREATE INDEX incidents_tenant_opened ON incidents (tenant_id, opened_at);

CREATE TABLE incident_events (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  attempt_id  TEXT REFERENCES delivery_attempts(id),
  data_json   TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX incident_events_incident ON incident_events (incident_id, created_at);

CREATE TABLE incident_assessments (
  id                     TEXT PRIMARY KEY,
  incident_id            TEXT NOT NULL REFERENCES incidents(id),
  source                 TEXT NOT NULL CHECK (source IN ('ai', 'fallback')),
  model                  TEXT,
  assessment_json        TEXT NOT NULL,
  policy_json            TEXT NOT NULL,
  validation_issues_json TEXT NOT NULL,
  latency_ms             INTEGER NOT NULL,
  created_at             INTEGER NOT NULL
);
CREATE INDEX assessments_incident ON incident_assessments (incident_id, created_at);

CREATE TABLE sync_checkpoints (
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  source         TEXT NOT NULL,
  checkpoint_at  INTEGER NOT NULL,
  last_run_id    TEXT,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, source)
);

CREATE TABLE reconciliation_runs (
  id           TEXT PRIMARY KEY,
  trigger      TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status       TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  workflow_run_id TEXT,
  stats_json   TEXT,
  error        TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);

CREATE TABLE reconciliation_findings (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES reconciliation_runs(id),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  source_lead_id  TEXT NOT NULL,
  finding         TEXT NOT NULL CHECK (finding IN ('missing', 'stalled', 'escalated', 'crm_contact_exists')),
  action          TEXT NOT NULL,
  delivery_id     TEXT REFERENCES deliveries(id),
  outcome         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE (run_id, tenant_id, source_lead_id)
);

CREATE TABLE fault_scenario_runs (
  id               TEXT PRIMARY KEY,
  scenario         TEXT NOT NULL,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  source_lead_id   TEXT,
  expected_outcome TEXT NOT NULL,
  fault_rule_ids   TEXT NOT NULL,
  started_at       INTEGER NOT NULL
);

CREATE TABLE audit_events (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT REFERENCES tenants(id),
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  correlation_id  TEXT,
  data_json       TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX audit_entity ON audit_events (entity_type, entity_id, created_at);
CREATE INDEX audit_correlation ON audit_events (correlation_id);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER incident_events_no_update BEFORE UPDATE ON incident_events BEGIN SELECT RAISE(ABORT, 'incident_events is append-only'); END;
CREATE TRIGGER incident_events_no_delete BEFORE DELETE ON incident_events BEGIN SELECT RAISE(ABORT, 'incident_events is append-only'); END;
CREATE TRIGGER assessments_no_update BEFORE UPDATE ON incident_assessments BEGIN SELECT RAISE(ABORT, 'incident_assessments is append-only'); END;
CREATE TRIGGER assessments_no_delete BEFORE DELETE ON incident_assessments BEGIN SELECT RAISE(ABORT, 'incident_assessments is append-only'); END;
`;
