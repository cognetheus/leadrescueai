import type { SimulatorAdminClient } from '../admin-client';
import type { ScenarioPlan } from './scenarios';

/** Applies a scenario's state mutations and fault rules; returns the installed rule ids. */
export async function installScenario(sim: SimulatorAdminClient, plan: ScenarioPlan, locationId: string): Promise<string[]> {
  for (const m of plan.mutations) {
    if (m === 'expire_access_tokens') await sim.expireAccessTokens(locationId);
    if (m === 'revoke_refresh_tokens') await sim.revokeRefreshTokens(locationId);
  }
  const ids: string[] = [];
  for (const rule of plan.rules) ids.push((await sim.addFault(rule)).rule.id);
  return ids;
}
