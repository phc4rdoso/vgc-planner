import { baseSpecies, isMega } from '../showdown.ts';
import { calcStats, emptyStatTable, statPoints } from '../stats.ts';
import { toID } from '../strings.ts';
import type { BoostKey, BoostTable, PlanTab, PokemonSet, Side, StatTable, TurnAction } from '../types.ts';
import { SIDES } from '../types.ts';
import type { CalcEngine } from './engine.ts';
import type { LogEntry, StatChange } from './log.ts';
import { ENTRY_TERRAIN, ENTRY_WEATHER, INTIMIDATE_IMMUNE, type ScreenKey, type StatusId } from './tables.ts';

export interface MonState {
  /** Name from the paste; the stable key used by plans and actions. */
  name: string;
  set: PokemonSet;
  /**
   * Current form. Everyone starts in base form, even when the paste names the Mega ("Aerodactyl-Mega"); it changes
   * on a "Mega evolve + move" action.
   */
  species: string;
  /** Current ability: the base form's until Mega Evolution, then the Mega's. */
  ability: string;
  /** Has Mega Evolved in this branch. */
  mega: boolean;
  /** The Mega form its held stone allows, and that form's ability; null when it can't Mega Evolve. */
  megaForm: string | null;
  megaAbility: string;
  sp: StatTable;
  stats: StatTable | null;
  boosts: BoostTable;
  hp: number;
  /** HP if every hit so far rolled highest / lowest. */
  hpLo: number;
  hpHi: number;
  fainted: boolean;
  status: StatusId | null;
  /** Badly poisoned: the next residual deals toxic/16. Resets to 1 on switching out. */
  toxic: number;
  /** Turns spent asleep so far. */
  slept: number;
}

export interface FieldState {
  weather: 'Sun' | 'Rain' | 'Sand' | 'Snow' | null;
  wTurns: number;
  terrain: 'Electric' | 'Grassy' | 'Psychic' | 'Misty' | null;
  tTurns: number;
  trick: number;
  tailwind: Record<Side, number>;
  screens: Record<Side, Record<ScreenKey, number>>;
}

/** Things that only matter within one turn. */
export interface TurnScratch {
  protect: Record<string, boolean>;
  wide: Record<Side, boolean>;
  quick: Record<Side, boolean>;
  helped: Record<string, boolean>;
  flinched: Record<string, boolean>;
}

export interface BattleState {
  mons: Record<Side, Record<string, MonState>>;
  active: Record<Side, string[]>;
  /** The Pokémon each side brought: its lead and back picks. Only these can act or come in. */
  party: Record<Side, string[]>;
  /** The Pokémon that Mega Evolved on each side in this branch (only one per side per battle). */
  megaUsed: Record<Side, string | null>;
  field: FieldState;
  turn: TurnScratch;
}

/** Whether `name` could Mega Evolve at the start of a turn in this state. */
export function canMegaEvolve(st: BattleState, side: Side, name: string): boolean {
  const mon = st.mons[side][name];
  return !!mon && !mon.fainted && !mon.mega && mon.megaForm !== null && st.megaUsed[side] === null;
}

export const zeroBoosts = (): BoostTable => ({ atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });
export const otherSide = (s: Side): Side => (s === 'me' ? 'opp' : 'me');
export const monKey = (side: Side, name: string): string => `${side}:${name}`;
export const boostMult = (b: number): number => (b >= 0 ? (2 + b) / 2 : 2 / (2 - b));

export const newField = (): FieldState => ({
  weather: null, wTurns: 0, terrain: null, tTurns: 0, trick: 0,
  tailwind: { me: 0, opp: 0 },
  screens: { me: { reflect: 0, light: 0, veil: 0 }, opp: { reflect: 0, light: 0, veil: 0 } },
});
/** One field effect in play during a turn. `left` is how many more turns it lasts after this one (0 = ends this turn). */
export interface FieldEffect { label: string; side: Side | null; left: number }

const SCREEN_LABEL: Readonly<Record<ScreenKey, string>> = { reflect: 'Reflect', light: 'Light Screen', veil: 'Aurora Veil' };

/** Lists what is in play, given the field as it stands before the end-of-turn countdown. */
export function fieldEffects(f: FieldState): FieldEffect[] {
  const out: FieldEffect[] = [];
  const add = (label: string, turns: number, side: Side | null = null): void => { if (turns > 0) out.push({ label, side, left: turns - 1 }); };
  if (f.weather) add(f.weather, f.wTurns);
  if (f.terrain) add(`${f.terrain} Terrain`, f.tTurns);
  add('Trick Room', f.trick);
  for (const side of SIDES) {
    add('Tailwind', f.tailwind[side], side);
    for (const k of Object.keys(SCREEN_LABEL) as ScreenKey[]) add(SCREEN_LABEL[k], f.screens[side][k], side);
  }
  return out;
}

export const newScratch = (): TurnScratch => ({ protect: {}, wide: { me: false, opp: false }, quick: { me: false, opp: false }, helped: {}, flinched: {} });

