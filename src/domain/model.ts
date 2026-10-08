import { newId } from './ids.ts';
import { parseShowdown } from './showdown.ts';
import type { FlowNode, Library, Plan, PlanTab, PokemonSet, Sheet, Side, SideSelection, Team, TurnAction } from './types.ts';
import { SIDES, SLOT_KINDS } from './types.ts';

export const emptySideSelection = (): SideSelection => ({ lead: [null, null], back: [null, null] });
export const emptySelection = (): Record<Side, SideSelection> => ({ me: emptySideSelection(), opp: emptySideSelection() });

export function newTeam(name = '', paste = ''): Team {
  return { id: newId(), name: name || 'My team', paste, plans: [] };
}

export function newTab(name = 'Plan 1'): PlanTab {
  return { id: newId(), name, selection: emptySelection(), children: [] };
}

export function newPlan(name = '', opponentPaste = ''): Plan {
  return { id: newId(), name: name || 'New gameplan', opponent: { name: '', paste: opponentPaste }, tabs: [newTab()] };
}

/** "Plan N" with the first N not already used by a tab of this gameplan. */
export function nextTabName(plan: Plan): string {
  const used = new Set(plan.tabs.map((t) => t.name.trim().toLowerCase()));
  let n = plan.tabs.length + 1;
  while (used.has(`plan ${n}`)) n++;
  return `Plan ${n}`;
}

/** The tab with this id, or the first tab. */
export const findTab = (plan: Plan, id: string | null | undefined): PlanTab => plan.tabs.find((t) => t.id === id) ?? plan.tabs[0]!;

/** A tab together with its gameplan's opponent (see {@link Sheet}). */
export const sheetOf = (plan: Plan, tab: PlanTab): Sheet => ({ ...tab, opponent: plan.opponent });

/** Deep copy of a tab with fresh ids, for "duplicate tab". */
export function cloneTab(tab: PlanTab, name: string): PlanTab {
  const copy = structuredClone(tab);
  copy.id = newId();
  copy.name = name;
  reidNodes(copy.children);
  return copy;
}

const reidNodes = (list: FlowNode[]): void => list.forEach((n) => { n.id = newId(); reidNodes(n.children); });

/** Every turn in every tab of a gameplan. */
export const countPlanTurns = (plan: Plan): number => plan.tabs.reduce((n, t) => n + countNodes(t.children), 0);

export function newNode(init: Partial<Omit<FlowNode, 'id'>> = {}): FlowNode {
  return { id: newId(), title: '', tags: [], note: '', actions: [], children: [], ...init };
}

export const teamMons = (team: Pick<Team, 'paste'> | null | undefined): PokemonSet[] => parseShowdown(team?.paste);
export const oppMons = (plan: Pick<Plan, 'opponent'> | null | undefined): PokemonSet[] => parseShowdown(plan?.opponent.paste);
export const monsFor = (side: Side, team: Team, plan: Pick<Plan, 'opponent'>): PokemonSet[] => (side === 'me' ? teamMons(team) : oppMons(plan));

export const findTeam = (library: Library, id: string | null | undefined): Team | undefined => library.teams.find((t) => t.id === id);
export const findPlan = (team: Team | undefined, id: string | null | undefined): Plan | undefined => team?.plans.find((p) => p.id === id);

export interface NodeLocation {
  node: FlowNode;
  parent: FlowNode | null;
  /** The array that contains `node` (its parent's children, or the plan's first-level turns). */
  siblings: FlowNode[];
  /** 1 for first-level turns. */
  depth: number;
}

export function findNode(list: FlowNode[], id: string | null | undefined, parent: FlowNode | null = null, depth = 1): NodeLocation | null {
  if (!id) return null;
  for (const node of list) {
    if (node.id === id) return { node, parent, siblings: list, depth };
    const hit = findNode(node.children, id, node, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export const countNodes = (list: readonly FlowNode[]): number => list.reduce((n, node) => n + 1 + countNodes(node.children), 0);

/** Drops lead/back picks that are no longer in the pasted team. */
export function cleanSelection(sel: SideSelection, mons: readonly PokemonSet[]): void {
  const names = new Set(mons.map((m) => m.species));
  for (const kind of SLOT_KINDS) sel[kind] = sel[kind].map((s) => (s && names.has(s) ? s : null));
}

/** Deep copy with fresh ids (gameplan, tabs and turns), for "duplicate gameplan". */
export function clonePlan(plan: Plan): Plan {
  const copy = structuredClone(plan);
  copy.id = newId();
  copy.name = `${plan.name} (copy)`;
  for (const tab of copy.tabs) { tab.id = newId(); reidNodes(tab.children); }
  return copy;
}

/** Drops picks that are no longer in the pasted team, in every tab of every gameplan given. */
export function cleanSelections(plans: readonly Plan[], side: Side, mons: readonly PokemonSet[]): void {
  for (const plan of plans) for (const tab of plan.tabs) cleanSelection(tab.selection[side], mons);
}

/** A new turn starts with the Pokémon that acted in the previous one (or the leads). */
export function seedActions(parent: FlowNode | null, plan: Pick<PlanTab, 'selection'>): TurnAction[] {
  const out: TurnAction[] = [];
  for (const side of SIDES) {
    let mons = parent ? parent.actions.filter((a) => a.side === side && a.mon).map((a) => a.mon) : [];
    if (!mons.length) mons = plan.selection[side].lead.filter((n): n is string => !!n);
    [...new Set(mons)].slice(0, 2).forEach((mon) => out.push({ side, mon, kind: 'move', move: '', target: '' }));
  }
  return out;
}
