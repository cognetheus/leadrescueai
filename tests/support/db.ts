import { openDatabase, type AppDatabase } from '../../src/db/connection';
import { migrate } from '../../src/db/migrate';
import { createRepositories, type Repositories } from '../../src/db/repositories';
import { ManualClock } from '../../src/shared/clock';
import { SecretBox } from '../../src/shared/crypto';

export const TEST_KEY = Buffer.alloc(32, 9).toString('base64');

export function memoryDb(): { db: AppDatabase; repos: Repositories; clock: ManualClock } {
  const db = openDatabase(':memory:');
  migrate(db);
  const clock = new ManualClock(Date.UTC(2026, 0, 1, 12));
  return { db, clock, repos: createRepositories(db, clock, new SecretBox(TEST_KEY)) };
}

export function seedTenant(repos: Repositories, slug = 'acme-roofing') {
  return repos.tenants.create({ slug, name: slug, metaPageId: `page-${slug}`, crmLocationId: `loc-${slug}` });
}