/** Mon that must have stats; throws a plain Error (shown as a calculator problem) otherwise. */
export function statsOf(mon: MonState): StatTable {
  if (!mon.stats) throw new Error(`${mon.species} isn't in the calculator's data`);
  return mon.stats;
}

/** Recomputes stats for the current form. HP keeps its proportion when the maximum changes (Mega Evolution). */
export function refreshStats(engine: CalcEngine, mon: MonState): void {
  const base = engine.baseStats(mon.species);
  if (!base) { mon.stats = null; return; }
  const previous = mon.stats ? mon.stats.hp : null;
  mon.stats = calcStats(base, mon.sp, mon.set.nature);
  if (previous === null) {
    mon.hp = mon.hpLo = mon.hpHi = mon.stats.hp;
  } else if (previous !== mon.stats.hp) {
    const ratio = mon.stats.hp / previous;
    mon.hp = Math.max(1, Math.round(mon.hp * ratio));
    mon.hpLo = Math.round(mon.hpLo * ratio);
    mon.hpHi = Math.round(mon.hpHi * ratio);
  }
}

/** Applies a stage change, clamped to ±6. Returns the change that actually happened. */
export function applyBoost(mon: MonState, stat: BoostKey, delta: number): number {
  const before = mon.boosts[stat];
  mon.boosts[stat] = Math.max(-6, Math.min(6, before + delta));
  return mon.boosts[stat] - before;
}

export const aliveActive = (st: BattleState, side: Side): string[] =>
  st.active[side].filter((n) => st.mons[side][n] !== undefined && !st.mons[side][n]!.fainted);

/** Pokémon that could come in now: those brought (lead and back picks) that are neither active nor fainted. Empty if no backs were picked. */
export function bench(st: BattleState, side: Side): string[] {
  return st.party[side].filter((n) => !st.active[side].includes(n) && st.mons[side][n] !== undefined && !st.mons[side][n]!.fainted);
}

/** A side is out of the battle once every Pokémon it brought has fainted (needs a full party of 4, or the whole team if smaller). */
export function defeated(st: BattleState, side: Side): boolean {
  const party = st.party[side];
  const needed = Math.min(4, Object.keys(st.mons[side]).length);
  return needed > 0 && party.length >= needed && party.every((n) => st.mons[side][n]?.fainted === true);
}

/**
 * Starting actions for a follow-up turn: a move for each active Pokémon, and for each fainted one (while someone can
 * come in) an action with no Pokémon chosen yet; whoever the user picks there replaces it.
 */
export const nextActions = (st: BattleState): TurnAction[] => syncTurnActions(st, []);

const blankAction = (side: Side, mon = ''): TurnAction => ({ side, mon, kind: 'move', move: '', target: '' });

/**
 * The actions a turn should have, given the state it starts from: one for each Pokémon on the field (keeping what
 * was already entered for it), plus one for each fainted slot that can be refilled, whose Pokémon is picked from the
 * bench. Actions for anyone else (benched, fainted, not brought) are dropped. Returns the same objects where it can,
 * so edits in progress are kept.
 */
export function syncTurnActions(st: BattleState, actions: readonly TurnAction[]): TurnAction[] {
  const out: TurnAction[] = [];
  for (const side of SIDES) {
    const own = actions.filter((a) => a.side === side);
    const taken = new Set<TurnAction>();
    for (const name of st.active[side]) {
      if (!st.mons[side][name] || st.mons[side][name]!.fainted) continue;
      const a = own.find((x) => x.mon === name && !taken.has(x)) ?? blankAction(side, name);
      taken.add(a);
      out.push(a);
    }
    const free = bench(st, side);
    const slots = Math.min(st.active[side].filter((n) => st.mons[side][n]?.fainted).length, free.length);
    const picked = new Set<string>();
    const candidates = own.filter((a) => !taken.has(a)).flatMap((a) => {
      // Older plans wrote a replacement as "switch the fainted Pokémon to X": keep X as the replacement.
      const mon = a.kind === 'switch' && st.mons[side][a.mon]?.fainted ? a.target : a.mon;
      if (mon && (!free.includes(mon) || picked.has(mon))) return [];
      if (mon) picked.add(mon);
      return [mon === a.mon ? a : { ...blankAction(side, mon) }];
    });
    for (let i = 0; i < slots; i++) out.push(candidates[i] ?? blankAction(side));
  }
  return out;
}

/** Who is on the field once a turn's replacements are in (mirrors how the turn runs): the Pokémon that can be targeted. */
export function fieldAfterReplacements(st: BattleState, actions: readonly TurnAction[]): Record<Side, string[]> {
  const out: Record<Side, string[]> = { me: [], opp: [] };
  for (const side of SIDES) {
    const free = bench(st, side);
    const comingIn = [...new Set(actions.filter((a) => a.side === side && free.includes(a.mon)).map((a) => a.mon))];
    let next = 0;
    out[side] = st.active[side]
      .map((n) => (st.mons[side][n]?.fainted ? (comingIn[next++] ?? null) : n))
      .filter((n): n is string => n !== null);
  }
  return out;
}

export type Outcome = 'win' | 'loss' | 'draw';

