/**
 * Delivery lifecycle. A delivery is the unit of idempotency: exactly one per
 * (tenant, source, source lead id), enforced by a unique index.
 *
 *   pending ──► processing ──► delivered (terminal)
 *      ▲            │  ▲
 *      │            ▼  │ (lease reclaimed after crash)
 *      │      retry_scheduled
 *      │            │
 *      └─ escalated ◄┘  (operator replay returns an escalated delivery to pending)
 */
export const DELIVERY_STATUSES = ['pending', 'processing', 'retry_scheduled', 'delivered', 'escalated'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  pending: ['processing', 'escalated'],
  processing: ['processing', 'delivered', 'retry_scheduled', 'escalated'],
  retry_scheduled: ['processing', 'escalated'],
  escalated: ['pending'],
  delivered: [],
};

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(readonly from: DeliveryStatus, readonly to: DeliveryStatus) {
    super(`Illegal delivery transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const SOURCES = ['meta_lead_ads'] as const;
export type LeadSource = (typeof SOURCES)[number];

export type AttemptOutcome = 'running' | 'succeeded' | 'failed' | 'abandoned';
export type DeliveryTrigger = 'webhook' | 'reconciliation' | 'operator_replay';
