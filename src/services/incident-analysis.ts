import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { checkOllama, ollamaModel } from '../ai/ollama';
import type { AppConfig } from '../config/env';
import type { Repositories } from '../db/repositories';
import { IncidentAssessmentSchema, type IncidentAssessment, type PolicyDecision, type StoredAssessment } from '../domain/assessment';
import type { AppLogger } from '../shared/logger';
import { authorizeOperatorAction } from './action-policy';
import { validateAssessment } from './assessment-validator';
import { buildFallbackAssessment } from './fallback-assessment';
import type { EvidenceBundle } from './incident-evidence';

/** Produces a raw (untrusted) assessment for an evidence bundle. */
export interface AssessmentGenerator {
  readonly model: string;
  generate(bundle: EvidenceBundle, opts: { signal: AbortSignal; requestContext: RequestContext }): Promise<unknown>;
}

export function analysisPrompt(b: EvidenceBundle): string {
  const digest = {
    incident: b.incident,
    delivery: b.delivery && { ref: b.delivery.ref, status: b.delivery.status, trigger: b.delivery.trigger, attemptCount: b.delivery.attemptCount },
    attempts: b.attempts.map((a) => ({ ref: a.ref, number: a.number, status: a.status, failure: a.failure && `${a.failure.failureClass}/${a.failure.code} at ${a.failure.stage}${a.failure.httpStatus ? ` HTTP ${a.failure.httpStatus}` : ''}`, remediation: a.remediation?.action ?? null })),
    timeline: b.timeline.map((e) => ({ ref: e.ref, type: e.type, message: e.message.slice(0, 160) })),
    actionsPerformed: b.actionsPerformed,
    credentialStatus: b.credential?.status ?? null,
  };
  return [
    `Assess incident ${b.incident.ref}. Use your read-only tools to confirm details.`,
    'Evidence digest:',
    JSON.stringify(digest),
    `Citable evidence refs (copy exactly; anything else is rejected): ${JSON.stringify(b.refs)}`,
    'Use only these strings in evidenceRefs. Do not cite field names, words or shortened ids.',
    `Return the structured assessment for incidentId "${b.incident.ref}".`,
  ].join('\n');
}

/** The real generator: the Mastra Incident Analyst agent on local Ollama, with read-only tools. */
export class AgentAssessmentGenerator implements AssessmentGenerator {
  readonly model: string;
  constructor(private mastra: Mastra, private config: AppConfig) {
    this.model = `ollama/${config.OLLAMA_MODEL}`;
  }

  async generate(bundle: EvidenceBundle, opts: { signal: AbortSignal; requestContext: RequestContext }): Promise<unknown> {
    const agent = this.mastra.getAgent('incidentAnalystAgent');
    const res = await agent.generate(analysisPrompt(bundle), {
      requestContext: opts.requestContext,
      abortSignal: opts.signal,
      maxSteps: 6,
      // qwen2.5 cannot combine tool calls with response_format; a second local pass structures the answer.
      structuredOutput: { schema: IncidentAssessmentSchema, model: ollamaModel(this.config) },
    });
    return res.object;
  }
}

export interface ValidatedAssessment {
  source: 'ai' | 'fallback';
  model: string | null;
  assessment: IncidentAssessment;
  validationIssues: string[];
}
export interface FinalAssessment extends ValidatedAssessment {
  policy: PolicyDecision;
}

export interface GenerationResult {
  raw: unknown;
  error: string | null;
  latencyMs: number;
}

/**
 * Workflow D's business logic. The LLM is optional and untrusted: its output is validated
 * against the evidence and the policy engine, and any failure degrades to a deterministic
 * assessment. Nothing here can change deliveries, credentials or CRM records.
 */
export class IncidentAnalysisService {
  constructor(private deps: { repos: Repositories; config: AppConfig; logger: AppLogger }) {}

  async generate(bundle: EvidenceBundle, generator: AssessmentGenerator, requestContext: RequestContext): Promise<GenerationResult> {
    const started = Date.now();
    if (generator instanceof AgentAssessmentGenerator) {
      // The kill switch and health check govern the real local model; injected generators are explicit.
      if (!this.deps.config.AI_ENABLED) return { raw: null, error: 'AI analysis disabled (AI_ENABLED=false)', latencyMs: 0 };
      const status = await checkOllama(this.deps.config);
      if (status.state !== 'ready') return { raw: null, error: `Ollama ${status.state}${'error' in status ? `: ${status.error}` : ''}`, latencyMs: Date.now() - started };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('analysis timed out')), this.deps.config.OLLAMA_TIMEOUT_MS);
    try {
      const raw = await Promise.race([
        generator.generate(bundle, { signal: controller.signal, requestContext }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(`analysis timed out after ${this.deps.config.OLLAMA_TIMEOUT_MS}ms`)))),
      ]);
      return { raw, error: null, latencyMs: Date.now() - started };
    } catch (err) {
      return { raw: null, error: (err as Error).message.slice(0, 300), latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Grounding validation: accepts (possibly corrected) AI output or replaces it with the deterministic fallback. */
  validate(bundle: EvidenceBundle, gen: GenerationResult, model: string): ValidatedAssessment {
    let source: 'ai' | 'fallback' = 'ai';
    let issues: string[];
    let assessment: IncidentAssessment;
    if (gen.error !== null) {
      source = 'fallback';
      issues = [`generation failed: ${gen.error}`];
      assessment = buildFallbackAssessment(bundle, 'local model unavailable');
    } else {
      const v = validateAssessment(gen.raw, bundle);
      issues = v.issues;
      if (v.assessment) assessment = v.assessment;
      else {
        source = 'fallback';
        assessment = buildFallbackAssessment(bundle, 'model output failed grounding validation');
      }
    }
    return { source, model: source === 'ai' ? model : null, assessment, validationIssues: issues };
  }

  /** Policy engine: the suggested operator action stands only if the recorded state permits it. */
  authorize(bundle: EvidenceBundle, v: ValidatedAssessment): FinalAssessment {
    const policy = authorizeOperatorAction(bundle, v.assessment.suggestedAction);
    return { ...v, policy, assessment: policy.authorized ? v.assessment : { ...v.assessment, suggestedAction: policy.finalAction } };
  }

  finalize(bundle: EvidenceBundle, gen: GenerationResult, model: string): FinalAssessment {
    return this.authorize(bundle, this.validate(bundle, gen, model));
  }

  persist(bundle: EvidenceBundle, f: FinalAssessment, latencyMs: number): StoredAssessment {
    const stored = this.deps.repos.incidents.saveAssessment({ incidentId: bundle.incident.ref, ...f, latencyMs });
    const incident = this.deps.repos.incidents.get(bundle.incident.ref)!;
    this.deps.repos.incidents.appendEvent({
      incidentId: incident.id, tenantId: incident.tenantId,
      type: f.source === 'ai' ? 'assessment_generated' : 'assessment_fallback',
      message: f.source === 'ai'
        ? `AI assessment (${f.model}) accepted with ${f.validationIssues.length} correction(s); suggested ${f.assessment.suggestedAction}${f.policy.authorized ? '' : ' (policy override)'}`
        : `Deterministic assessment used: ${f.validationIssues[0] ?? 'no AI output'}`,
      data: { assessmentId: stored.id, source: f.source, policyAuthorized: f.policy.authorized },
    });
    this.deps.logger.info('Incident assessment stored', { incidentId: incident.id, source: f.source, issues: f.validationIssues.length });
    return stored;
  }
}
