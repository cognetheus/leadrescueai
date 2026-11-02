import type { RequestContext } from '@mastra/core/request-context';
import { getConfig, type AppConfig } from './config/env';
import { openDatabase, type AppDatabase } from './db/connection';
import { systemClock, type Clock } from './shared/clock';
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
  return { config, db, clock: overrides.clock ?? systemClock, logger };
}

let defaultContainer: Container | undefined;

export function getContainer(): Container {
  defaultContainer ??= createContainer();
  return defaultContainer;
}

export function setDefaultContainer(container: Container | undefined): void {
  defaultContainer = container;
}

export const CONTAINER_KEY = 'leadrescue.container';

/** Steps prefer a container passed through the request context (tests, workers) over the process default. */
export function resolveContainer(requestContext?: RequestContext): Container {
  const fromContext = requestContext?.get(CONTAINER_KEY) as Container | undefined;
  return fromContext ?? getContainer();
}
