import { Hono } from 'hono';
import { requireAdmin, type SimulatorDeps } from '../shared';
import { FaultRuleInputSchema } from './engine';

/** Fault injection control plane (admin token required). */
export function createFaultAdminApp(deps: SimulatorDeps): Hono {
  const app = new Hono();
  app.use('/sim-admin/faults/*', requireAdmin(deps.adminToken));
  app.use('/sim-admin/faults', requireAdmin(deps.adminToken));
  app.use('/sim-admin/fault-events', requireAdmin(deps.adminToken));

  app.get('/sim-admin/faults', (c) => c.json({ rules: deps.faults.list() }));
  app.post('/sim-admin/faults', async (c) => {
    const rule = deps.faults.add(FaultRuleInputSchema.parse(await c.req.json()));
    return c.json({ rule }, 201);
  });
  app.delete('/sim-admin/faults/:id', (c) => (deps.faults.remove(c.req.param('id')) ? c.json({ removed: true }) : c.json({ error: 'not found' }, 404)));
  app.delete('/sim-admin/faults', (c) => c.json({ removed: deps.faults.clear() }));
  app.get('/sim-admin/fault-events', (c) => c.json({ events: deps.faults.events(Number(c.req.query('limit') ?? 200)) }));
  return app;
}
