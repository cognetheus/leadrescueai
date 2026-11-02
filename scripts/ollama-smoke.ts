/**
 * Real local inference check through Mastra's model router -> Ollama /v1.
 * Verifies plain generation, tool calling and structured output, the three
 * capabilities the Incident Analyst depends on.
 */
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { checkOllama, ollamaModel } from '../src/ai/ollama';
import { getConfig } from '../src/config/env';

const config = getConfig();
const status = await checkOllama(config);
console.log('health:', JSON.stringify(status));
if (status.state !== 'ready') {
  console.error(`Ollama is not ready (${status.state}). Run: ollama pull ${config.OLLAMA_MODEL}`);
  process.exit(1);
}

let toolCalls = 0;
const lookupDelivery = createTool({
  id: 'lookup-delivery',
  description: 'Returns the recorded status of a lead delivery by its id.',
  inputSchema: z.object({ deliveryId: z.string() }),
  outputSchema: z.object({ deliveryId: z.string(), status: z.string(), attempts: z.number() }),
  execute: async ({ deliveryId }) => {
    toolCalls++;
    return { deliveryId, status: 'delivered', attempts: 3 };
  },
});

const agent = new Agent({
  id: 'ollama-smoke-agent',
  name: 'Ollama smoke agent',
  instructions: 'You answer strictly from tool results. Never invent values.',
  model: ollamaModel(config),
  tools: { lookupDelivery },
});

const t0 = Date.now();
const plain = await agent.generate('Reply with exactly the word: pong');
console.log(`plain (${Date.now() - t0}ms):`, JSON.stringify(plain.text.trim()));

const t1 = Date.now();
const structured = await agent.generate(
  'Use the lookup-delivery tool for delivery dlv_123, then report its status and attempt count.',
  {
    maxSteps: 4,
    structuredOutput: {
      schema: z.object({ deliveryId: z.string(), status: z.string(), attempts: z.number() }),
      // qwen2.5 cannot combine tool calls with `response_format` in one request; a second
      // local structuring pass (Mastra's documented workaround) keeps tool use intact.
      model: ollamaModel(config),
    },
  },
);
console.log(`tool+structured (${Date.now() - t1}ms):`, JSON.stringify(structured.object), 'toolCalls=', toolCalls);

const ok =
  plain.text.toLowerCase().includes('pong') &&
  toolCalls >= 1 &&
  structured.object?.deliveryId === 'dlv_123' &&
  structured.object?.attempts === 3;
console.log(ok ? 'OLLAMA SMOKE: PASS' : 'OLLAMA SMOKE: FAIL');
process.exit(ok ? 0 : 1);
