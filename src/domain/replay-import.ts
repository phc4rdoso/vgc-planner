/**
 * Turning a parsed replay into a gameplan branch: which side is the user, whether both teams are exactly the
 * gameplan's (species, items, abilities, moves), the leads and backs, one turn per replay turn with the actions,
 * targets, Mega Evolution, pivots and chance results, HP and order as recorded, and where the branch goes (a tab
 * with the same leads and backs, or a new one), merging with turns already imported.
 */
import { newNode, newTab, nextTabName } from './model.ts';
import type { ParsedReplay, Player, ReplayAction, ReplayTurn } from './replay.ts';
import { PLAYERS, ReplayError } from './replay.ts';
import { baseSpecies } from './showdown.ts';
import type { MoveInfo } from './simulation/engine.ts';
import { alwaysConfuses, alwaysDrops, alwaysFlinches, alwaysSelf, alwaysStatus, CHARGE_MOVES, statEffect } from './simulation/tables.ts';
import { toID } from './strings.ts';
import type { ActionOutcome, FlowNode, Plan, PlanTab, PokemonSet, Side, SideSelection, TargetOutcome, TurnAction } from './types.ts';
import { SIDES } from './types.ts';

export interface ReplayBranch {
  /** Which replay player is the user. */
  me: Player;
  selection: Record<Side, SideSelection>;
  /** The turns, first to last (each the only child of the previous one). */
  turns: FlowNode[];
  warnings: string[];
  /** "Alice vs Bob". */
  title: string;
}

export interface ImportContext {
  team: readonly PokemonSet[];
  opponent: readonly PokemonSet[];
  /** Move data from the calculator (category, so only chance effects are kept). */
  moveInfo(name: string): MoveInfo | null;
}

const key = (side: Side, name: string): string => `${side}:${name}`;
const sorted = (xs: readonly string[]): string => [...xs].map(toID).sort().join(',');
const same = (a: string, b: string): boolean => toID(a) === toID(b);

/**
 * Whether a move always causes this effect, so the simulation applies it and it isn't a chance result: anything a
 * status move does, the guaranteed drops and conditions of attacks, and the user's own drops (Draco Meteor...).
 */
export function alwaysEffect(moveInfo: ImportContext['moveInfo']) {
  return (move: string, effect: string): boolean => {
    const id = toID(move);
    if (moveInfo(move)?.category === 'Status') return true;
    if (alwaysStatus(id) === effect || (effect === 'flinch' && alwaysFlinches(id)) || (effect === 'confusion' && alwaysConfuses(id))) return true;
    const change = statEffect(effect);
    if (!change) return false;
    const tables = [alwaysDrops(id), alwaysSelf(id), CHARGE_MOVES[id]?.boost, id === 'rapidspin' ? { spe: 1 } : undefined];
    return Object.entries(change).every(([k, d]) => tables.some((t) => t?.[k as keyof typeof t] === d));
  };
}

/**
 * Checks a replay player's team against a paste: the same six species (Mega names count as their base form), and
 * with open team sheets the same item, ability and four moves each. Returns the problems found.
 */
function compareTeam(parsed: ParsedReplay, player: Player, paste: readonly PokemonSet[], who: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const wanted = paste.map((m) => baseSpecies(m.species));
  const shown = parsed.preview[player].map(baseSpecies);
  const missing = shown.filter((s) => !wanted.some((w) => same(w, s)));
  const extra = wanted.filter((w) => !shown.some((s) => same(w, s)));
  if (missing.length) errors.push(`${who}: ${missing.join(', ')} in the replay, not in the paste`);
  if (extra.length) errors.push(`${who}: ${extra.join(', ')} in the paste, not in the replay`);
  const sheet = parsed.sheets[player];
  if (!sheet) {
    warnings.push(`${who}: no open team sheet in this replay, so only the moves it used could be checked`);
    return { errors, warnings };
  }
  for (const s of sheet) {
    const set = paste.find((m) => same(baseSpecies(m.species), baseSpecies(s.species)));
    if (!set) continue;
    const name = baseSpecies(set.species);
    if (!same(set.item, s.item)) errors.push(`${who}'s ${name}: item ${s.item || 'none'} in the replay, ${set.item || 'none'} in the paste`);
    if (s.ability && set.ability && !same(set.ability, s.ability)) errors.push(`${who}'s ${name}: ability ${s.ability} in the replay, ${set.ability} in the paste`);
    if (sorted(set.moves) !== sorted(s.moves)) {
      const notInPaste = s.moves.filter((m) => !set.moves.some((p) => same(p, m)));
      const notInReplay = set.moves.filter((p) => !s.moves.some((m) => same(p, m)));
      errors.push(`${who}'s ${name}: moves differ (${[...notInPaste.map((m) => `${m} only in the replay`), ...notInReplay.map((m) => `${m} only in the paste`)].join('; ')})`);
    }
    if (s.nature && set.nature && !same(set.nature, s.nature)) warnings.push(`${who}'s ${name}: ${s.nature} nature in the replay, ${set.nature} in the paste`);
  }
  return { errors, warnings };
}

