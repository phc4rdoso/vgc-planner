import type { TurnResult } from '../domain/simulation/log.ts';
import type { BattleState } from '../domain/simulation/state.ts';
import { simService, store } from '../state/instance.ts';
import type { SimView } from '../state/sim-service.ts';

function readySim(): Extract<SimView, { status: 'ready' }> | undefined {
  const team = store.team; const plan = store.sheet;
  if (!team || !plan) return undefined;
  const sim = simService.compute(team, plan);
  return sim.enabled && sim.status === 'ready' ? sim : undefined;
}

/** The simulated result of a turn in the open tab, when turn results are on and ready. */
export function turnResult(nodeId: string | null | undefined): TurnResult | undefined {
  return nodeId ? readySim()?.results.get(nodeId) : undefined;
}

/**
 * The battle state a turn starts from: its parent's end state, or for a first turn (`parentId` null) the start of
 * the battle. Null when that isn't known yet (turn results off, or the parent turn is unfinished).
 */
export function startStateOf(parentId: string | null | undefined): BattleState | null {
  const sim = readySim();
  if (!sim) return null;
  if (!parentId) return sim.start;
  const r = sim.results.get(parentId);
  return r?.status === 'ready' ? r.state : null;
}
