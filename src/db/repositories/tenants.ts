import type { AppDatabase } from '../connection';
import { newId } from '../../shared/ids';
import type { Clock } from '../../shared/clock';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  metaPageId: string;
  crmLocationId: string;
  createdAt: number;
}

interface Row {
  id: string; slug: string; name: string; status: Tenant['status'];
  meta_page_id: string; crm_location_id: string; created_at: number;
}
const map = (r: Row): Tenant => ({
  id: r.id, slug: r.slug, name: r.name, status: r.status,
  metaPageId: r.meta_page_id, crmLocationId: r.crm_location_id, createdAt: r.created_at,
});

export class TenantRepository {
  constructor(private db: AppDatabase, private clock: Clock) {}

  create(input: { slug: string; name: string; metaPageId: string; crmLocationId: string; id?: string }): Tenant {
    const id = input.id ?? newId('ten');
    this.db
      .prepare('INSERT INTO tenants (id, slug, name, meta_page_id, crm_location_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.slug, input.name, input.metaPageId, input.crmLocationId, this.clock.now());
    return this.get(id)!;
  }

  get(id: string): Tenant | undefined {
    const r = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Row | undefined;
    return r && map(r);
  }

  getBySlug(slug: string): Tenant | undefined {
    const r = this.db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug) as Row | undefined;
    return r && map(r);
  }

  listActive(): Tenant[] {
    return (this.db.prepare("SELECT * FROM tenants WHERE status = 'active' ORDER BY slug").all() as Row[]).map(map);
  }

  list(): Tenant[] {
    return (this.db.prepare('SELECT * FROM tenants ORDER BY slug').all() as Row[]).map(map);
  }
}
