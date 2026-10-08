import { oppMons, teamMons } from '../model.ts';
import type { FlowNode, Sheet, Team } from '../types.ts';
import type { CalcEngine } from './engine.ts';
import type { TurnResult } from './log.ts';
import { initState } from './state.ts';
import type { BattleState } from './state.ts';
import { simulateTurn } from './turn.ts';

/**
 * Simulates every turn of a plan. A turn starts from the end state of its parent, so HP, stat stages and
 * fainted Pokémon carry down each branch. A turn whose parent isn't complete is `blocked`.
 */
export function simulatePlan(engine: CalcEngine, team: Team, plan: Sheet): Map<string, TurnResult> {
  return simulateSheet(engine, team, plan).results;
}

/** {@link simulatePlan}, plus `start`: the battle as the first turn begins (leads on the field, entry abilities done). */
export function simulateSheet(engine: CalcEngine, team: Team, plan: Sheet): { results: Map<string, TurnResult>; start: BattleState } {
  const results = new Map<string, TurnResult>();
  const init = initState(engine, plan, teamMons(team), oppMons(plan));
  // A first turn that picks who wins a speed tie between the leads' entry abilities starts its own battle.
  const startFor = (node: FlowNode): typeof init => {
    const decides = init.entryTies.some((t) => t.keys.every((k) => node.tieOrder?.includes(k)));
    return decides ? initState(engine, plan, teamMons(team), oppMons(plan), node.tieOrder) : init;
  };
  const walk = (nodes: FlowNode[], start: BattleState | null, depth: number, over: boolean): void => {
    for (const node of nodes) {
      if (!start) {
        results.set(node.id, over ? { status: 'blocked', over: true } : { status: 'blocked' });
        walk(node.children, null, depth + 1, over);
        continue;
      }
      const first = depth === 1 ? startFor(node) : null;
      const result = simulateTurn(engine, structuredClone(first ? first.st : start), node, first ? first.entry : [], first ? first.entryTies : []);
      results.set(node.id, result);
      const ended = result.status === 'ready' && result.outcome !== null;
      walk(node.children, result.status === 'ready' && !ended ? result.state : null, depth + 1, over || ended);
    }
  };
  walk(plan.children, init.st, 1, false);
  return { results, start: init.st };
}
