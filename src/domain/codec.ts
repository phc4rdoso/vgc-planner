/**
 * Reading and writing the two JSON shapes the app deals with:
 *  - the stored library (what the repository persists; keeps ids), and
 *  - the portable export file (no ids; what users download and share).
 * Both come from untrusted places (disk, user uploads, later a server), so every field is validated.
 */
import { newId } from './ids.ts';
import { emptySelection, newNode, newTab } from './model.ts';
import { REGULATION } from './regulation.ts';
import { parseShowdown } from './showdown.ts';
import type { ActionKind, ActionOutcome, ChanceEffect, FlowNode, Library, Plan, PlanTab, Side, SideSelection, TargetOutcome, Team, TurnAction, LineColor, PlanLine } from './types.ts';
import { SIDES, SLOT_KINDS, LINE_COLORS } from './types.ts';

export const EXPORT_FORMAT = 'vgc-gameplan-planner';
/** 2: gameplans hold `tabs` (version 1 files, with one selection and flow per gameplan, are still read). */
export const EXPORT_VERSION = 2;
/** 2: gameplans hold `tabs`. */
export const LIBRARY_SCHEMA_VERSION = 2;

/** Upper bounds that keep hostile or broken input from exhausting memory. `nodesPerPlan` counts all tabs together. */
export const LIMITS = { teams: 200, plansPerTeam: 500, tabsPerPlan: 50, nodesPerPlan: 5000, depth: 100, actionsPerNode: 20, textLength: 50_000, nameLength: 300 } as const;

export class DataError extends Error {
  override readonly name = 'DataError';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function asObj(v: unknown, path: string): Obj {
  if (!isObj(v)) throw new DataError(`${path} must be an object.`);
  return v;
}
function asArr(v: unknown, path: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new DataError(`${path} must be a list.`);
  if (v.length > max) throw new DataError(`${path} has too many entries (max ${max}).`);
  return v;
}
function asStr(v: unknown, path: string, max: number = LIMITS.textLength): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new DataError(`${path} must be text.`);
  if (v.length > max) throw new DataError(`${path} is too long (max ${max} characters).`);
  return v;
}
const ACTION_KINDS: readonly ActionKind[] = ['move', 'switch', 'mega'];

function readAction(raw: unknown, path: string): TurnAction {
  const o = asObj(raw, path);
  const side: Side = o.side === 'opp' ? 'opp' : 'me';
  const kind = ACTION_KINDS.find((k) => k === o.kind) ?? 'move';
  const action: TurnAction = {
    side, kind,
    mon: asStr(o.mon, `${path}.mon`, LIMITS.nameLength),
    move: asStr(o.move, `${path}.move`, LIMITS.nameLength),
    target: asStr(o.target, `${path}.target`, LIMITS.nameLength),
  };
  const pivot = asStr(o.pivot, `${path}.pivot`, LIMITS.nameLength);
  if (pivot) action.pivot = pivot;
  const outcome = readOutcome(o.outcome, `${path}.outcome`);
  if (outcome) action.outcome = outcome;
  return action;
}

const CANT: readonly NonNullable<ActionOutcome['cant']>[] = ['par', 'slp', 'frz', 'confusion', 'flinch'];
/** A chance effect: a condition, flinch, confusion, or stat changes like "spd-1" / "atk+1" / "atk+1,def+1". */
const EFFECT = /^(brn|par|psn|tox|slp|frz|flinch|confusion|(atk|def|spa|spd|spe)[+-][1-6](,(atk|def|spa|spd|spe)[+-][1-6]){0,4})$/;
const readEffects = (v: unknown, path: string): ChanceEffect[] =>
  asArr(v, path, 8).map((e, i) => asStr(e, `${path}[${i}]`, 40)).filter((e) => EFFECT.test(e));
const percent = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined);