/** The battle's result from your point of view, or null while both sides still have Pokémon. */
export function outcomeOf(st: BattleState): Outcome | null {
  const lost = defeated(st, 'me');
  const won = defeated(st, 'opp');
  return won && lost ? 'draw' : won ? 'win' : lost ? 'loss' : null;
}

export function effSpeed(st: BattleState, side: Side, mon: MonState): number {
  let speed = Math.floor(statsOf(mon).spe * boostMult(mon.boosts.spe));
  if (toID(mon.set.item) === 'choicescarf') speed = Math.floor(speed * 1.5);
  if (mon.status && toID(mon.ability) === 'quickfeet') speed = Math.floor(speed * 1.5);
  else if (mon.status === 'par') speed = Math.floor(speed / 2);
  if (st.field.tailwind[side] > 0) speed *= 2;
  return speed;
}

/** Weather/terrain abilities and Intimidate when a Pokémon enters the field. */
export function enterMon(st: BattleState, side: Side, name: string, log: LogEntry[]): void {
  const mon = st.mons[side][name];
  if (!mon) return;
  const ability = toID(mon.ability);
  const f = st.field;
  const weather = ENTRY_WEATHER[ability];
  if (weather) {
    f.weather = weather; f.wTurns = 5;
    log.push({ type: 'field', side, mon: name, move: mon.ability, text: `${weather} for 5 turns` });
  }
  const terrain = ENTRY_TERRAIN[ability];
  if (terrain) {
    f.terrain = terrain; f.tTurns = 5;
    log.push({ type: 'field', side, mon: name, move: mon.ability, text: `${terrain} Terrain for 5 turns` });
  }
  if (ability !== 'intimidate') return;
  const foe = otherSide(side);
  for (const foeName of aliveActive(st, foe)) {
    const target = st.mons[foe][foeName]!;
    const targetAbility = toID(target.ability);
    if (INTIMIDATE_IMMUNE.includes(targetAbility)) {
      log.push({ type: 'boost', side: foe, mon: foeName, move: `Intimidate (${target.ability})`, changes: [] });
      continue;
    }
    const changes: StatChange[] = [{ stat: 'atk', delta: applyBoost(target, 'atk', targetAbility === 'contrary' || targetAbility === 'guarddog' ? 1 : -1) }];
    if (targetAbility === 'defiant') changes[0]!.delta += applyBoost(target, 'atk', 2);
    if (targetAbility === 'competitive') changes.push({ stat: 'spa', delta: applyBoost(target, 'spa', 2) });
    log.push({ type: 'boost', side: foe, mon: foeName, move: `${mon.name}'s Intimidate`, changes });
  }
}

export interface InitialState { st: BattleState; entry: LogEntry[] }

/** Battle start: everyone at full HP, leads on the field, entry abilities resolved (fastest first, so the slowest weather wins). */
export function initState(engine: CalcEngine, plan: Pick<PlanTab, 'selection'>, myMons: readonly PokemonSet[], oppMons: readonly PokemonSet[]): InitialState {
  const st: BattleState = {
    mons: { me: {}, opp: {} }, active: { me: [], opp: [] }, party: { me: [], opp: [] }, megaUsed: { me: null, opp: null },
    field: newField(), turn: newScratch(),
  };
  const add = (side: Side, list: readonly PokemonSet[]): void => {
    for (const set of list) {
      // A paste may name the Mega form ("Aerodactyl-Mega", with the Mega's ability): the battle still starts in base form.
      const pastedMega = isMega(set.species);
      const base = pastedMega ? baseSpecies(set.species) : set.species;
      const megaForm = engine.megaOf(base, set.item) ?? (pastedMega ? set.species : null);
      const mon: MonState = {
        name: set.species, set, species: base,
        ability: pastedMega ? engine.defaultAbility(base) : set.ability,
        mega: false, megaForm,
        megaAbility: megaForm ? (pastedMega && set.ability ? set.ability : engine.defaultAbility(megaForm)) : '',
        sp: (statPoints(set) ?? { sp: emptyStatTable() }).sp, stats: null, boosts: zeroBoosts(), hp: 0, hpLo: 0, hpHi: 0, fainted: false,
        status: null, toxic: 0, slept: 0,
      };
      refreshStats(engine, mon);
      st.mons[side][set.species] = mon;
    }
  };
  add('me', myMons);
  add('opp', oppMons);
  for (const side of SIDES) {
    const known = (n: string | null): n is string => !!n && st.mons[side][n] !== undefined;
    const backs = plan.selection[side].back.filter(known);
    st.active[side] = plan.selection[side].lead.filter(known);
    st.party[side] = [...new Set([...st.active[side], ...backs])];
  }

  const entry: LogEntry[] = [];
  const leads: { side: Side; name: string; speed: number }[] = [];
  for (const side of SIDES) {
    for (const name of st.active[side]) {
      const mon = st.mons[side][name]!;
      if (mon.stats) leads.push({ side, name, speed: effSpeed(st, side, mon) });
    }
  }
  leads.sort((a, b) => b.speed - a.speed).forEach((l) => enterMon(st, l.side, l.name, entry));
  return { st, entry };
}

