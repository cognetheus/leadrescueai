import { PinoLogger } from '@mastra/loggers';
import type { IMastraLogger } from '@mastra/core/logger';
import { redact } from './redact';

export interface LogContext {
  correlationId?: string;
  tenantId?: string;
  leadId?: string;
  deliveryId?: string;
  attemptId?: string;
  jobId?: string;
  incidentId?: string;
  [key: string]: unknown;
}

export interface AppLogger {
  debug(message: string, ctx?: LogContext): void;
  info(message: string, ctx?: LogContext): void;
  warn(message: string, ctx?: LogContext): void;
  error(message: string, ctx?: LogContext): void;
  child(ctx: LogContext): AppLogger;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/** Mastra's own logger; shared so framework and application logs use one sink and format. */
export function createMastraLogger(level: Level = 'info'): IMastraLogger {
  return new PinoLogger({
    name: 'LeadRescue',
    level,
    prettyPrint: process.env.LOG_FORMAT !== 'json',
    redact: {
      paths: ['*.accessToken', '*.refreshToken', '*.clientSecret', '*.authorization', '*.headers.authorization'],
      censor: '[REDACTED]',
    },
  });
}

export function createAppLogger(base: IMastraLogger, bound: LogContext = {}): AppLogger {
  const emit = (level: Level, message: string, ctx?: LogContext) => {
    base[level](message, redact({ ...bound, ...ctx }));
  };
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (ctx) => createAppLogger(base, { ...bound, ...ctx }),
  };
}

/** Logger that discards output; used by tests that assert on durable records instead. */
export const silentLogger: AppLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
