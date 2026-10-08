import { baseSpecies, isMega } from '../showdown.ts';
import { calcStats, emptyStatTable, statPoints } from '../stats.ts';
import { toID } from '../strings.ts';
import type { BoostKey, BoostTable, PlanTab, PokemonSet, Side, StatTable, TurnAction } from '../types.ts';
import { SIDES } from '../types.ts';
import type { CalcEngine } from './engine.ts';
import { Effects } from './effects.ts';
import type { LogEntry, SpeedTie } from './log.ts';
import type { ScreenKey, StatusId } from './tables.ts';
import { ENTRY_EFFECT_ABILITIES, SPEED_WEATHER } from './tables.ts';

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
  /** Actions spent frozen so far (Champions: it always thaws on its third). */
  frozen: number;
  /**
   * The item it holds now ('' once eaten, used up, knocked off or stolen). It stays that way after switching out:
   * items don't come back during a battle. `set.item` keeps what the paste says.
   */
  item: string;
  /** Unburden is active: it lost its item while on the field (Speed doubles until it switches out). */
  unburden: boolean;
  /** Once-per-battle entry abilities (Intrepid Sword, Dauntless Shield) have triggered. */
  entryBoosted: boolean;
  /**
   * A two-turn move charged last turn (Solar Beam outside sun, Electro Shot outside rain, Fly...): it is released
   * on its next action whatever was picked. `semi` describes a semi-invulnerable state (Fly: up high).
   */
  charging: { move: string; target: string; semi: string | null } | null;
  /** It used a recharge move (Hyper Beam...) that hit last turn: its next action is spent recharging. */
  recharging: string | null;
  /** Full turns spent on the field since it last came in (Fake Out only works when 0). */
  activeTurns: number;
  /** Move actions it has taken since it last came in, the current one included (Fake Out only works on the first). */
  moveActions: number;
  /** Times it has been hit by an attack this battle (Rage Fist), kept through switching. */
  timesHit: number;
  /** Its last action failed or was blocked (Stomping Tantrum, Temper Flare double their power). */
  lastFailed: boolean;
  /** Its last action was a successful Protect-like move (using one again straight away fails). */
  protectStreak: boolean;
  /** The last move it used, and at whom (Encore, Disable, Instruct, Choice lock). */
  lastMove: string;
  lastTarget: string;
  /** Locked into this move by a Choice item (until it switches out or loses the item). */
  choiceLock: string | null;
  /** Encore: must repeat `move` for `turns` more turns. Disable: can't use `move` for `turns` more turns. Taunt: no status moves. */
  encore: { move: string; turns: number } | null;
  disable: { move: string; turns: number } | null;
  taunt: number;
  /** Imprison: foes can't use the moves this Pokémon knows. */
  imprison: boolean;
  /** Substitute's remaining HP (0 = none). */
  sub: number;
  /** Yawn: falls asleep at the end of the turn this reaches 0 (2 when it was yawned at). */
  yawn: number;
  /** Perish Song count (faints when it reaches 0); null when not under it. */
  perish: number | null;
  /** Leech Seed: the side and position that gets the drained HP. */
  seeded: { side: Side; slot: number } | null;
  saltCure: boolean;
  /** Destiny Bond is up until its next action. */
  destinyBond: boolean;
  /** Protosynthesis / Quark Drive switched on by Booster Energy (stays on while it's in), with the stat it boosts. */
  boosted: BoostKey | 'hp' | null;
  /** Flash Fire has been activated; Electromorphosis / Wind Power charged its next Electric move. */
  flashFire: boolean;
  charge: boolean;
  /** Disguise / Ice Face has been used up. */
  disguiseBroken: boolean;
  /** HP percentage a turn pinned at its end (shown once on that turn's result). */
  actual?: number;
  /** Confusion: actions left before it snaps out (0 = not confused). */
  confused: number;
  /** Transform / Imposter: the form to go back to when it switches out. */
  transformedFrom: { species: string; ability: string; stats: StatTable | null } | null;
}