/** Moves a player used that aren't in its paste (the check when there's no open team sheet). */
function unknownMoves(parsed: ParsedReplay, player: Player, paste: readonly PokemonSet[], who: string): string[] {
  const out = new Set<string>();
  for (const t of parsed.turns) for (const a of t.actions) {
    if (a.player !== player || !a.move) continue;
    const set = paste.find((m) => same(baseSpecies(m.species), baseSpecies(a.species)));
    if (set && !set.moves.some((m) => same(m, a.move))) out.add(`${who}'s ${baseSpecies(set.species)}: ${a.move} isn't in the paste`);
  }
  return [...out];
}

/** Builds the branch a replay describes. Throws ReplayError listing every mismatch when the teams aren't the gameplan's. */
export function buildReplayBranch(parsed: ParsedReplay, ctx: ImportContext, url: string): ReplayBranch {
  // Which player is the user: the one whose six Pokémon are the team's.
  const fits = (player: Player, paste: readonly PokemonSet[]): boolean => {
    const shown = parsed.preview[player].map((s) => toID(baseSpecies(s))).sort().join();
    return shown === paste.map((m) => toID(baseSpecies(m.species))).sort().join();
  };
  const me: Player | null = fits('p1', ctx.team) && fits('p2', ctx.opponent) ? 'p1' : fits('p2', ctx.team) && fits('p1', ctx.opponent) ? 'p2' : null;
  const errors: string[] = [];
  const warnings: string[] = [];
  const checkAs = me ?? 'p1';
  const sideOf = (p: Player): Side => (p === checkAs ? 'me' : 'opp');
  for (const p of PLAYERS) {
    const paste = sideOf(p) === 'me' ? ctx.team : ctx.opponent;
    const who = sideOf(p) === 'me' ? 'Your team' : 'Opponent';
    const got = compareTeam(parsed, p, paste, who);
    errors.push(...got.errors);
    warnings.push(...got.warnings);
    if (!parsed.sheets[p]) errors.push(...unknownMoves(parsed, p, paste, who));
  }
  if (!me && !errors.length) errors.push('Neither player\'s team is this gameplan\'s team');
  if (errors.length) throw new ReplayError(`This replay doesn't match the gameplan:\n• ${errors.join('\n• ')}`);
  const user = me!;

  // Replay species → the name the gameplan uses (the paste's species line).
  const nameOf = (p: Player, species: string): string => {
    const paste = sideOf(p) === 'me' ? ctx.team : ctx.opponent;
    return paste.find((m) => same(baseSpecies(m.species), baseSpecies(species)))?.species ?? species;
  };
  const selection = Object.fromEntries(SIDES.map((side) => {
    const p = PLAYERS.find((x) => sideOf(x) === side)!;
    const backs = parsed.backs[p].map((s) => nameOf(p, s)).slice(0, 2);
    return [side, { lead: parsed.leads[p].map((s) => nameOf(p, s)), back: [backs[0] ?? null, backs[1] ?? null] }];
  })) as Record<Side, SideSelection>;
  for (const side of SIDES) if (selection[side].back.includes(null) && Object.keys(ctx.team).length) {
    const p = PLAYERS.find((x) => sideOf(x) === side)!;
    if (parsed.backs[p].length < 2) warnings.push(`${side === 'me' ? 'Your' : 'The opponent\'s'} fourth Pokémon never came in, so it can't be known: pick it in the tab`);
  }

  // Who stands where at the start of each turn.
  const field: Record<Player, Record<'a' | 'b', string>> = {
    p1: { a: parsed.leads.p1[0] ?? '', b: parsed.leads.p1[1] ?? '' }, p2: { a: parsed.leads.p2[0] ?? '', b: parsed.leads.p2[1] ?? '' },
  };
  const fainted = new Set<string>();
  const always = alwaysEffect(ctx.moveInfo);
  const turns: FlowNode[] = [];

  for (const t of parsed.turns) {
    for (const r of t.replacements) field[r.player][r.slot] = r.species;
    const actions: TurnAction[] = [];
    const order: string[] = [];
    for (const a of t.actions) {
      const side = sideOf(a.player);
      const mon = nameOf(a.player, a.species);
      order.push(key(side, mon));
      actions.push(toAction(a, side, mon, (p, s) => nameOf(p, s), sideOf, always));
      if (a.switchTo) field[a.player][a.slot] = a.switchTo;
    }
    // Anyone on the field who didn't get to act (fainted first): its choice isn't in the log.
    for (const p of PLAYERS) for (const slot of ['a', 'b'] as const) {
      const species = startOf(t, p, slot, field);
      if (!species || fainted.has(`${p}:${baseSpecies(species)}`)) continue;
      const mon = nameOf(p, species);
      if (actions.some((x) => x.side === sideOf(p) && x.mon === mon)) continue;
      actions.push({ side: sideOf(p), mon, kind: 'move', move: '', target: '', outcome: { unknown: true } });
    }
    const hpEnd: Record<string, number> = {};
    for (const p of PLAYERS) for (const [species, pct] of Object.entries(t.hpEnd[p])) {
      hpEnd[key(sideOf(p), nameOf(p, species))] = pct;
      if (pct <= 0) fainted.add(`${p}:${baseSpecies(species)}`);
    }
    turns.push(newNode({ actions, order, hpEnd }));
  }
  const title = `${parsed.players.p1 || 'Player 1'} vs ${parsed.players.p2 || 'Player 2'}`;
  const first = turns[0]!;
  first.source = { replay: url };
  const last = turns[turns.length - 1]!;
  if (parsed.forfeit) last.note = `${parsed.players[parsed.forfeit]} forfeited after this turn.`;
  else if (parsed.winner) last.note = `${parsed.players[parsed.winner]} won.`;
  for (let i = 1; i < turns.length; i++) turns[i - 1]!.children = [turns[i]!];
  void user;
  return { me: user, selection, turns, warnings, title };
}

