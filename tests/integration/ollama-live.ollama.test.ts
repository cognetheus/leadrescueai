/**
 * Local-model integration test. Runs only with RUN_OLLAMA_TESTS=1 and a running
 * Ollama daemon that has OLLAMA_MODEL pulled (see README).
 */
import { Agent } from '@mastra/core/agent';
import { describe, expect, it } from 'vitest';
import { checkOllama, ollamaModel } from '../../src/ai/ollama';
import { getConfig } from '../../src/config/env';

describe('local Ollama inference', () => {
  const config = getConfig();
  it('is ready and answers through the Mastra model router', async () => {
    const status = await checkOllama(config);
    expect(status.state).toBe('ready');
    const agent = new Agent({ id: 'live-check', name: 'live-check', instructions: 'Be terse.', model: ollamaModel(config) });
    const res = await agent.generate('Reply with exactly the word: pong');
    expect(res.text.toLowerCase()).toContain('pong');
  }, 120_000);
});

describe('Incident Analyst agent with tools (live Ollama)', () => {
  it('calls read-only tools for a real incident and cites recorded refs', async () => {
    const { createHarness } = await import('../support/harness');
    const { incidentAnalystAgent } = await import('../../src/mastra/agents/incident-analyst');
    const { INCIDENT_SCOPE_KEY } = await import('../../src/mastra/tools/incident-tools');
    const h = await createHarness({ AI_ENABLED: 'true', OLLAMA_BASE_URL: getConfig().OLLAMA_BASE_URL, OLLAMA_MODEL: getConfig().OLLAMA_MODEL });
    try {
      const { leadId } = await h.submitLead({ seed: 991, scenario: 'crm_503' });
      await h.drain();
      const d = h.container.repos.deliveries.getByLead(h.tenants['acme-roofing']!.id, 'meta_lead_ads', leadId)!;
      const incident = h.container.repos.incidents.forDelivery(d.id)[0]!;
      const rc = h.requestContext();
      rc.set(INCIDENT_SCOPE_KEY, incident.id);
      const agent = h.mastra.getAgent('incidentAnalystAgent');
      expect(agent.id).toBe(incidentAnalystAgent.id);
      const res = await agent.generate(`Explain incident ${incident.id}. Cite evidence refs.`, { requestContext: rc, maxSteps: 6 });
      const toolNames = res.steps.flatMap((s) => s.toolCalls.map((c) => c.payload?.toolName ?? (c as { toolName?: string }).toolName));
      expect(toolNames.length).toBeGreaterThan(0);
      expect(res.text).toMatch(/inc_|ine_|att_/);
    } finally {
      await h.close();
    }
  }, 240_000);
});