export interface Hazards { rocks: boolean; spikes: number; tspikes: number; web: boolean }
export const noHazards = (): Hazards => ({ rocks: false, spikes: 0, tspikes: 0, web: false });

export interface FieldState {
  weather: 'Sun' | 'Rain' | 'Sand' | 'Snow' | null;
  wTurns: number;
  terrain: 'Electric' | 'Grassy' | 'Psychic' | 'Misty' | null;
  tTurns: number;
  trick: number;
  tailwind: Record<Side, number>;
  screens: Record<Side, Record<ScreenKey, number>>;
  /** Entry hazards on each side. */
  hazards: Record<Side, Hazards>;
  gravity: number;
  magicRoom: number;
  wonderRoom: number;
  /** Wish: heals whoever stands in `slot` at the end of the turn `turns` reaches 0. */
  wish: Record<Side, { slot: number; amount: number; turns: number }[]>;
}

/** Things that only matter within one turn. */
export interface TurnScratch {
  /** The Protect variant each Pokémon used this turn, by {@link monKey}. */
  protect: Record<string, string>;
  /** Follow Me / Rage Powder in effect on each side this turn. */
  redirect: Record<Side, { name: string; powder: boolean } | null>;
  /** Pokémon that came in during this turn (Speed Boost skips them). */
  entered: Record<string, boolean>;
  wide: Record<Side, boolean>;
  quick: Record<Side, boolean>;
  helped: Record<string, boolean>;
  flinched: Record<string, boolean>;
  /** Pokémon that have taken their action this turn (Sucker Punch, Payback, Bolt Beak). */
  acted: Record<string, boolean>;
  /** For each Pokémon hit this turn, the keys of who hit it (Avalanche, Revenge, Assurance, Focus Punch). */
  hitBy: Record<string, string[]>;
  /** Pokémon that started charging a two-turn move this turn. */
  charged: Record<string, boolean>;
  /** The last damage each Pokémon took from a foe's attack this turn (Counter, Mirror Coat, Metal Burst). */
  damaged: Record<string, { amount: number; category: string; by: string }>;
  /** Switches forced by Eject Button, Eject Pack, Red Card or Emergency Exit, carried out after the current action. */
  forced: { side: Side; name: string; reason: string }[];
  /** After You / Quash: Pokémon made to act next, or last. */
  next: Record<string, boolean>;
  last: Record<string, boolean>;
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
  hazards: { me: noHazards(), opp: noHazards() }, gravity: 0, magicRoom: 0, wonderRoom: 0, wish: { me: [], opp: [] },
});
/**
 * One field effect in play during a turn. `left` is how many more turns it lasts after this one (0 = ends this turn),
 * null for effects with no timer (entry hazards).
 */
export interface FieldEffect { label: string; side: Side | null; left: number | null }

const SCREEN_LABEL: Readonly<Record<ScreenKey, string>> = { reflect: 'Reflect', light: 'Light Screen', veil: 'Aurora Veil' };

/** Lists what is in play, given the field as it stands before the end-of-turn countdown. */
export function fieldEffects(f: FieldState): FieldEffect[] {
  const out: FieldEffect[] = [];
  const add = (label: string, turns: number, side: Side | null = null): void => { if (turns > 0) out.push({ label, side, left: turns - 1 }); };
  if (f.weather) add(f.weather, f.wTurns);
  if (f.terrain) add(`${f.terrain} Terrain`, f.tTurns);
  add('Trick Room', f.trick);
  add('Gravity', f.gravity ?? 0);
  add('Magic Room', f.magicRoom ?? 0);
  add('Wonder Room', f.wonderRoom ?? 0);
  for (const side of SIDES) {
    add('Tailwind', f.tailwind[side], side);
    for (const k of Object.keys(SCREEN_LABEL) as ScreenKey[]) add(SCREEN_LABEL[k], f.screens[side][k], side);
    const h = f.hazards?.[side];
    if (h?.rocks) out.push({ label: 'Stealth Rock', side, left: null });
    if (h?.spikes) out.push({ label: h.spikes > 1 ? `Spikes ×${h.spikes}` : 'Spikes', side, left: null });
    if (h?.tspikes) out.push({ label: h.tspikes > 1 ? 'Toxic Spikes ×2' : 'Toxic Spikes', side, left: null });
    if (h?.web) out.push({ label: 'Sticky Web', side, left: null });
  }
  return out;
}