/** Who stood in a position when the turn began (before its own switches). */
function startOf(t: ReplayTurn, p: Player, slot: 'a' | 'b', field: Record<Player, Record<'a' | 'b', string>>): string {
  const first = t.actions.find((a) => a.player === p && a.slot === slot);
  return first ? first.species : field[p][slot];
}

/** One replay action as a gameplan action, with its chance results as the outcome. */
function toAction(
  a: ReplayAction, side: Side, mon: string,
  nameOf: (p: Player, species: string) => string, sideOf: (p: Player) => Side, always: (move: string, effect: string) => boolean,
): TurnAction {
  if (a.kind === 'switch') return { side, mon, kind: 'switch', move: '', target: nameOf(a.player, a.switchTo ?? '') };
  let target = '';
  if (a.spread && a.spread.length > 1) target = a.spread.some((s) => s.player === a.player) ? 'All' : 'Both foes';
  else if (a.target && a.targetSpecies) {
    if (a.target.player !== a.player) target = nameOf(a.target.player, a.targetSpecies);
    else if (a.target.slot !== a.slot) target = 'Ally';
  }
  const action: TurnAction = { side, mon, kind: a.mega ? 'mega' : 'move', move: a.move, target };
  if (a.switchTo) action.pivot = nameOf(a.player, a.switchTo);
  const o: ActionOutcome = {};
  if (a.cant && a.cant !== 'recharge') o.cant = a.cant;
  if (a.wake) o.wake = true;
  if (a.hits) o.hits = a.hits;
  if (a.protectWorks) o.protectWorks = true;
  if (!a.move) o.unknown = true;
  const targets: Record<string, TargetOutcome> = {};
  for (const [species, r] of Object.entries(a.targets)) {
    const effects = (r.effects ?? []).filter((fx) => !always(a.move, fx));
    const t: TargetOutcome = { ...(r.miss ? { miss: true as const } : {}), ...(r.crit ? { crit: true as const } : {}), ...(effects.length ? { effects } : {}), ...(r.hp !== undefined ? { hp: r.hp } : {}) };
    // Targets on either side are keyed by their gameplan name (the side doesn't matter for the key).
    const name = nameOf(a.player, species) !== species ? nameOf(a.player, species) : nameOf(a.player === 'p1' ? 'p2' : 'p1', species);
    if (Object.keys(t).length) targets[name] = t;
  }
  if (a.selfHp !== undefined) targets[mon] = { ...(targets[mon] ?? {}), hp: a.selfHp };
  if (Object.keys(targets).length) o.targets = targets;
  const self = (a.self ?? []).filter((fx) => !always(a.move, fx));
  if (self.length) o.self = self;
  if (Object.keys(o).length) action.outcome = o;
  void sideOf;
  return action;
}

