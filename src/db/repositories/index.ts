import type { AppDatabase } from '../connection';
import type { Clock } from '../../shared/clock';
import type { SecretBox } from '../../shared/crypto';
import { AuditRepository } from './audit';
import { CredentialRepository } from './credentials';
import { AttemptRepository, DeliveryRepository, WebhookEventRepository } from './deliveries';
import { IncidentRepository } from './incidents';
import { ReconciliationRepository, ScenarioRunRepository } from './reconciliation';
import { TenantRepository } from './tenants';

export interface Repositories {
  tenants: TenantRepository;
  credentials: CredentialRepository;
  deliveries: DeliveryRepository;
  attempts: AttemptRepository;
  webhookEvents: WebhookEventRepository;
  incidents: IncidentRepository;
  audit: AuditRepository;
  reconciliation: ReconciliationRepository;
  scenarios: ScenarioRunRepository;
}

export function createRepositories(db: AppDatabase, clock: Clock, box: SecretBox): Repositories {
  return {
    tenants: new TenantRepository(db, clock),
    credentials: new CredentialRepository(db, clock, box),
    deliveries: new DeliveryRepository(db, clock),
    attempts: new AttemptRepository(db, clock),
    webhookEvents: new WebhookEventRepository(db),
    incidents: new IncidentRepository(db, clock),
    audit: new AuditRepository(db, clock),
    reconciliation: new ReconciliationRepository(db, clock),
    scenarios: new ScenarioRunRepository(db, clock),
  };
}
