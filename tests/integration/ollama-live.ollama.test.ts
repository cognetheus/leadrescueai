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
