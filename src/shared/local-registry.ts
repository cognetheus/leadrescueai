import { randomUUID } from 'node:crypto';

/**
 * Process-local object registry.
 *
 * Mastra persists a run's RequestContext into its workflow snapshot (LibSQL), so live
 * objects placed there (database handles, config with secrets, unmasked leads) would be
 * serialized to disk. Only opaque string keys go into the request context; the objects
 * they refer to stay in memory here.
 */
export class LocalRegistry<T> {
  private readonly items = new Map<string, T>();

  register(value: T, key: string = randomUUID()): string {
    this.items.set(key, value);
    return key;
  }

  get(key: unknown): T | undefined {
    return typeof key === 'string' ? this.items.get(key) : undefined;
  }

  release(key: string): void {
    this.items.delete(key);
  }
}
