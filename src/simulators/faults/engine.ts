import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../../db/connection';

export const FAULT_TARGETS = [
  'meta.webhook', 'meta.get_lead', 'meta.list_leads',
  'crm.token', 'crm.search_contacts', 'crm.create_contact', 'crm.get_contact',
] as const;
export type FaultTarget = (typeof FAULT_TARGETS)[number];

export const FaultEffectSchema = z.discriminatedUnion('type', [
  /** Fail before the operation runs (no side effects). */
  z.object({ type: z.literal('http_error'), status: z.number().int().min(400).max(599), retryAfterSec: z.number().int().min(0).max(3600).optional() }),
  /** Run the operation (it commits), then stall past the client's timeout and fail. */
  z.object({ type: z.literal('timeout_after_commit'), delayMs: z.number().int().min(0).max(120_000) }),
  /** Add latency before the operation. */
  z.object({ type: z.literal('delay'), ms: z.number().int().min(0).max(120_000) }),
  /** Webhooks: do not send. */
  z.object({ type: z.literal('drop') }),
  /** Webhooks: send extra copies. */
  z.object({ type: z.literal('duplicate'), copies: z.number().int().min(1).max(5) }),
  /** Reads: return a stale/altered value for one field (data-consistency fault). */
  z.object({ type: z.literal('mutate_field'), field: z.string().min(1), value: z.string().nullable() }),
  /** Source reads: omit fields from the returned lead (partial read). */
  z.object({ type: z.literal('omit_fields'), fields: z.array(z.string().min(1)).min(1) }),
]);
export type FaultEffect = z.infer<typeof FaultEffectSchema>;

export const FaultRuleInputSchema = z.object({
  target: z.enum(FAULT_TARGETS),
  /** Page id (Meta) or location id (CRM); null applies to every tenant. */
  scopeKey: z.string().min(1).nullable().default(null),
  /** Lead id (Meta) or external source id (CRM); null applies to every lead. */
  matchKey: z.string().min(1).nullable().default(null),
  effect: FaultEffectSchema,
  /** How many times the rule fires; null = until removed. */
  remaining: z.number().int().min(1).nullable().default(1),
  label: z.string().min(1).max(100),
});
export type FaultRuleInput = z.input<typeof FaultRuleInputSchema>;

export interface FaultRule {
  id: string;
  target: FaultTarget;
  scopeKey: string | null;
  matchKey: string | null;
  effect: FaultEffect;
  remaining: number | null;
  label: string;
  createdAt: number;
}

export interface FiredFault {
  ruleId: string;
  label: string;
  effect: FaultEffect;
}

/**
 * Deterministic fault injection. Rules are matched in creation order, consumed
 * atomically (so concurrent requests cannot both consume a one-shot fault), and every
 * firing is recorded with its rule id, making each injected failure attributable.
 */
export class FaultEngine {
  constructor(private db: AppDatabase, private now: () => number = Date.now) {}

  add(input: FaultRuleInput): FaultRule {
    const rule = FaultRuleInputSchema.parse(input);
    const id = `flt_${randomUUID().slice(0, 12)}`;
    this.db
      .prepare('INSERT INTO fault_rules (id, target, scope_key, match_key, effect, remaining, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, rule.target, rule.scopeKey, rule.matchKey, JSON.stringify(rule.effect), rule.remaining, rule.label, this.now());
    return this.get(id)!;
  }

  get(id: string): FaultRule | undefined {
    return this.list().find((r) => r.id === id);
  }

  list(): FaultRule[] {
    const rows = this.db.prepare('SELECT * FROM fault_rules ORDER BY created_at, rowid').all() as Array<{
      id: string; target: FaultTarget; scope_key: string | null; match_key: string | null; effect: string; remaining: number | null; label: string; created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id, target: r.target, scopeKey: r.scope_key, matchKey: r.match_key, effect: JSON.parse(r.effect) as FaultEffect,
      remaining: r.remaining, label: r.label, createdAt: r.created_at,
    }));
  }

  /** Consumes and returns the first matching rule, if any. */
  fire(target: FaultTarget, scopeKey: string | null, matchKey: string | null): FiredFault | null {
    return this.db.transaction((): FiredFault | null => {
      const row = this.db
        .prepare(
          `SELECT * FROM fault_rules WHERE target = ? AND (scope_key IS NULL OR scope_key = ?) AND (match_key IS NULL OR match_key = ?)
             AND (remaining IS NULL OR remaining > 0) ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(target, scopeKey, matchKey) as { id: string; effect: string; remaining: number | null; label: string } | undefined;
      if (!row) return null;
      if (row.remaining !== null) {
        if (row.remaining <= 1) this.db.prepare('DELETE FROM fault_rules WHERE id = ?').run(row.id);
        else this.db.prepare('UPDATE fault_rules SET remaining = remaining - 1 WHERE id = ?').run(row.id);
      }
      const effect = JSON.parse(row.effect) as FaultEffect;
      this.db
        .prepare('INSERT INTO fault_events (rule_id, label, target, scope_key, match_key, effect_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.label, target, scopeKey, matchKey, effect.type, this.now());
      return { ruleId: row.id, label: row.label, effect };
    }).immediate();
  }

  events(limit = 200): Array<{ id: number; ruleId: string; label: string; target: string; scopeKey: string | null; matchKey: string | null; effectType: string; createdAt: number }> {
    return this.db
      .prepare('SELECT id, rule_id AS ruleId, label, target, scope_key AS scopeKey, match_key AS matchKey, effect_type AS effectType, created_at AS createdAt FROM fault_events ORDER BY id DESC LIMIT ?')
      .all(limit) as never;
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM fault_rules WHERE id = ?').run(id).changes === 1;
  }

  clear(): number {
    return this.db.prepare('DELETE FROM fault_rules').run().changes;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
