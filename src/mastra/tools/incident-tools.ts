import { createTool } from '@mastra/core/tools';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { resolveContainer } from '../../container';
import { IncidentEvidenceService, type EvidenceBundle } from '../../services/incident-evidence';

/** When set (by the analysis workflow), tools refuse to read any other incident. */
export const INCIDENT_SCOPE_KEY = 'leadrescue.incidentScope';

const Input = z.object({ incidentId: z.string().describe('Incident id, e.g. inc_…') });

async function evidence(incidentId: string, requestContext: RequestContext | undefined, includeCrm = false): Promise<EvidenceBundle> {
  const scope = requestContext?.get(INCIDENT_SCOPE_KEY);
  if (typeof scope === 'string' && scope !== incidentId) throw new Error(`Access denied: this analysis is scoped to ${scope}`);
  const c = resolveContainer(requestContext);
  const svc = new IncidentEvidenceService(c.repos, c.services.crm, c.services.credentials);
  const bundle = await svc.gather(incidentId, { includeCrm });
  if (!bundle) throw new Error(`Incident ${incidentId} not found`);
  return bundle;
}

// All tools are read-only views. None of them can change CRM records, credentials or leads.

export const getIncidentTimeline = createTool({
  id: 'get-incident-timeline',
  description: 'Read-only. Returns the incident summary and its append-only event timeline. Each event has a `ref` you can cite as evidence.',
  inputSchema: Input,
  outputSchema: z.object({ incident: z.any(), timeline: z.array(z.any()) }),
  execute: async ({ incidentId }, ctx) => {
    const b = await evidence(incidentId, ctx?.requestContext);
    return { incident: b.incident, timeline: b.timeline };
  },
});

export const getDeliveryAttempts = createTool({
  id: 'get-delivery-attempts',
  description: 'Read-only. Returns every delivery attempt for the incident with its failure evidence and the remediation the system chose. Cite attempts by `ref`.',
  inputSchema: Input,
  outputSchema: z.object({ attempts: z.array(z.any()), actionsPerformed: z.array(z.string()) }),
  execute: async ({ incidentId }, ctx) => {
    const b = await evidence(incidentId, ctx?.requestContext);
    return { attempts: b.attempts, actionsPerformed: b.actionsPerformed };
  },
});

export const getLeadDelivery = createTool({
  id: 'get-lead-delivery',
  description: 'Read-only. Returns the lead delivery record (status, trigger, timestamps, linked CRM contact ref). Contains no customer contact details.',
  inputSchema: Input,
  outputSchema: z.object({ delivery: z.any() }),
  execute: async ({ incidentId }, ctx) => ({ delivery: (await evidence(incidentId, ctx?.requestContext)).delivery }),
});

export const getCrmState = createTool({
  id: 'get-crm-state',
  description: 'Read-only. Looks up the CRM (GET only) for contacts carrying this lead\'s external source id and returns how many exist and their refs.',
  inputSchema: Input,
  outputSchema: z.object({ crm: z.any() }),
  execute: async ({ incidentId }, ctx) => ({ crm: (await evidence(incidentId, ctx?.requestContext, true)).crm }),
});

export const getCredentialStatus = createTool({
  id: 'get-credential-status',
  description: 'Read-only. Returns the CRM connection status (active/revoked), version and last refresh time. Never returns secrets.',
  inputSchema: Input,
  outputSchema: z.object({ credential: z.any() }),
  execute: async ({ incidentId }, ctx) => ({ credential: (await evidence(incidentId, ctx?.requestContext)).credential }),
});

export const incidentTools = { getIncidentTimeline, getDeliveryAttempts, getLeadDelivery, getCrmState, getCredentialStatus };
