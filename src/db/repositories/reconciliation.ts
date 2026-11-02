import type { AppDatabase } from '../connection';
import type { Clock } from '../../shared/clock';
import { newId } from '../../shared/ids';

export interface Checkpoint {
  tenantId: string;
  source: string;
  checkpointAt: number;
  lastRunId: string | null;
  updatedAt: number;
}

export type FindingType = 'missing' | 'stalled' | 'escalated' | 'crm_contact_exists';

export interface ReconciliationRun {
  id: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'completed' | 'partial' | 'failed';
  workflowRunId: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface Finding {
  id: string; runId: string; tenantId: string; sourceLeadId: string; finding: FindingType; action: string;
  deliveryId: string | null; outcome: string; createdAt: number;
}

export class ReconciliationRepository {
  constructor(private db: AppDatabase, private clock: Clock) {}

  getCheckpoint(tenantId: string, source: string): Checkpoint | undefined {
    return this.db
      .prepare('SELECT tenant_id AS tenantId, source, checkpoint_at AS checkpointAt, last_run_id AS lastRunId, updated_at AS updatedAt FROM sync_checkpoints WHERE tenant_id = ? AND source = ?')
      .get(tenantId, source) as Checkpoint | undefined;
  }

  /** Checkpoints only move forward, even if two scans race. */
  advanceCheckpoint(tenantId: string, source: string, checkpointAt: number, runId: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_checkpoints (tenant_id, source, checkpoint_at, last_run_id, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, source) DO UPDATE SET
           checkpoint_at = max(sync_checkpoints.checkpoint_at, excluded.checkpoint_at),
           last_run_id = excluded.last_run_id, updated_at = excluded.updated_at`,
      )
      .run(tenantId, source, checkpointAt, runId, this.clock.now());
  }

  startRun(trigger: ReconciliationRun['trigger'], workflowRunId: string | null): ReconciliationRun {
    const now = this.clock.now();
    const id = newId('rec', now);
    this.db.prepare("INSERT INTO reconciliation_runs (id, trigger, status, workflow_run_id, started_at) VALUES (?, ?, 'running', ?, ?)")
      .run(id, trigger, workflowRunId, now);
    return this.getRun(id)!;
  }

  finishRun(id: string, status: Exclude<ReconciliationRun['status'], 'running'>, stats: Record<string, unknown>, error?: string): void {
    this.db.prepare('UPDATE reconciliation_runs SET status = ?, stats_json = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, JSON.stringify(stats), error ?? null, this.clock.now(), id);
  }

  getRun(id: string): ReconciliationRun | undefined {
    const r = this.db.prepare('SELECT * FROM reconciliation_runs WHERE id = ?').get(id) as
      | { id: string; trigger: ReconciliationRun['trigger']; status: ReconciliationRun['status']; workflow_run_id: string | null; stats_json: string | null; error: string | null; started_at: number; finished_at: number | null }
      | undefined;
    return r && {
      id: r.id, trigger: r.trigger, status: r.status, workflowRunId: r.workflow_run_id,
      stats: r.stats_json ? (JSON.parse(r.stats_json) as Record<string, unknown>) : null, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
    };
  }

  listRuns(limit = 20): ReconciliationRun[] {
    const ids = this.db.prepare('SELECT id FROM reconciliation_runs ORDER BY started_at DESC, rowid DESC LIMIT ?').all(limit) as Array<{ id: string }>;
    return ids.map((r) => this.getRun(r.id)!);
  }

  addFinding(f: Omit<Finding, 'id' | 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO reconciliation_findings (id, run_id, tenant_id, source_lead_id, finding, action, delivery_id, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, tenant_id, source_lead_id) DO UPDATE SET outcome = excluded.outcome, delivery_id = excluded.delivery_id`,
      )
      .run(newId('rcf'), f.runId, f.tenantId, f.sourceLeadId, f.finding, f.action, f.deliveryId, f.outcome, this.clock.now());
  }

  findings(runId: string): Finding[] {
    return this.db
      .prepare(
        `SELECT id, run_id AS runId, tenant_id AS tenantId, source_lead_id AS sourceLeadId, finding, action, delivery_id AS deliveryId, outcome, created_at AS createdAt
         FROM reconciliation_findings WHERE run_id = ? ORDER BY created_at, rowid`,
      )
      .all(runId) as Finding[];
  }
}

export interface ScenarioRun {
  id: string; scenario: string; tenantId: string; sourceLeadId: string | null; expectedOutcome: string; faultRuleIds: string[]; startedAt: number;
}

export class ScenarioRunRepository {
  constructor(private db: AppDatabase, private clock: Clock) {}

  record(s: Omit<ScenarioRun, 'id' | 'startedAt'>): ScenarioRun {
    const now = this.clock.now();
    const id = newId('scn', now);
    this.db
      .prepare('INSERT INTO fault_scenario_runs (id, scenario, tenant_id, source_lead_id, expected_outcome, fault_rule_ids, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, s.scenario, s.tenantId, s.sourceLeadId, s.expectedOutcome, JSON.stringify(s.faultRuleIds), now);
    return { ...s, id, startedAt: now };
  }

  list(limit = 50): ScenarioRun[] {
    const rows = this.db.prepare('SELECT * FROM fault_scenario_runs ORDER BY started_at DESC, rowid DESC LIMIT ?').all(limit) as Array<{
      id: string; scenario: string; tenant_id: string; source_lead_id: string | null; expected_outcome: string; fault_rule_ids: string; started_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id, scenario: r.scenario, tenantId: r.tenant_id, sourceLeadId: r.source_lead_id, expectedOutcome: r.expected_outcome,
      faultRuleIds: JSON.parse(r.fault_rule_ids) as string[], startedAt: r.started_at,
    }));
  }
}
