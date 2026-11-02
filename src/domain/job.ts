export const JOB_KINDS = ['deliver_lead', 'analyze_incident'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ['queued', 'leased', 'succeeded', 'dead', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface DeliverLeadPayload {
  deliveryId: string;
  correlationId: string;
}

export interface AnalyzeIncidentPayload {
  incidentId: string;
  correlationId: string;
}

export interface JobPayloads {
  deliver_lead: DeliverLeadPayload;
  analyze_incident: AnalyzeIncidentPayload;
}