/** Chance results on an action; anything unknown is dropped, and an empty outcome is no outcome. */
function readOutcome(raw: unknown, path: string): ActionOutcome | undefined {
  if (!isObj(raw)) return undefined;
  const out: ActionOutcome = {};
  const cant = CANT.find((c) => c === raw.cant);
  if (cant) out.cant = cant;
  if (raw.wake === true) out.wake = true;
  if (raw.unknown === true) out.unknown = true;
  if (raw.protectWorks === true) out.protectWorks = true;
  if (typeof raw.hits === 'number' && Number.isInteger(raw.hits) && raw.hits >= 1 && raw.hits <= 10) out.hits = raw.hits;
  const self = readEffects(raw.self, `${path}.self`);
  if (self.length) out.self = self;
  if (isObj(raw.targets)) {
    const targets: Record<string, TargetOutcome> = {};
    for (const [name, t] of Object.entries(raw.targets).slice(0, 6)) {
      if (!isObj(t) || name.length > LIMITS.nameLength) continue;
      const one: TargetOutcome = {};
      if (t.miss === true) one.miss = true;
      if (t.crit === true) one.crit = true;
      const effects = readEffects(t.effects, `${path}.targets.${name}.effects`);
      if (effects.length) one.effects = effects;
      const hp = percent(t.hp);
      if (hp !== undefined) one.hp = hp;
      if (Object.keys(one).length) targets[name] = one;
    }
    if (Object.keys(targets).length) out.targets = targets;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Turn-level facts from a replay: the real order, end-of-turn HP, and the replay's address. */
function readNodeFacts(o: Obj, node: FlowNode): void {
  const order = asArr(o.order, 'order', LIMITS.actionsPerNode).map((k, i) => asStr(k, `order[${i}]`, LIMITS.nameLength)).filter(Boolean);
  if (order.length) node.order = order;
  const tieOrder = asArr(o.tieOrder, 'tieOrder', LIMITS.actionsPerNode).map((k, i) => asStr(k, `tieOrder[${i}]`, LIMITS.nameLength)).filter(Boolean);
  if (tieOrder.length) node.tieOrder = tieOrder;
  if (isObj(o.hpEnd)) {
    const hpEnd: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.hpEnd).slice(0, 12)) { const hp = percent(v); if (hp !== undefined && k.length <= LIMITS.nameLength) hpEnd[k] = hp; }
    if (Object.keys(hpEnd).length) node.hpEnd = hpEnd;
  }
  if (isObj(o.source)) {
    const replay = asStr(o.source.replay, 'source.replay', 500);
    if (/^https:\/\/replay\.pokemonshowdown\.com\//.test(replay)) node.source = { replay };
  }
  if (isObj(o.line)) {
    const name = asStr(o.line.name, 'line.name', LIMITS.nameLength).trim();
    const color = (LINE_COLORS as readonly unknown[]).includes(o.line.color) ? (o.line.color as LineColor) : undefined;
    if (name || color) node.line = { name, ...(color ? { color } : {}) };
  }
}

/** A turn's tags: trimmed, no duplicates, at most TAG_LIMITS.count of TAG_LIMITS.length characters. Older data had one branch condition instead. */
export const TAG_LIMITS = { count: 12, length: 60 } as const;
export function cleanTags(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const tag = typeof raw === 'string' ? Array.from(raw.trim().replace(/\s+/g, ' ')).slice(0, TAG_LIMITS.length).join('') : '';
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= TAG_LIMITS.count) break;
  }
  return out;
}
function readTags(o: Obj, path: string): string[] {
  if (Array.isArray(o.tags)) return cleanTags(o.tags);
  const condition = asStr(o.condition, `${path}.condition`, LIMITS.nameLength);
  return cleanTags([condition]);
}

interface NodeBudget { remaining: number }

function readNode(raw: unknown, path: string, keepIds: boolean, depth: number, budget: NodeBudget): FlowNode {
  if (depth > LIMITS.depth) throw new DataError(`${path} is nested too deeply (max ${LIMITS.depth} turns).`);
  if (--budget.remaining < 0) throw new DataError(`A gameplan has too many turns (max ${LIMITS.nodesPerPlan}).`);
  const o = asObj(raw, path);
  const node = newNode({
    title: asStr(o.title, `${path}.title`, LIMITS.nameLength),
    tags: readTags(o, path),
    note: asStr(o.note, `${path}.note`),
    actions: asArr(o.actions, `${path}.actions`, LIMITS.actionsPerNode).map((a, i) => readAction(a, `${path}.actions[${i}]`)),
    children: asArr(o.children, `${path}.children`, LIMITS.nodesPerPlan).map((c, i) => readNode(c, `${path}.children[${i}]`, keepIds, depth + 1, budget)),
  });
  if (keepIds && typeof o.id === 'string' && o.id) node.id = o.id;
  readNodeFacts(o, node);
  return node;
}

function readSideSelection(raw: unknown): SideSelection {
  const o = isObj(raw) ? raw : {};
  const sel: SideSelection = { lead: [null, null], back: [null, null] };
  for (const kind of SLOT_KINDS) {
    const arr = Array.isArray(o[kind]) ? (o[kind] as unknown[]) : [];
    sel[kind] = [0, 1].map((i) => (typeof arr[i] === 'string' ? (arr[i] as string) : null));
  }
  return sel;
}

/**
 * One tab: its leads/backs and turns. `flowKey` is where the turns live: "children" in stored data, "flow" in
 * export files. The node budget is shared by all tabs of a gameplan.
 */
