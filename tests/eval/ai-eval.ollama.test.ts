/**
 * Live-model evaluation of the Incident Analyst (opt-in: `pnpm eval:ai`; uses the configured provider).
 * Generates real incidents for several failure modes, runs the real Ollama analyst,
 * and reports quality metrics. The safety property (every stored assessment is grounded)
 * is asserted; model quality is reported, since it varies by local model.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getConfig } from '../../src/config/env';
import { validateAssessment } from '../../src/services/assessment-validator';
import { IncidentEvidenceService } from '../../src/services/incident-evidence';
import { analyzeWith } from '../support/analysis';
import { liveLlmEnv } from '../support/config';
import { createHarness } from '../support/harness';

const SCENARIOS = ['crm_503', 'timeout_after_commit', 'expired_token', 'missing_required_field', 'verification_mismatch', 'revoked_refresh_token'] as const;

describe('Incident Analyst evaluation (live LLM)', () => {
  it('produces grounded assessments across failure modes', async () => {
    const cfg = getConfig();
    const h = await createHarness({ ...liveLlmEnv(), OLLAMA_TIMEOUT_MS: '180000' });
    const rows: Array<Record<string, unknown>> = [];
    try {
      for (const [i, scenario] of SCENARIOS.entries()) {
        const tenant = scenario === 'revoked_refresh_token' ? 'summit-hvac' : 'acme-roofing';
        const { leadId } = await h.submitLead({ tenant, seed: 5000 + i, scenario });
        await h.drain({ kinds: ['deliver_lead'] });
        const d = h.container.repos.deliveries.getByLead(h.tenants[tenant]!.id, 'meta_lead_ads', leadId)!;
        const incident = h.container.repos.incidents.forDelivery(d.id)[0]!;
        const { stored } = await analyzeWith(h, incident.id);
        const bundle = (await new IncidentEvidenceService(h.container.repos, h.container.services.crm, h.container.services.credentials).gather(incident.id))!;
        const grounded = !validateAssessment(stored.assessment, bundle).critical;
        expect(grounded, `${scenario}: stored assessment must be grounded`).toBe(true);
        rows.push({
          scenario, incidentStatus: incident.status, source: stored.source, latencyMs: stored.latencyMs,
          corrections: stored.source === 'ai' ? stored.validationIssues.length : null,
          rejectionReason: stored.source === 'fallback' ? stored.validationIssues[0] : null,
          proposed: stored.policy.proposed, authorized: stored.policy.authorized, finalAction: stored.policy.finalAction,
          hypothesis: stored.assessment.rootCauseHypothesis.statement,
        });
      }
    } finally {
      await h.close();
    }
    const ai = rows.filter((r) => r.source === 'ai');
    const latencies = rows.map((r) => Number(r.latencyMs)).sort((a, b) => a - b);
    const summary = {
      provider: cfg.LLM_PROVIDER,
      model: cfg.OLLAMA_MODEL,
      runAt: new Date().toISOString(),
      incidents: rows.length,
      aiAccepted: ai.length,
      aiAcceptanceRate: ai.length / rows.length,
      fallbackRate: (rows.length - ai.length) / rows.length,
      policyAuthorizedRate: rows.filter((r) => r.authorized).length / rows.length,
      meanCorrectionsWhenAccepted: ai.length ? ai.reduce((s, r) => s + Number(r.corrections), 0) / ai.length : null,
      latencyMs: { p50: latencies[Math.floor(latencies.length / 2)], max: latencies.at(-1) },
      groundedStored: '100% (asserted)',
    };
    const dir = path.join(cfg.rootDir, 'docs', 'evals');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'latest-ai-eval.json'), JSON.stringify({ summary, rows }, null, 2));
    writeFileSync(path.join(dir, `${summary.runAt.replace(/[:.]/g, '-')}.json`), JSON.stringify({ summary, rows }, null, 2));
    console.table(rows.map(({ hypothesis: _h, ...r }) => r));
    console.log(JSON.stringify(summary, null, 2));
    expect(rows).toHaveLength(SCENARIOS.length);
  }, 1_800_000);
});