export const newScratch = (): TurnScratch => ({
  protect: {}, redirect: { me: null, opp: null }, entered: {}, wide: { me: false, opp: false }, quick: { me: false, opp: false }, helped: {}, flinched: {}, acted: {}, hitBy: {}, charged: {},
  damaged: {}, forced: [], next: {}, last: {},
});

/** The item that counts right now: none under Magic Room (the item is still held, and comes back when it ends). */
export const heldItem = (st: BattleState, mon: MonState): string => (st.field.magicRoom > 0 ? '' : mon.item);

/** Protosynthesis / Quark Drive is boosting this Pokémon: from sun / Electric Terrain, or from Booster Energy. */
export function paradoxActive(st: BattleState, mon: MonState): boolean {
  const ability = toID(mon.ability);
  if (ability !== 'protosynthesis' && ability !== 'quarkdrive') return false;
  if (mon.boosted) return true;
  return ability === 'protosynthesis' ? st.field.weather === 'Sun' && toID(heldItem(st, mon)) !== 'utilityumbrella' : st.field.terrain === 'Electric';
}

/** The stat Protosynthesis / Quark Drive boosts: the highest one, counting stat stages (ties go to the earlier stat). */
export function bestStat(mon: MonState): BoostKey {
  const stats = statsOf(mon);
  let best: BoostKey = 'atk';
  for (const k of ['def', 'spa', 'spd', 'spe'] as const) {
    if (Math.floor(stats[k] * boostMult(mon.boosts[k])) > Math.floor(stats[best] * boostMult(mon.boosts[best]))) best = k;
  }
  return best;
}

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

/**
 * Speed as the turn order sees it: stat stages, Choice Scarf / Iron Ball, Unburden, weather and terrain abilities
 * (Swift Swim, Chlorophyll, Sand Rush, Slush Rush, Surge Surfer), Protosynthesis / Quark Drive on Speed, Quick Feet,
 * paralysis and Tailwind.
 */
export function effSpeed(st: BattleState, side: Side, mon: MonState): number {
  let speed = Math.floor(statsOf(mon).spe * boostMult(mon.boosts.spe));
  const item = toID(heldItem(st, mon));
  const ability = toID(mon.ability);
  if (item === 'choicescarf') speed = Math.floor(speed * 1.5);
  if (item === 'ironball') speed = Math.floor(speed / 2);
  if (mon.unburden && !mon.item) speed *= 2;
  const fast = SPEED_WEATHER[ability];
  const umbrella = item === 'utilityumbrella';
  if (fast && ((fast.weather && st.field.weather === fast.weather && !(umbrella && (fast.weather === 'Rain' || fast.weather === 'Sun'))) || (fast.terrain && st.field.terrain === fast.terrain))) speed *= 2;
  if (paradoxActive(st, mon) && bestStat(mon) === 'spe') speed = Math.floor(speed * 1.5);
  if (mon.status && ability === 'quickfeet') speed = Math.floor(speed * 1.5);
  else if (mon.status === 'par') speed = Math.floor(speed / 2);
  if (st.field.tailwind[side] > 0) speed *= 2;
  return speed;
}

/**
 * Pokémon coming in at the same time (the leads, or replacements after a faint) trigger their entry abilities
 * fastest first. Equal Speed is a coin flip in the game: the winner picked in `tieOrder` (keys `side:name`), or else
 * the order given. Returns the order and the ties that matter (one of the two has an entry ability).
 */