function readTab(o: Obj, path: string, keepIds: boolean, flowKey: 'children' | 'flow', budget: NodeBudget, fallbackName: string): PlanTab {
  const selection = emptySelection();
  const sel = isObj(o.selection) ? o.selection : {};
  for (const side of SIDES) selection[side] = readSideSelection(sel[side]);
  return {
    id: keepIds && typeof o.id === 'string' && o.id ? o.id : newId(),
    name: asStr(o.name, `${path}.name`, LIMITS.nameLength).trim() || fallbackName,
    selection,
    children: withStartTies(
      asArr(o[flowKey], `${path}.${flowKey}`, LIMITS.nodesPerPlan).map((n, i) => readNode(n, `${path}.${flowKey}[${i}]`, keepIds, 1, budget)),
      asArr(o.entryTieOrder, `${path}.entryTieOrder`, 8).map((k, i) => asStr(k, `${path}.entryTieOrder[${i}]`, LIMITS.nameLength)).filter(Boolean),
    ),
  };
}

/**
 * Battle-start tie picks were briefly kept on the tab ("entryTieOrder"); they now belong to each first turn, so an
 * old pick is copied into every first turn that hasn't decided those Pokémon itself.
 */
function withStartTies(turns: FlowNode[], picks: readonly string[]): FlowNode[] {
  if (!picks.length) return turns;
  for (const turn of turns) {
    const own = turn.tieOrder ?? [];
    turn.tieOrder = [...picks.filter((k) => !own.includes(k)), ...own];
  }
  return turns;
}

/** Gameplans written before tabs existed kept `selection` and the turns on the gameplan itself: they become one tab. */
function readPlan(raw: unknown, path: string, keepIds: boolean, flowKey: 'children' | 'flow'): Plan {
  const o = asObj(raw, path);
  const opp = isObj(o.opponent) ? o.opponent : {};
  const budget: NodeBudget = { remaining: LIMITS.nodesPerPlan };
  const tabs = o.tabs === undefined
    ? [readTab({ selection: o.selection, [flowKey]: o[flowKey] }, path, keepIds, flowKey, budget, 'Plan 1')]
    : asArr(o.tabs, `${path}.tabs`, LIMITS.tabsPerPlan).map((t, i) => readTab(asObj(t, `${path}.tabs[${i}]`), `${path}.tabs[${i}]`, keepIds, flowKey, budget, `Plan ${i + 1}`));
  if (!tabs.length) tabs.push(newTab());
  return {
    id: keepIds && typeof o.id === 'string' && o.id ? o.id : newId(),
    name: asStr(o.name, `${path}.name`, LIMITS.nameLength) || 'Imported gameplan',
    opponent: { name: asStr(opp.name, `${path}.opponent.name`, LIMITS.nameLength), paste: asStr(opp.paste, `${path}.opponent.paste`) },
    tabs,
  };
}

function readTeam(raw: unknown, path: string, keepIds: boolean, planKey: 'plans', flowKey: 'children' | 'flow'): Team {
  const o = asObj(raw, path);
  return {
    id: keepIds && typeof o.id === 'string' && o.id ? o.id : newId(),
    name: asStr(o.name, `${path}.name`, LIMITS.nameLength) || 'Imported team',
    paste: asStr(o.paste, `${path}.paste`),
    plans: asArr(o[planKey], `${path}.plans`, LIMITS.plansPerTeam).map((p, i) => readPlan(p, `${path}.plans[${i}]`, keepIds, flowKey)),
  };
}

/* ------------------------ single records (account API) ------------------------ */

/** A team's own fields (its gameplans are stored separately), validated. */
export function readTeamFields(raw: unknown): Pick<Team, 'name' | 'paste'> {
  const o = asObj(raw, 'team');
  return { name: asStr(o.name, 'team.name', LIMITS.nameLength) || 'Imported team', paste: asStr(o.paste, 'team.paste') };
}

/** One gameplan with its tabs and turns, validated and capped like an import; `id` and the turn/tab ids are kept. */
export const readPlanRecord = (raw: unknown, id: string): Plan => readPlan({ ...asObj(raw, 'gameplan'), id }, 'gameplan', true, 'children');

/* ---------------------------- stored library ---------------------------- */

export interface StoredLibrary {
  schemaVersion: number;
  teams: Team[];
}

/** Reads what the repository saved. Also accepts the pre-1.0 shape `{ teams, ui }` (no schemaVersion). */
export function readLibrary(raw: unknown): Library {
  const o = asObj(raw, 'Saved data');
  if (typeof o.schemaVersion === 'number' && o.schemaVersion > LIBRARY_SCHEMA_VERSION) {
    throw new DataError('Saved data was written by a newer version of the app.');
  }
  return { teams: asArr(o.teams, 'teams', LIMITS.teams).map((t, i) => readTeam(t, `teams[${i}]`, true, 'plans', 'children')) };
}

export const writeLibrary = (library: Library): StoredLibrary => ({ schemaVersion: LIBRARY_SCHEMA_VERSION, teams: library.teams });

/* ----------------------------- export file ------------------------------ */

