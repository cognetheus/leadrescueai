import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { resolveContainer } from '../../container';
import { IncidentAssessmentSchema, OPERATOR_ACTIONS } from '../../domain/assessment';
import { AgentAssessmentGenerator, IncidentAnalysisService, type AssessmentGenerator } from '../../services/incident-analysis';
import { IncidentEvidenceService, type EvidenceBundle } from '../../services/incident-evidence';
import { LocalRegistry } from '../../shared/local-registry';
import { INCIDENT_SCOPE_KEY } from '../tools/incident-tools';

/** Optional generator override (tests, evaluations); referenced from the request context by key. */
export const GENERATOR_KEY = 'leadrescue.generatorRef';
export const generators = new LocalRegistry<AssessmentGenerator>();

const Bundle = z.custom<EvidenceBundle>((v) => typeof v === 'object' && v !== null && 'incident' in v);
const State = z.object({
  incidentId: z.string(),
  bundle: Bundle.optional(),
  generation: z.object({ raw: z.unknown(), error: z.string().nullable(), latencyMs: z.number(), model: z.string() }).optional(),
  validated: z
    .object({ source: z.enum(['ai', 'fallback']), model: z.string().nullable(), assessment: IncidentAssessmentSchema, validationIssues: z.array(z.string()) })
    .optional(),
  policy: z.object({ proposed: z.enum(OPERATOR_ACTIONS), authorized: z.boolean(), finalAction: z.enum(OPERATOR_ACTIONS), reason: z.string() }).optional(),
  assessmentId: z.string().optional(),
});

const services = (rc: Parameters<typeof resolveContainer>[0]) => {
  const c = resolveContainer(rc);
  return { c, analysis: new IncidentAnalysisService({ repos: c.repos, config: c.config, logger: c.logger }) };
};

const gather = createStep({
  id: 'gather-evidence', description: 'Deterministically collect the incident timeline, attempts, credentials and CRM state (read-only)',
  inputSchema: State, outputSchema: State,
  execute: async ({ inputData, requestContext }) => {
    const { c } = services(requestContext);
    const bundle = await new IncidentEvidenceService(c.repos, c.services.crm, c.services.credentials).gather(inputData.incidentId, { includeCrm: true });
    if (!bundle) throw new Error(`incident ${inputData.incidentId} not found`);
    return { ...inputData, bundle };
  },
});

const generate = createStep({
  id: 'generate-assessment', description: 'Ask the local Ollama Incident Analyst (read-only tools) for a structured assessment; bounded by a timeout',
  inputSchema: State, outputSchema: State,
  execute: async ({ inputData, requestContext, mastra }) => {
    const { c, analysis } = services(requestContext);
    const generator = generators.get(requestContext?.get(GENERATOR_KEY)) ?? new AgentAssessmentGenerator(mastra, c.config);
    requestContext?.set(INCIDENT_SCOPE_KEY, inputData.incidentId);
    const gen = await analysis.generate(inputData.bundle!, generator, requestContext!);
    return { ...inputData, generation: { ...gen, model: generator.model } };
  },
});

const validate = createStep({
  id: 'validate-grounding', description: 'Zod schema + grounding checks (evidence refs, invented ids, contact data); deterministic fallback on failure',
  inputSchema: State, outputSchema: State,
  execute: async ({ inputData, requestContext }) => {
    const { analysis } = services(requestContext);
    const g = inputData.generation!;
    const v = analysis.validate(inputData.bundle!, { raw: g.raw, error: g.error, latencyMs: g.latencyMs }, g.model);
    return { ...inputData, validated: v };
  },
});

const authorize = createStep({
  id: 'authorize-action', description: 'Policy engine decision on the suggested operator action (advisory; nothing is executed)',
  inputSchema: State, outputSchema: State,
  execute: async ({ inputData, requestContext }) => {
    const { analysis } = services(requestContext);
    const f = analysis.authorize(inputData.bundle!, inputData.validated!);
    return { ...inputData, validated: { source: f.source, model: f.model, assessment: f.assessment, validationIssues: f.validationIssues }, policy: f.policy };
  },
});

const persist = createStep({
  id: 'persist-assessment', description: 'Append the assessment and an incident timeline event',
  inputSchema: State, outputSchema: State,
  execute: async ({ inputData, requestContext }) => {
    const { analysis } = services(requestContext);
    const v = inputData.validated!;
    const stored = analysis.persist(inputData.bundle!, { ...v, policy: inputData.policy! }, inputData.generation!.latencyMs);
    return { ...inputData, assessmentId: stored.id };
  },
});

export const incidentAnalysisWorkflow = createWorkflow({
  id: 'incident-analysis',
  description: 'Workflow D: grounded, policy-checked incident assessment by a local LLM with deterministic fallback',
  inputSchema: State,
  outputSchema: State,
})
  .then(gather)
  .then(generate)
  .then(validate)
  .then(authorize)
  .then(persist)
  .commit();