export function entryOrder<T extends { side: Side; name: string }>(st: BattleState, list: readonly T[], tieOrder: readonly string[] = []): { order: T[]; ties: SpeedTie[] } {
  const key = (x: T): string => monKey(x.side, x.name);
  const speedOf = (x: T): number => { const m = st.mons[x.side][x.name]; return m?.stats ? effSpeed(st, x.side, m) : 0; };
  const picked = (x: T): number => tieOrder.indexOf(key(x));
  const order = list.map((x, i) => ({ x, i, speed: speedOf(x) }))
    .sort((a, b) => b.speed - a.speed || (picked(a.x) >= 0 && picked(b.x) >= 0 ? picked(a.x) - picked(b.x) : 0) || a.i - b.i);
  const ties: SpeedTie[] = [];
  const matters = (x: T): boolean => ENTRY_EFFECT_ABILITIES.has(toID(st.mons[x.side][x.name]?.ability ?? ''));
  order.forEach((a, i) => order.slice(i + 1).forEach((b) => {
    if (a.speed !== b.speed || !(matters(a.x) || matters(b.x))) return;
    const keys = [key(a.x), key(b.x)].sort() as [string, string];
    ties.push({ keys, speed: a.speed, first: key(a.x), picked: picked(a.x) >= 0 && picked(b.x) >= 0, entry: true });
  }));
  return { order: order.map((o) => o.x), ties };
}

/** `entryTies`: speed ties between the leads' entry abilities (see {@link entryOrder}). */
export interface InitialState { st: BattleState; entry: LogEntry[]; entryTies: SpeedTie[] }

/** Battle start: everyone at full HP, leads on the field, entry abilities resolved (fastest first, so the slowest weather wins). */
/** `tieOrder`: the first turn's picks for speed ties between the leads' entry abilities. */
export function initState(engine: CalcEngine, plan: Pick<PlanTab, 'selection'>, myMons: readonly PokemonSet[], oppMons: readonly PokemonSet[], tieOrder: readonly string[] = []): InitialState {
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
      // A Mega has a single ability, so the calculator's data decides it (Charizard-Mega-Y: Drought), whatever the
      // paste says. On a paste that names the Mega, a different ability line is the base form's (e.g. Blaze).
      const megaAbility = megaForm ? engine.defaultAbility(megaForm) || (pastedMega ? set.ability : '') : '';
      const baseAbility = pastedMega
        ? (set.ability && toID(set.ability) !== toID(megaAbility) ? set.ability : engine.defaultAbility(base))
        : set.ability;
      const mon: MonState = {
        name: set.species, set, species: base,
        ability: baseAbility,
        mega: false, megaForm, megaAbility,
        sp: (statPoints(set) ?? { sp: emptyStatTable() }).sp, stats: null, boosts: zeroBoosts(), hp: 0, hpLo: 0, hpHi: 0, fainted: false,
        status: null, toxic: 0, slept: 0, frozen: 0, item: set.item, unburden: false, entryBoosted: false,
        charging: null, recharging: null, activeTurns: 0, moveActions: 0, timesHit: 0, lastFailed: false, protectStreak: false,
        lastMove: '', lastTarget: '', choiceLock: null, encore: null, disable: null, taunt: 0, imprison: false, sub: 0, yawn: 0, perish: null,
        seeded: null, saltCure: false, destinyBond: false, boosted: null, flashFire: false, charge: false, disguiseBroken: false, transformedFrom: null, confused: 0,
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
  const leads = SIDES.flatMap((side) => st.active[side].filter((name) => st.mons[side][name]?.stats).map((name) => ({ side, name })));
  const { order, ties } = entryOrder(st, leads, tieOrder);
  const fx = new Effects(engine, st, entry);
  order.forEach((l) => fx.enter(l.side, l.name));
  return { st, entry, entryTies: ties.map((t) => ({ ...t, start: true as const })) };
}

