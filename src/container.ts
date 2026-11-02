import type { RequestContext } from '@mastra/core/request-context';
import { getConfig, type AppConfig } from './config/env';
import { openDatabase, type AppDatabase } from './db/connection';
import { migrate } from './db/migrate';
import { createRepositories, type Repositories } from './db/repositories';
import { JobQueue } from './jobs/queue';
import { CrmClient } from './integrations/crm';
import { MetaSourceClient } from './integrations/meta-source';
import { BoundedRetryFailureHandler } from './services/bounded-retry-handler';
import { CredentialService } from './services/credentials';
import { DeliveryPipeline } from './services/delivery-pipeline';
import type { FailureHandler } from './services/failure-handler';
import { IncidentService } from './services/incidents';
import { WebhookIngestionService } from './services/ingestion';
import { systemClock, type Clock } from './shared/clock';
import { SecretBox } from './shared/crypto';
import { LocalRegistry } from './shared/local-registry';
import { createAppLogger, createMastraLogger, type AppLogger } from './shared/logger';

/**
 * Composition root. Mastra steps, routes and workers resolve their dependencies
 * from a container so that business logic stays framework-independent and tests
 * can run several isolated containers (e.g. competing workers) side by side.
 */
export interface Container {
  config: AppConfig;
  db: AppDatabase;
  clock: Clock;
  logger: AppLogger;
  repos: Repositories;
  queue: JobQueue;
  ingestion: WebhookIngestionService;
  /** Listeners invoked after new jobs are committed (used to wake idle workers). */
  jobListeners: Set<() => void>;
  services: Services;
}

export interface Services {
  source: MetaSourceClient;
  crm: CrmClient;
  credentials: CredentialService;
  pipeline: DeliveryPipeline;
  incidents: IncidentService;
  failureHandler: FailureHandler;
}

export interface ContainerOverrides {
  config?: AppConfig;
  db?: AppDatabase;
  clock?: Clock;
  logger?: AppLogger;
}

export function createContainer(overrides: ContainerOverrides = {}): Container {
  const config = overrides.config ?? getConfig();
  const logger = overrides.logger ?? createAppLogger(createMastraLogger(config.LOG_LEVEL));
  const db = overrides.db ?? openDatabase(config.appDbPath);
  // Every process (Studio server, worker, scripts, tests) converges on the same schema before use.
  migrate(db);
  const clock = overrides.clock ?? systemClock;
  const repos = createRepositories(db, clock, new SecretBox(config.CREDENTIALS_ENCRYPTION_KEY));
  const queue = new JobQueue(db, clock);
  const jobListeners = new Set<() => void>();
  const ingestion = new WebhookIngestionService({
    db, repos, queue, clock, logger, deliveryDeadlineMs: config.DELIVERY_DEADLINE_MS,
    onEnqueued: () => jobListeners.forEach((l) => l()),
  });
  const source = new MetaSourceClient(config.SIMULATOR_BASE_URL, config.HTTP_TIMEOUT_MS);
  const crm = new CrmClient(config.SIMULATOR_BASE_URL, config.HTTP_TIMEOUT_MS);
  const credentials = new CredentialService(repos);
  const pipeline = new DeliveryPipeline({ db, repos, clock, logger, source, crm, credentials });
  const incidents = new IncidentService(repos, queue, { assessRecovered: config.AI_ASSESS_RECOVERED });
  const failureHandler = new BoundedRetryFailureHandler(repos, incidents, clock, {
    maxAttempts: config.RETRY_MAX_ATTEMPTS, baseDelayMs: config.RETRY_BASE_DELAY_MS, maxDelayMs: config.RETRY_MAX_DELAY_MS, deadlineMs: config.DELIVERY_DEADLINE_MS,
  });
  const services: Services = { source, crm, credentials, pipeline, incidents, failureHandler };
  return { config, db, clock, logger, repos, queue, ingestion, jobListeners, services };
}

let defaultContainer: Container | undefined;

export function getContainer(): Container {
  defaultContainer ??= createContainer();
  return defaultContainer;
}

export function setDefaultContainer(container: Container | undefined): void {
  defaultContainer = container;
}

export const CONTAINER_KEY = 'leadrescue.containerRef';

const containers = new LocalRegistry<Container>();
const containerKeys = new WeakMap<Container, string>();

/** Opaque, serializable reference to a container, safe to place in a RequestContext. */
export function containerRef(container: Container): string {
  let key = containerKeys.get(container);
  if (!key) {
    key = containers.register(container);
    containerKeys.set(container, key);
  }
  return key;
}

/** Steps prefer a container referenced by the request context (tests, workers) over the process default. */
export function resolveContainer(requestContext?: RequestContext): Container {
  return containers.get(requestContext?.get(CONTAINER_KEY)) ?? getContainer();
}
