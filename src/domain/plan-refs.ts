/**
 * Where a team's gameplans mention one of its Pokémon or one of its moves, so the team editor can warn before a
 * change leaves turns pointing at something the team no longer has, and carry a rename over to the plans.
 *
 * Gameplans name the user's Pokémon by species exactly as in the paste: in leads and backs, in each turn's actions
 * (who acts, who they target, who pivots or switches in), and in per-turn keys (`me:Name` for speed order, speed
 * ties and HP; outcome targets by name).
 */
import { parseShowdown } from './showdown.ts';
import type { FlowNode, Plan, PokemonSet, TurnAction } from './types.ts';

export interface PlanUse { plan: string; turns: number }

/** What to look for: one of the user's Pokémon, or one of its moves. */
export type PlanRef = { kind: 'mon'; species: string } | { kind: 'move'; species: string; move: string };

const walk = (nodes: readonly FlowNode[], fn: (n: FlowNode) => void): void => {
  for (const n of nodes) { fn(n); walk(n.children, fn); }
};

/** Whether a name in an action's target/pivot slot is the user's Pokémon `species` (not the opponent's). */
function targetIsMine(action: TurnAction, name: string, species: string, oppSpecies: ReadonlySet<string>): boolean {
  if (name !== species) return false;
  // A move by the opponent aimed at that name is aimed at the user's Pokémon; the user's own move could be aimed at
  // either side, so a mirror match (both teams have it) is read as the foe.
  if (action.side === 'opp') return action.kind === 'move';
  return action.kind === 'switch' || !oppSpecies.has(name);
}

function nodeUses(node: FlowNode, ref: PlanRef, oppSpecies: ReadonlySet<string>): boolean {
  const key = `me:${ref.species}`;
  for (const a of node.actions) {
    if (ref.kind === 'move') { if (a.side === 'me' && a.mon === ref.species && a.kind === 'move' && a.move === ref.move) return true; continue; }
    if (a.side === 'me' && (a.mon === ref.species || a.pivot === ref.species)) return true;
    if (a.target && targetIsMine(a, a.target, ref.species, oppSpecies)) return true;
  }
  if (ref.kind === 'mon') return [...(node.order ?? []), ...(node.tieOrder ?? []), ...Object.keys(node.hpEnd ?? {})].includes(key);
  return false;
}

/** For each gameplan that uses `ref`, how many turns do (leads and backs count as one when no turn does). */
export function findPlanUses(plans: readonly Plan[], ref: PlanRef): PlanUse[] {
  const out: PlanUse[] = [];
  for (const plan of plans) {
    const opp = new Set(parseShowdown(plan.opponent.paste).map((m) => m.species));
    let turns = 0;
    let picked = false;
    for (const tab of plan.tabs) {
      walk(tab.children, (n) => { if (nodeUses(n, ref, opp)) turns++; });
      if (ref.kind === 'mon' && [...tab.selection.me.lead, ...tab.selection.me.back].includes(ref.species)) picked = true;
    }
    if (turns || picked) out.push({ plan: plan.name || 'Untitled gameplan', turns });
  }
  return out;
}