/* ---------- where the branch goes ---------- */

const leadSet = (s: SideSelection): string => [...s.lead].filter(Boolean).map((x) => toID(x!)).sort().join();
/** A tab fits when it has the same leads on both sides and every back the replay revealed. */
function tabFits(tab: PlanTab, branch: ReplayBranch): boolean {
  return SIDES.every((side) => {
    const want = branch.selection[side];
    const have = tab.selection[side];
    if (leadSet(want) !== leadSet(have)) return false;
    const haveBacks = have.back.filter((x): x is string => !!x).map(toID);
    return want.back.filter((x): x is string => !!x).every((b) => haveBacks.includes(toID(b)));
  });
}

/** What makes two turns the same: the same choices and the same recorded results. */
const fingerprint = (n: FlowNode): string => JSON.stringify({
  actions: [...n.actions].map((a) => ({ ...a })).sort((x, y) => `${x.side}${x.mon}`.localeCompare(`${y.side}${y.mon}`)),
  order: n.order ?? [], hpEnd: n.hpEnd ?? {},
});

export interface Placement { tab: PlanTab; created: boolean; merged: number; added: number }

/**
 * Puts the branch in the gameplan: in the first tab with the same leads and backs (unless `forceNew`), or in a new
 * tab named after the players with those leads and backs. Turns identical to ones already there (an earlier import
 * of the same game) are reused; the rest hang off the last shared turn.
 */
export function placeReplayBranch(plan: Plan, branch: ReplayBranch, forceNew: boolean): Placement {
  let tab = forceNew ? undefined : plan.tabs.find((t) => tabFits(t, branch));
  const created = !tab;
  if (!tab) {
    tab = newTab(nextTabName(plan));
    const base = `Replay: ${branch.title}`.slice(0, 54);
    const taken = new Set(plan.tabs.map((t) => t.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
    tab.name = name;
    tab.selection = structuredClone(branch.selection);
    plan.tabs.push(tab);
  }
  let siblings: FlowNode[] = tab.children;
  let merged = 0;
  let i = 0;
  for (; i < branch.turns.length; i++) {
    const turn = branch.turns[i]!;
    const match = siblings.find((n) => fingerprint(n) === fingerprint(turn));
    if (!match) break;
    merged++;
    siblings = match.children;
  }
  const rest = branch.turns[i];
  // The replay's branch is named where it starts: its first turn that isn't already in the plan (no colour, so it
  // keeps the default look). Turns shared with an earlier import keep whatever they had.
  if (rest) {
    rest.line ??= { name: `Replay: ${branch.title}` };
    siblings.push(rest);
  }
  if (!rest && !merged) throw new ReplayError('The replay has no turns to add.');
  return { tab, created, merged, added: branch.turns.length - i };
}

export { ReplayError };