export interface ExportedNode {
  title: string; tags: string[]; note: string; actions: TurnAction[]; children: ExportedNode[];
  order?: string[]; tieOrder?: string[]; hpEnd?: Record<string, number>; source?: { replay: string }; line?: PlanLine;
}
export interface ExportedTab { name: string; selection: Record<Side, SideSelection>; flow: ExportedNode[] }
export interface ExportedPlan { name: string; opponent: { name: string; paste: string }; tabs: ExportedTab[] }
export interface ExportedTeam {
  name: string;
  paste: string;
  /** Read-only summary for people and other tools; ignored on import (the paste is the source of truth). */
  pokemon: { species: string; item: string; ability: string; moves: string[] }[];
  plans: ExportedPlan[];
}
export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  regulation: string;
  exportedAt: string;
  teams: ExportedTeam[];
}

export type ExportScope = { type: 'all' } | { type: 'team'; teamId: string } | { type: 'plan'; teamId: string; planId: string };

const exportNode = (n: FlowNode): ExportedNode => ({
  title: n.title, tags: [...n.tags], note: n.note, actions: n.actions.map((a) => structuredClone(a)), children: n.children.map(exportNode),
  ...(n.order ? { order: [...n.order] } : {}), ...(n.tieOrder ? { tieOrder: [...n.tieOrder] } : {}), ...(n.hpEnd ? { hpEnd: { ...n.hpEnd } } : {}), ...(n.source ? { source: { ...n.source } } : {}),
  ...(n.line ? { line: { ...n.line } } : {}),
});

function exportTeam(team: Team, onlyPlanId?: string): ExportedTeam {
  return {
    name: team.name,
    paste: team.paste,
    pokemon: parseShowdown(team.paste).map((m) => ({ species: m.species, item: m.item, ability: m.ability, moves: m.moves })),
    plans: team.plans
      .filter((p) => !onlyPlanId || p.id === onlyPlanId)
      .map((p) => ({
        name: p.name, opponent: { ...p.opponent },
        tabs: p.tabs.map((t) => ({ name: t.name, selection: structuredClone(t.selection), flow: t.children.map(exportNode) })),
      })),
  };
}

export function buildExport(library: Library, scope: ExportScope, now: Date = new Date()): ExportFile {
  let teams: ExportedTeam[];
  if (scope.type === 'all') teams = library.teams.map((t) => exportTeam(t));
  else {
    const team = library.teams.find((t) => t.id === scope.teamId);
    if (!team) throw new DataError('That team no longer exists.');
    teams = [exportTeam(team, scope.type === 'plan' ? scope.planId : undefined)];
  }
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, regulation: REGULATION.id, exportedAt: now.toISOString(), teams };
}

export interface ParsedExport {
  teams: Team[];
  /** Set when the file is for a different regulation than this tool supports. */
  regulationWarning: string | null;
}

/** Validates an export file and converts it to fresh in-memory teams (new ids). Throws {@link DataError}. */
export function readExport(raw: unknown): ParsedExport {
  const o = asObj(raw, 'This file');
  if (o.format !== EXPORT_FORMAT) throw new DataError(`Unrecognized file: expected format "${EXPORT_FORMAT}".`);
  if (typeof o.version === 'number' && o.version > EXPORT_VERSION) throw new DataError('This file was made by a newer version of the app.');
  if (!Array.isArray(o.teams)) throw new DataError('Missing "teams" list.');
  const teams = asArr(o.teams, 'teams', LIMITS.teams).map((t, i) => readTeam(t, `teams[${i}]`, false, 'plans', 'flow'));
  const regulationWarning = typeof o.regulation === 'string' && o.regulation && o.regulation !== REGULATION.id
    ? `file is for regulation ${o.regulation}, this tool supports ${REGULATION.id}`
    : null;
  return { teams, regulationWarning };
}

export interface ImportSummary {
  newTeams: number;
  plans: number;
  regulationWarning: string | null;
  /** What to show after importing. */
  focus: { teamId: string; planId: string | null } | null;
}

/** Merges parsed teams into the library. A team with the same name (case-insensitive) receives the plans. */
export function mergeImport(library: Library, parsed: ParsedExport): ImportSummary {
  let newTeams = 0;
  let plans = 0;
  let focus: ImportSummary['focus'] = null;
  for (const incoming of parsed.teams) {
    let team = library.teams.find((t) => t.name.trim().toLowerCase() === incoming.name.trim().toLowerCase());
    if (!team) {
      team = { ...incoming, plans: [] };
      library.teams.push(team);
      newTeams++;
    }
    for (const plan of incoming.plans) {
      team.plans.push(plan);
      plans++;
      focus = { teamId: team.id, planId: plan.id };
    }
    focus ??= { teamId: team.id, planId: null };
  }
  return { newTeams, plans, regulationWarning: parsed.regulationWarning, focus };
}