/** "3 turns of “vs Sun” and 1 turn of “vs Rain”", or "the leads of “vs Sun”" when no turn uses it. */
export function describeUses(uses: readonly PlanUse[]): string {
  const parts = uses.map((u) => (u.turns ? `${u.turns} turn${u.turns === 1 ? '' : 's'} of “${u.plan}”` : `the team picks of “${u.plan}”`));
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const renameKey = (key: string, from: string, to: string): string => (key === `me:${from}` ? `me:${to}` : key);

/** Renames the user's Pokémon `from` to `to` everywhere the gameplans mention it. */
export function renameMonInPlans(plans: readonly Plan[], from: string, to: string): void {
  if (!from || !to || from === to) return;
  for (const plan of plans) {
    const opp = new Set(parseShowdown(plan.opponent.paste).map((m) => m.species));
    for (const tab of plan.tabs) {
      for (const kind of ['lead', 'back'] as const) tab.selection.me[kind] = tab.selection.me[kind].map((s) => (s === from ? to : s));
      walk(tab.children, (n) => {
        for (const a of n.actions) {
          if (a.target && targetIsMine(a, a.target, from, opp)) a.target = to;
          if (a.side === 'me') {
            if (a.mon === from) a.mon = to;
            if (a.pivot === from) a.pivot = to;
          }
          // What happened to each target, keyed by name; in a mirror match the name could be either side's, so it stays.
          const targets = a.outcome?.targets;
          if (targets?.[from] && !opp.has(from)) { targets[to] = targets[from]; delete targets[from]; }
        }
        if (n.order) n.order = n.order.map((k) => renameKey(k, from, to));
        if (n.tieOrder) n.tieOrder = n.tieOrder.map((k) => renameKey(k, from, to));
        if (n.hpEnd?.[`me:${from}`] !== undefined) { n.hpEnd[`me:${to}`] = n.hpEnd[`me:${from}`]!; delete n.hpEnd[`me:${from}`]; }
      });
    }
  }
}

/**
 * What a new version of the team does to its gameplans. `renames`: a Pokémon or move the gameplans use was swapped
 * for another one, so the plans could follow; `losses`: one was dropped with nothing in its place.
 */
export interface PlanImpact {
  renames: { kind: 'mon' | 'move'; species: string; from: string; to: string; uses: PlanUse[] }[];
  losses: { kind: 'mon' | 'move'; species: string; name: string; uses: PlanUse[] }[];
}

/**
 * Compares the team before and after a change (one edit, or a whole new paste) and finds what the gameplans lose.
 * A species that is gone is paired with a new one when exactly one of each changed, or when they sit at the same
 * place in the team; a Pokémon's moves are compared the same way (one gone and one new is a replacement).
 */
export function planImpact(before: readonly PokemonSet[], after: readonly PokemonSet[], plans: readonly Plan[]): PlanImpact {
  const out: PlanImpact = { renames: [], losses: [] };
  if (!plans.length) return out;
  const beforeNames = new Set(before.map((m) => m.species));
  const afterNames = new Set(after.map((m) => m.species));
  const gone = before.filter((m) => !afterNames.has(m.species));
  const added = after.filter((m) => !beforeNames.has(m.species));

  // Which new Pokémon each old one became: itself, or the new species it was swapped for.
  const pairs: [PokemonSet, PokemonSet][] = [];
  for (const old of before) {
    const same = after.find((m) => m.species === old.species);
    if (same) pairs.push([old, same]);
  }
  const unpaired = new Set(added);
  const pairUp = (old: PokemonSet, next: PokemonSet): void => { pairs.push([old, next]); unpaired.delete(next); };
  if (gone.length === 1 && added.length === 1) pairUp(gone[0]!, added[0]!);
  else for (const old of gone) {
    const next = after[before.indexOf(old)];
    if (next && unpaired.has(next)) pairUp(old, next);
  }

  for (const old of gone) {
    const uses = findPlanUses(plans, { kind: 'mon', species: old.species });
    if (!uses.length) continue;
    const pair = pairs.find(([o]) => o === old);
    if (pair) out.renames.push({ kind: 'mon', species: old.species, from: old.species, to: pair[1].species, uses });
    else out.losses.push({ kind: 'mon', species: old.species, name: old.species, uses });
  }

  for (const [old, next] of pairs) {
    const removed = old.moves.filter((m) => !next.moves.includes(m));
    const newMoves = next.moves.filter((m) => !old.moves.includes(m));
    for (const move of removed) {
      // Turns name the Pokémon as it was, so its old name finds them.
      const uses = findPlanUses(plans, { kind: 'move', species: old.species, move });
      if (!uses.length) continue;
      if (removed.length === 1 && newMoves.length === 1) out.renames.push({ kind: 'move', species: old.species, from: move, to: newMoves[0]!, uses });
      else out.losses.push({ kind: 'move', species: old.species, name: move, uses });
    }
  }
  return out;
}

/** Carries the renames over to the gameplans: moves first (their turns still name the Pokémon the old way), then Pokémon. */
export function applyRenames(plans: readonly Plan[], renames: PlanImpact['renames']): void {
  for (const r of renames) if (r.kind === 'move') renameMoveInPlans(plans, r.species, r.from, r.to);
  for (const r of renames) if (r.kind === 'mon') renameMonInPlans(plans, r.from, r.to);
}

/** Replaces the move `from` with `to` in every turn where the user's Pokémon `species` uses it. */
export function renameMoveInPlans(plans: readonly Plan[], species: string, from: string, to: string): void {
  if (!from || !to || from === to) return;
  for (const plan of plans) for (const tab of plan.tabs) {
    walk(tab.children, (n) => {
      for (const a of n.actions) if (a.side === 'me' && a.mon === species && a.kind === 'move' && a.move === from) a.move = to;
    });
  }
}
