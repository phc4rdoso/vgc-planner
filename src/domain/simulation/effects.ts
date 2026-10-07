import { BOOST_KEYS } from '../stats.ts';
import { toID } from '../strings.ts';
import type { BoostKey, Side } from '../types.ts';
import type { CalcEngine } from './engine.ts';
import type { LogEntry, StatChange } from './log.ts';
import type { BattleState, FieldState, MonState } from './state.ts';
import { aliveActive, applyBoost, bestStat, boostMult, effSpeed, heldItem, monKey, otherSide, statsOf, zeroBoosts } from './state.ts';
import type { BoostChange, StatusId } from './tables.ts';
import {
  ALL_STATUS_IMMUNE, CURE_BERRIES, statEffect, ENTRY_BOOSTS, ENTRY_TERRAIN, ENTRY_WEATHER, EXIT_ABILITIES, FIXED_ABILITIES, HP_BERRIES, INTIMIDATE_IMMUNE,
  SAND_IMMUNE, SAND_IMMUNE_TYPES, STAT_DROP_BLOCKERS, STAT_DROP_ITEMS, STATUS_ABILITY_IMMUNE, STATUS_LABEL, STATUS_TYPE_IMMUNE, STICKY_ABILITIES,
  TERRAIN_EXTENDER, TERRAIN_SEEDS, UNNERVE, WEATHER_ROCKS,
} from './tables.ts';

/** Outcome of trying to give a Pokémon a condition. */
export interface Inflicted { status?: StatusId; blocked?: string; cured?: string }

type Weather = NonNullable<FieldState['weather']>;
type Terrain = NonNullable<FieldState['terrain']>;

/**
 * Who caused a stat change. `own`: the Pokémon itself (Draco Meteor, a berry, Swords Dance), so drop-blocking
 * abilities don't apply. `foe`: an opponent, which is what Defiant and Competitive answer. `secondary`: an
 * attack's added effect, which Shield Dust and Covert Cloak stop.
 */
export interface ChangeOptions { own?: boolean; foe?: boolean; secondary?: boolean; copied?: boolean }

interface Active { side: Side; name: string; mon: MonState }

/** Percent with up to two decimals, so fixed fractions read exactly (1/16 = 6.25%). */
const pct = (x: number): number => Math.round(x * 100) / 100;
/** An effect that removes or restores a fixed fraction of max HP (at least 1 HP), and that fraction for the log. */
export const share = (max: number, fraction: number): { amount: number; fraction: number } => ({ amount: Math.max(1, Math.floor(max * fraction)), fraction });

/** Adds stat changes together by stat, keeping the order they first happened in. */
function merge(into: StatChange[], more: readonly StatChange[]): StatChange[] {
  for (const c of more) {
    const same = into.find((x) => x.stat === c.stat);
    if (same) same.delta += c.delta; else into.push({ ...c });
  }
  return into;
}

/**
 * Things that happen to Pokémon as a result of the battle's state: HP changes and what they trigger (berries,
 * fainting), items being used up or taken, stat changes and the abilities that answer them, entry abilities and the
 * end-of-turn effects. The turn runner decides *when* each happens; the damage itself comes from the calculator.
 */
export class Effects {
  private readonly engine: CalcEngine;
  private readonly st: BattleState;
  readonly log: LogEntry[];

  constructor(engine: CalcEngine, st: BattleState, log: LogEntry[]) {
    this.engine = engine;
    this.st = st;
    this.log = log;
  }

  private mon(side: Side, name: string): MonState | undefined {
    return this.st.mons[side][name];
  }

  /** The item that counts right now (none under Magic Room). */
  item(mon: MonState): string {
    return heldItem(this.st, mon);
  }

  private onField(side: Side, name: string): boolean {
    const mon = this.mon(side, name);
    return !!mon && !mon.fainted && this.st.active[side].includes(name);
  }

  /** Active Pokémon in the order simultaneous effects resolve: fastest first, slowest first under Trick Room. */
  speedOrder(): Active[] {
    const trick = this.st.field.trick > 0 ? -1 : 1;
    return (['me', 'opp'] as const).flatMap((side) => aliveActive(this.st, side).map((name) => ({ side, name, mon: this.st.mons[side][name]! })))
      .sort((x, y) => trick * (effSpeed(this.st, y.side, y.mon) - effSpeed(this.st, x.side, x.mon)));
  }

  /** Not Flying type, no Levitate, no Air Balloon (everyone is grounded under Gravity): affected by terrain. */
  grounded(mon: MonState): boolean {
    if (this.st.field.gravity > 0) return true;
    return !this.engine.typesOf(mon.species).includes('Flying') && toID(mon.ability) !== 'levitate' && toID(this.item(mon)) !== 'airballoon';
  }

  /** Grass types, Overcoat and Safety Goggles ignore powder moves (Spore, Rage Powder...). */
  powderImmune(mon: MonState): boolean {
    return this.engine.typesOf(mon.species).includes('Grass') || toID(mon.ability) === 'overcoat' || toID(this.item(mon)) === 'safetygoggles';
  }

  /** Magic Guard: only attacks can hurt it. */
  indirectImmune(mon: MonState): boolean {
    return toID(mon.ability) === 'magicguard';
  }

  /**
   * HP lost outside an attack's damage roll (recoil, Life Orb, Rough Skin, weather, poison...): the same amount in
   * every roll branch. Logged unless `text` is null; berries and fainting follow. Effects worth a fixed fraction of
   * max HP pass it as `fraction`, so every Pokémon reads the same percentage (1/16 is 6.25%, whatever the HP total).
   */
  hurt(side: Side, name: string, amount: number, text: string | null, fraction?: number): void {
    const mon = this.mon(side, name);
    if (!mon || mon.fainted || amount <= 0) return;
    const max = statsOf(mon).hp;
    const before = mon.hp;
    mon.hp = Math.max(0, mon.hp - amount);
    mon.hpLo = Math.max(0, mon.hpLo - amount);
    mon.hpHi = Math.max(0, mon.hpHi - amount);
    if (mon.hp <= 0) mon.fainted = true;
    if (text !== null) this.log.push({ type: 'residual', side, mon: name, text, pct: -pct((fraction ?? amount / max) * 100), fainted: mon.fainted });
    if (mon.fainted) this.fainted(side, name);
    this.berries(side, name);
    this.droppedBelowHalf(side, name, before, false);
  }

  /**
   * HP fell from at least half to below half: Emergency Exit / Wimp Out switch the holder out; after an attack,
   * Berserk (+1 Sp. Atk) and Anger Shell (+1 Atk, Sp. Atk, Speed, −1 Def, Sp. Def) answer it.
   */
  droppedBelowHalf(side: Side, name: string, before: number, byAttack: boolean): void {
    const mon = this.mon(side, name);
    if (!mon || mon.fainted) return;
    const half = statsOf(mon).hp / 2;
    if (!(before >= half && mon.hp < half)) return;
    const ability = toID(mon.ability);
    if (byAttack && ability === 'berserk') this.boostEntry(side, name, mon.ability, { spa: 1 });
    if (byAttack && ability === 'angershell') this.boostEntry(side, name, mon.ability, { atk: 1, spa: 1, spe: 1, def: -1, spd: -1 });
    if (EXIT_ABILITIES.has(ability)) this.forceOut(side, name, mon.ability);
  }

  /** Queues a forced switch (carried out after the current action, into the Pokémon picked on its action). */
  forceOut(side: Side, name: string, reason: string): void {
    if (!this.onField(side, name) || !this.st.party[side].some((n) => !this.st.active[side].includes(n) && !this.st.mons[side][n]?.fainted)) return;
    if (this.st.turn.forced.some((f) => f.side === side && f.name === name)) return;
    this.st.turn.forced.push({ side, name, reason });
  }

  /**
   * Confuses a Pokémon for up to 4 of its actions (the length is chance: a turn's outcome says when it snaps out).
   * Own Tempo, Misty Terrain and a Substitute (against others) stop it. Returns why it failed, or null.
   */
  confuse(side: Side, name: string, byOther: boolean): string | null {
    const mon = this.mon(side, name);
    if (!mon || mon.fainted) return 'fainted';
    if (mon.confused) return 'already confused';
    if (toID(mon.ability) === 'owntempo') return mon.ability;
    if (this.grounded(mon) && this.st.field.terrain === 'Misty') return 'Misty Terrain';
    if (byOther && mon.sub) return 'Substitute';
    mon.confused = 4;
    if (toID(this.item(mon)) === 'persimberry') { this.loseItem(side, name, 'cures the confusion'); mon.confused = 0; }
    return null;
  }

  /**
   * A confused Pokémon hits itself: a typeless 40-power physical hit with its own Attack against its own Defense (the
   * average roll), unless the turn pins its HP (`pinned`, percent).
   */
  confusionHit(side: Side, name: string, pinned?: number): void {
    const mon = this.mon(side, name);
    if (!mon) return;
    const stats = statsOf(mon);
    if (pinned !== undefined) {
      const after = pinned > 0 ? Math.max(1, Math.round((pinned * stats.hp) / 100)) : 0;
      this.hurt(side, name, Math.max(0, mon.hp - after), 'hurt itself in confusion');
      return;
    }
    const atk = Math.floor(stats.atk * boostMult(mon.boosts.atk)) * (mon.status === 'brn' ? 0.5 : 1);
    const def = Math.floor(stats.def * boostMult(mon.boosts.def));
    const base = Math.floor(Math.floor((Math.floor((2 * 50) / 5 + 2) * 40 * atk) / Math.max(1, def)) / 50) + 2;
    this.hurt(side, name, Math.max(1, Math.floor(base * 0.925)), 'hurt itself in confusion');
  }

  /**
   * A chance effect landing on a Pokémon (from a turn's outcome): a condition, flinch (only before it has moved),
   * confusion, or a stat change. Returns a short label of what happened, or null if nothing did.
   */
  chanceEffect(side: Side, name: string, effect: string, actor: MonState | null, byFoe: boolean): string | null {
    const mon = this.mon(side, name);
    if (!mon || mon.fainted) return null;
    if (effect === 'flinch') {
      if (this.st.turn.acted[monKey(side, name)] || toID(mon.ability) === 'innerfocus') return null;
      this.st.turn.flinched[monKey(side, name)] = true;
      return 'flinch';
    }
    if (effect === 'confusion') return this.confuse(side, name, byFoe) ? null : 'confused';
    const stats = statEffect(effect);
    if (stats) {
      const changes = this.changes(side, name, stats, byFoe ? { foe: true, secondary: true } : { own: true });
      return changes.some((c) => c.delta !== 0) ? effect : null;
    }
    const got = this.inflict(side, name, actor, effect as StatusId);
    return got.status ? (got.cured ? `${effect} (cured by ${got.cured})` : effect) : null;
  }

  /** Something fainted: Soul-Heart raises its holder's Sp. Atk. */
  fainted(side: Side, name: string): void {
    void side; void name;
    for (const a of this.speedOrder()) {
      if (toID(a.mon.ability) === 'soulheart') this.boostEntry(a.side, a.name, a.mon.ability, { spa: 1 });
    }
  }

  /**
   * Gives a Pokémon a condition unless its type, ability, Substitute, the terrain or an existing condition prevents
   * it. A matching berry (Lum, Chesto...) cures it straight away and is used up. `actor` is who causes it (Corrosion).
   */
  inflict(side: Side, name: string, actor: MonState | null, status: StatusId): Inflicted {
    const target = this.mon(side, name);
    if (!target || target.fainted) return { blocked: 'fainted' };
    if (target.status) return { blocked: `already ${STATUS_LABEL[target.status]}` };
    const types = this.engine.typesOf(target.species);
    const ability = toID(target.ability);
    const corrosion = actor !== null && toID(actor.ability) === 'corrosion' && (status === 'psn' || status === 'tox');
    const immuneType = corrosion ? undefined : STATUS_TYPE_IMMUNE[status].find((t) => types.includes(t));
    if (immuneType) return { blocked: `${immuneType} type` };
    if (ALL_STATUS_IMMUNE.includes(ability) || STATUS_ABILITY_IMMUNE[status].includes(ability) || (ability === 'leafguard' && this.st.field.weather === 'Sun')) {
      return { blocked: target.ability };
    }
    if (status === 'frz' && this.st.field.weather === 'Sun') return { blocked: 'harsh sunlight' };
    const grounded = this.grounded(target);
    if (grounded && this.st.field.terrain === 'Misty') return { blocked: 'Misty Terrain' };
    if (grounded && this.st.field.terrain === 'Electric' && status === 'slp') return { blocked: 'Electric Terrain' };

    target.status = status;
    target.toxic = status === 'tox' ? 1 : 0;
    target.slept = 0;
    target.frozen = 0;
    const berry = this.item(target);
    if (CURE_BERRIES[toID(berry)]?.includes(status)) {
      target.status = null;
      this.takeItem(side, name);
      return { status, cured: berry };
    }
    return { status };
  }

  /**
   * Restores HP (never above the maximum, never to a fainted Pokémon). Returns the HP actually restored. With
   * `fraction`, the log shows that fraction unless missing HP capped the healing.
   */
  heal(side: Side, name: string, amount: number, text: string, fraction?: number): number {
    const mon = this.mon(side, name);
    if (!mon || mon.fainted || amount <= 0) return 0;
    const max = statsOf(mon).hp;
    const gain = Math.min(amount, max - mon.hp);
    if (gain <= 0) return 0;
    mon.hp += gain;
    // A branch where it already fainted stays fainted.
    mon.hpLo = mon.hpLo > 0 ? Math.min(max, mon.hpLo + amount) : 0;
    mon.hpHi = Math.min(max, mon.hpHi + amount);
    this.log.push({ type: 'residual', side, mon: name, text, pct: pct((gain === amount && fraction !== undefined ? fraction : gain / max) * 100), fainted: false });
    return gain;
  }

  /** Its own Mega Stone can't be removed, and Sticky Hold keeps any item in place. */
  removable(mon: MonState): boolean {
    if (!mon.item || STICKY_ABILITIES.includes(toID(mon.ability))) return false;
    const ownStone = this.engine.megaOf(mon.species, mon.item) !== null || (mon.mega && toID(mon.item) === toID(mon.set.item));
    return !ownStone;
  }

  /**
   * The item is gone for the rest of the battle (eaten, used up, knocked off, stolen): it doesn't come back on
   * switching. Unburden doubles Speed while the holder stays in. Returns the item that was lost.
   */
  takeItem(side: Side, name: string): string {
    const mon = this.mon(side, name);
    if (!mon?.item) return '';
    const item = mon.item;
    mon.item = '';
    if (toID(mon.ability) === 'unburden' && this.onField(side, name) && !mon.unburden) {
      mon.unburden = true;
      this.log.push({ type: 'effect', side, mon: name, source: mon.ability, text: 'Speed doubles (lost its item)' });
    }
    return item;
  }

  /** {@link takeItem}, logging what happened to the item. */
  loseItem(side: Side, name: string, text: string): void {
    const item = this.mon(side, name)?.item;
    if (!item) return;
    this.log.push({ type: 'effect', side, mon: name, source: item, text });
    this.takeItem(side, name);
  }

  /**
   * Applies stat stage changes: Contrary reverses them, Simple doubles them, drop-blocking abilities and items stop
   * drops caused by others, Defiant / Competitive answer a drop caused by an opponent, and White Herb undoes drops.
   * Returns the net change per stat.
   */
  changes(side: Side, name: string, table: BoostChange | undefined, opts: ChangeOptions = {}): StatChange[] {
    const mon = this.mon(side, name);
    if (!mon || !table || mon.fainted) return [];
    const ability = toID(mon.ability);
    const item = toID(this.item(mon));
    const blocked = !opts.own && (STAT_DROP_BLOCKERS.includes(ability) || ability === 'mirrorarmor' || STAT_DROP_ITEMS.includes(item)
      || (opts.secondary === true && (ability === 'shielddust' || item === 'covertcloak')));
    const out: StatChange[] = [];
    let dropped = false;
    for (const stat of Object.keys(table) as BoostKey[]) {
      let delta = table[stat] ?? 0;
      if (delta < 0 && blocked) continue;
      if (ability === 'contrary') delta = -delta;
      if (ability === 'simple') delta *= 2;
      const got = applyBoost(mon, stat, delta);
      if (got < 0) dropped = true;
      merge(out, [{ stat, delta: got }]);
    }
    if (dropped && opts.foe) {
      if (ability === 'defiant') merge(out, [{ stat: 'atk', delta: applyBoost(mon, 'atk', 2) }]);
      if (ability === 'competitive') merge(out, [{ stat: 'spa', delta: applyBoost(mon, 'spa', 2) }]);
    }
    if (item === 'whiteherb' && BOOST_KEYS.some((k) => mon.boosts[k] < 0)) {
      const restored = BOOST_KEYS.filter((k) => mon.boosts[k] < 0).map((k) => ({ stat: k, delta: -mon.boosts[k] }));
      for (const k of BOOST_KEYS) if (mon.boosts[k] < 0) mon.boosts[k] = 0;
      merge(out, restored);
      this.loseItem(side, name, 'restores its lowered stats');
    } else if (dropped && toID(this.item(mon)) === 'ejectpack' && this.onField(side, name)) {
      this.loseItem(side, name, 'sends it back (a stat was lowered)');
      this.forceOut(side, name, 'Eject Pack');
    }
    // A foe's Mirror Herb (used up) or Opportunist copies the raises.
    const raised: BoostChange = {};
    for (const c of out) if (c.delta > 0) raised[c.stat] = c.delta;
    if (Object.keys(raised).length && !opts.copied) {
      const foe = otherSide(side);
      for (const n of aliveActive(this.st, foe)) {
        const other = this.st.mons[foe][n]!;
        if (toID(this.item(other)) === 'mirrorherb') {
          const herb = this.takeItem(foe, n);
          this.boostEntry(foe, n, herb, raised, { own: true, copied: true });
        } else if (toID(other.ability) === 'opportunist') this.boostEntry(foe, n, other.ability, raised, { own: true, copied: true });
      }
    }
    return out;
  }

  /** Haze, Clear Smog: every stat stage back to 0. */
  clearBoosts(side: Side, name: string): void {
    const mon = this.mon(side, name);
    if (mon) mon.boosts = zeroBoosts();
  }

  /** Logs a stat change from an item or ability (the entry is logged first, so anything it triggers comes after). */
  boostEntry(side: Side, name: string, source: string, table: BoostChange, opts: ChangeOptions = { own: true }): void {
    const entry: Extract<LogEntry, { type: 'boost' }> = { type: 'boost', side, mon: name, move: source, changes: [] };
    this.log.push(entry);
    entry.changes = this.changes(side, name, table, opts);
  }

  private unnerved(side: Side): boolean {
    const foe = otherSide(side);
    return aliveActive(this.st, foe).some((n) => UNNERVE.includes(toID(this.st.mons[foe][n]!.ability)));
  }

  /** HP berries: eaten once, as soon as HP is at or below their threshold (Gluttony raises ¼ to ½, Ripen doubles the effect). */
  berries(side: Side, name: string): void {
    const mon = this.mon(side, name);
    if (!mon || mon.fainted || !mon.item) return;
    const berry = HP_BERRIES[toID(this.item(mon))];
    if (!berry || this.unnerved(side)) return;
    const ability = toID(mon.ability);
    const max = statsOf(mon).hp;
    const at = berry.at < 1 / 2 && ability === 'gluttony' ? 1 / 2 : berry.at;
    if (mon.hp > Math.floor(max * at)) return;
    const ripen = ability === 'ripen' ? 2 : 1;
    const item = this.takeItem(side, name);
    if (berry.boost) this.boostEntry(side, name, item, { [berry.boost]: ripen });
    else {
      const healed = berry.flat !== undefined ? this.heal(side, name, berry.flat * ripen, item)
        : this.heal(side, name, share(max, (berry.heal ?? 0) * ripen).amount, item, (berry.heal ?? 0) * ripen);
      if (!healed) this.log.push({ type: 'effect', side, mon: name, source: item, text: 'is eaten' });
    }
  }

  /** A terrain seed is eaten when its terrain is up while the holder is on the field (once: then it's gone). */
  seed(side: Side, name: string): void {
    const mon = this.mon(side, name);
    if (!mon || !this.onField(side, name)) return;
    const seed = TERRAIN_SEEDS[toID(this.item(mon))];
    if (!seed || this.st.field.terrain !== seed.terrain) return;
    const item = this.takeItem(side, name);
    this.boostEntry(side, name, item, { [seed.stat]: 1 });
  }

  /** Starts a weather (5 turns, 8 with its rock). Fails, returning 0, when that weather is already up. */
  setWeather(weather: Weather, side: Side, name: string, source: string, log = true): number {
    const f = this.st.field;
    if (f.weather === weather) return 0;
    const holder = this.mon(side, name);
    f.weather = weather;
    f.wTurns = holder && WEATHER_ROCKS[toID(this.item(holder))] === weather ? 8 : 5;
    if (log) this.log.push({ type: 'field', side, mon: name, move: source, text: `${weather} for ${f.wTurns} turns` });
    return f.wTurns;
  }

  /** Starts a terrain (5 turns, 8 with Terrain Extender), then seeds react. Fails, returning 0, when it's already up. */
  setTerrain(terrain: Terrain, side: Side, name: string, source: string, log = true): number {
    const f = this.st.field;
    if (f.terrain === terrain) return 0;
    const holder = this.mon(side, name);
    f.terrain = terrain;
    f.tTurns = holder && toID(this.item(holder)) === TERRAIN_EXTENDER ? 8 : 5;
    if (log) this.log.push({ type: 'field', side, mon: name, move: source, text: `${terrain} Terrain for ${f.tTurns} turns` });
    for (const a of this.speedOrder()) this.seed(a.side, a.name);
    return f.tTurns;
  }

  /** Entry effects when a Pokémon comes in or Mega Evolves: weather/terrain, Intimidate, Hospitality, Download, seeds... */
  enter(side: Side, name: string, mega = false): void {
    const mon = this.mon(side, name);
    if (!mon || mon.fainted) return;
    this.st.turn.entered[monKey(side, name)] = true;
    if (!mega) {
      this.hazards(side, name);
      if (mon.fainted) return;
    }
    let ability = toID(mon.ability);
    if (ability === 'imposter') { this.imposter(side, name); ability = toID(mon.ability); }
    if (ability === 'trace') { this.trace(side, name); ability = toID(mon.ability); }
    const weather = ENTRY_WEATHER[ability];
    if (weather) this.setWeather(weather, side, name, mon.ability);
    const terrain = ENTRY_TERRAIN[ability];
    if (terrain) this.setTerrain(terrain, side, name, mon.ability);
    if (ability === 'intimidate') this.intimidate(side, name);

    const boost = ENTRY_BOOSTS[ability];
    if (boost && !mon.entryBoosted) { mon.entryBoosted = true; this.boostEntry(side, name, mon.ability, boost); }

    const foe = otherSide(side);
    const foes = aliveActive(this.st, foe).map((n) => this.st.mons[foe][n]!);
    if (ability === 'download' && foes.length) {
      const total = (k: 'def' | 'spd'): number => foes.reduce((s, f) => s + Math.floor(statsOf(f)[k] * boostMult(f.boosts[k])), 0);
      this.boostEntry(side, name, mon.ability, total('def') < total('spd') ? { atk: 1 } : { spa: 1 });
    }

    const allyName = aliveActive(this.st, side).find((n) => n !== name);
    const ally = allyName ? this.st.mons[side][allyName]! : null;
    if (ability === 'hospitality' && ally && allyName) {
      if (!this.heal(side, allyName, share(statsOf(ally).hp, 1 / 4).amount, `${mon.name}'s Hospitality`, 1 / 4)) {
        this.log.push({ type: 'effect', side, mon: name, source: mon.ability, text: `${allyName} is already at full HP` });
      }
    }
    if (ability === 'curiousmedicine' && ally && allyName && BOOST_KEYS.some((k) => ally.boosts[k] !== 0)) {
      for (const k of BOOST_KEYS) ally.boosts[k] = 0;
      this.log.push({ type: 'effect', side, mon: allyName, source: `${mon.name}'s ${mon.ability}`, text: 'stat changes removed' });
    }
    if (ability === 'costar' && ally && allyName && BOOST_KEYS.some((k) => ally.boosts[k] !== 0)) {
      mon.boosts = { ...ally.boosts };
      this.log.push({ type: 'boost', side, mon: name, move: mon.ability, changes: BOOST_KEYS.filter((k) => mon.boosts[k] !== 0).map((k) => ({ stat: k, delta: mon.boosts[k] })) });
    }
    if (ability === 'screencleaner') {
      for (const s of ['me', 'opp'] as const) this.st.field.screens[s] = { reflect: 0, light: 0, veil: 0 };
      this.log.push({ type: 'field', side, mon: name, move: mon.ability, text: 'removes Reflect, Light Screen and Aurora Veil' });
    }
    this.seed(side, name);
    this.boosterEnergy(side, name);
  }

  /** Booster Energy switches Protosynthesis / Quark Drive on when the sun or Electric Terrain doesn't (used up). */
  boosterEnergy(side: Side, name: string): void {
    const mon = this.mon(side, name);
    if (!mon || mon.fainted || mon.boosted || toID(this.item(mon)) !== 'boosterenergy') return;
    const ability = toID(mon.ability);
    const fieldOn = ability === 'protosynthesis' ? this.st.field.weather === 'Sun' : ability === 'quarkdrive' && this.st.field.terrain === 'Electric';
    if ((ability !== 'protosynthesis' && ability !== 'quarkdrive') || fieldOn) return;
    mon.boosted = bestStat(mon);
    this.loseItem(side, name, `switches on ${mon.ability} (${mon.boosted === 'spe' ? 'Speed ×1.5' : `${mon.boosted.toUpperCase()} ×1.3`})`);
  }

  /** Entry hazards on its side: Stealth Rock (by Rock effectiveness), Spikes, Toxic Spikes and Sticky Web for grounded Pokémon. */
  private hazards(side: Side, name: string): void {
    const mon = this.mon(side, name)!;
    const h = this.st.field.hazards[side];
    if (!h.rocks && !h.spikes && !h.tspikes && !h.web) return;
    if (toID(this.item(mon)) === 'heavydutyboots') return;
    const max = statsOf(mon).hp;
    const guard = this.indirectImmune(mon);
    if (h.rocks && !guard) {
      const fraction = this.engine.effectiveness('Rock', mon.species) / 8;
      if (fraction > 0) this.hurt(side, name, share(max, fraction).amount, 'Stealth Rock', fraction);
    }
    if (!this.grounded(mon) || mon.fainted) return;
    if (h.spikes && !guard) {
      const fraction = [0, 1 / 8, 1 / 6, 1 / 4][h.spikes] ?? 1 / 4;
      this.hurt(side, name, share(max, fraction).amount, 'Spikes', fraction);
    }
    if (h.tspikes && !mon.fainted) {
      const types = this.engine.typesOf(mon.species);
      if (types.includes('Poison')) { h.tspikes = 0; this.log.push({ type: 'effect', side, mon: name, source: 'Toxic Spikes', text: 'absorbed' }); }
      else {
        const got = this.inflict(side, name, null, h.tspikes > 1 ? 'tox' : 'psn');
        if (got.status) this.log.push({ type: 'effect', side, mon: name, source: 'Toxic Spikes', text: got.cured ? `${STATUS_LABEL[got.status]}, cured by ${got.cured}` : STATUS_LABEL[got.status] });
      }
    }
    if (h.web && !mon.fainted) this.boostEntry(side, name, 'Sticky Web', { spe: -1 }, { foe: true });
  }

  /** Imposter: transforms into the foe facing it as it comes in. */
  private imposter(side: Side, name: string): void {
    const foe = otherSide(side);
    const slot = this.st.active[side].indexOf(name);
    const facing = this.st.active[foe][slot] ?? aliveActive(this.st, foe)[0];
    const target = facing ? this.st.mons[foe][facing] : undefined;
    if (!target || target.fainted || !facing) return;
    this.transform(side, name, foe, facing, 'Imposter');
  }

  /** Becomes a copy of the target: species, ability, stats other than HP, stat stages. Undone when it switches out. */
  transform(side: Side, name: string, foe: Side, targetName: string, source: string): boolean {
    const mon = this.mon(side, name);
    const target = this.mon(foe, targetName);
    if (!mon || !target || target.transformedFrom || mon.transformedFrom || target.sub) return false;
    mon.transformedFrom = { species: mon.species, ability: mon.ability, stats: mon.stats ? { ...mon.stats } : null };
    const ownHp = statsOf(mon).hp;
    mon.species = target.species;
    mon.ability = target.ability;
    mon.stats = { ...statsOf(target), hp: ownHp };
    mon.boosts = { ...target.boosts };
    this.log.push({ type: 'effect', side, mon: name, source, text: `transforms into ${target.species}` });
    return true;
  }

  /** Trace copies a foe's ability as it comes in; with two foes it's random, so it only copies when they agree. */
  private trace(side: Side, name: string): void {
    const mon = this.mon(side, name)!;
    const foe = otherSide(side);
    const abilities = [...new Set(aliveActive(this.st, foe).map((n) => this.st.mons[foe][n]!.ability).filter((a) => !FIXED_ABILITIES.has(toID(a))))];
    if (abilities.length !== 1) {
      if (abilities.length > 1) this.log.push({ type: 'effect', side, mon: name, source: 'Trace', text: `copies ${abilities.join(' or ')} at random (not simulated)` });
      return;
    }
    mon.ability = abilities[0]!;
    this.log.push({ type: 'effect', side, mon: name, source: 'Trace', text: `copies ${mon.ability}` });
  }

  /** Intimidate: −1 Attack to each foe, with the abilities and items that answer it. */
  private intimidate(side: Side, name: string): void {
    const user = this.mon(side, name)!;
    const foe = otherSide(side);
    for (const foeName of aliveActive(this.st, foe)) {
      const target = this.st.mons[foe][foeName]!;
      const ability = toID(target.ability);
      const entry: Extract<LogEntry, { type: 'boost' }> = { type: 'boost', side: foe, mon: foeName, move: `${user.name}'s Intimidate`, changes: [] };
      this.log.push(entry);
      if (ability === 'guarddog') { entry.changes = this.changes(foe, foeName, { atk: 1 }, { own: true }); continue; }
      if (INTIMIDATE_IMMUNE.includes(ability)) { entry.move = `Intimidate (${target.ability})`; continue; }
      entry.changes = this.changes(foe, foeName, { atk: -1 }, { foe: true });
      if (ability === 'rattled') merge(entry.changes, this.changes(foe, foeName, { spe: 1 }, { own: true }));
      if (toID(this.item(target)) === 'adrenalineorb') {
        const orb = this.takeItem(foe, foeName);
        this.boostEntry(foe, foeName, orb, { spe: 1 });
      }
    }
  }

  /**
   * End of turn, in the games' order, each step fastest first: weather (Sandstorm damage, Rain Dish, Dry Skin...),
   * then Grassy Terrain and Leftovers / Black Sludge, then poison, then burn, then Speed Boost. A Pokémon that faints
   * in one step takes no part in the later ones (so it isn't healed back).
   */
  residuals(): void {
    const f = this.st.field;
    const step = (fn: (a: Active, max: number) => void): void => {
      for (const a of this.speedOrder()) if (!a.mon.fainted) fn(a, statsOf(a.mon).hp);
    };
    const hurt = (a: Active, max: number, fraction: number, text: string): void => this.hurt(a.side, a.name, share(max, fraction).amount, text, fraction);
    const heal = (a: Active, max: number, fraction: number, text: string): void => { this.heal(a.side, a.name, share(max, fraction).amount, text, fraction); };

    step((a, max) => {
      const { mon } = a;
      const ability = toID(mon.ability);
      const guard = this.indirectImmune(mon);
      if (f.weather === 'Sand') {
        const types = this.engine.typesOf(mon.species);
        if (!guard && !SAND_IMMUNE_TYPES.some((t) => types.includes(t)) && !SAND_IMMUNE.includes(ability) && !SAND_IMMUNE.includes(toID(this.item(mon)))) {
          hurt(a, max, 1 / 16, 'Sandstorm');
        }
      }
      if (f.weather === 'Rain' && ability === 'raindish') heal(a, max, 1 / 16, mon.ability);
      if (f.weather === 'Rain' && ability === 'dryskin') heal(a, max, 1 / 8, mon.ability);
      if (f.weather === 'Snow' && ability === 'icebody') heal(a, max, 1 / 16, mon.ability);
      if (f.weather === 'Sun' && (ability === 'dryskin' || ability === 'solarpower') && !guard) hurt(a, max, 1 / 8, mon.ability);
    });

    // Wish: whoever stands in the wished-for position.
    for (const side of ['me', 'opp'] as const) {
      f.wish[side] = f.wish[side].filter((w) => {
        if (--w.turns > 0) return true;
        const who = this.st.active[side][w.slot];
        if (who && !this.st.mons[side][who]!.fainted) this.heal(side, who, w.amount, 'Wish');
        return false;
      });
    }

    step((a, max) => {
      const { mon } = a;
      if (f.terrain === 'Grassy' && this.grounded(mon)) heal(a, max, 1 / 16, 'Grassy Terrain');
      const item = toID(this.item(mon));
      if (item === 'leftovers') heal(a, max, 1 / 16, mon.item);
      if (item === 'blacksludge') {
        if (this.engine.typesOf(mon.species).includes('Poison')) heal(a, max, 1 / 16, mon.item);
        else if (!this.indirectImmune(mon)) hurt(a, max, 1 / 8, mon.item);
      }
    });

    // Leech Seed: 1/8 drained to whoever stands where the seeder stood.
    step((a, max) => {
      const seed = a.mon.seeded;
      if (!seed || this.indirectImmune(a.mon)) return;
      const amount = Math.min(a.mon.hp, share(max, 1 / 8).amount);
      hurt(a, max, 1 / 8, 'Leech Seed');
      const to = this.st.active[seed.side][seed.slot];
      if (to) this.heal(seed.side, to, amount, 'Leech Seed');
    });

    step((a, max) => {
      const { mon } = a;
      if (mon.status !== 'psn' && mon.status !== 'tox') return;
      if (toID(mon.ability) === 'poisonheal') { heal(a, max, 1 / 8, 'Poison Heal'); return; }
      if (this.indirectImmune(mon)) return;
      // Bad poison grows by 1/16 each turn (1/16, 2/16, 3/16...).
      const fraction = mon.status === 'psn' ? 1 / 8 : Math.min(15, mon.toxic) / 16;
      if (mon.status === 'tox') mon.toxic++;
      hurt(a, max, fraction, 'poison');
    });

    step((a, max) => {
      if (a.mon.status !== 'brn' || this.indirectImmune(a.mon)) return;
      hurt(a, max, toID(a.mon.ability) === 'heatproof' ? 1 / 32 : 1 / 16, 'burn');
    });

    // Salt Cure: 1/8 a turn, 1/4 for Water and Steel types.
    step((a, max) => {
      if (!a.mon.saltCure || this.indirectImmune(a.mon)) return;
      const types = this.engine.typesOf(a.mon.species);
      hurt(a, max, types.includes('Water') || types.includes('Steel') ? 1 / 4 : 1 / 8, 'Salt Cure');
    });

    // Yawn: drowsy now, asleep at the end of the next turn.
    step(({ side, name, mon }) => {
      if (!mon.yawn || --mon.yawn > 0) return;
      const got = this.inflict(side, name, null, 'slp');
      this.log.push({ type: 'effect', side, mon: name, source: 'Yawn', text: got.status === 'slp' ? (got.cured ? `falls asleep, woken by ${got.cured}` : 'falls asleep') : `stays awake (${got.blocked ?? 'immune'})` });
    });

    // Perish Song: counts down, and faints at 0.
    step(({ side, name, mon }) => {
      if (mon.perish === null) return;
      mon.perish--;
      if (mon.perish > 0) { this.log.push({ type: 'effect', side, mon: name, source: 'Perish Song', text: `count ${mon.perish}` }); return; }
      mon.perish = null;
      this.hurt(side, name, mon.hp, 'Perish Song');
    });

    step(({ side, name, mon }) => {
      if (toID(mon.ability) === 'speedboost' && !this.st.turn.entered[monKey(side, name)]) this.boostEntry(side, name, mon.ability, { spe: 1 });
    });

    // Turn counters of Taunt, Encore and Disable.
    for (const side of ['me', 'opp'] as const) {
      for (const name of aliveActive(this.st, side)) {
        const mon = this.st.mons[side][name]!;
        if (mon.taunt > 0 && --mon.taunt === 0) this.log.push({ type: 'effect', side, mon: name, source: 'Taunt', text: 'wears off' });
        if (mon.encore && --mon.encore.turns <= 0) { mon.encore = null; this.log.push({ type: 'effect', side, mon: name, source: 'Encore', text: 'ends' }); }
        if (mon.disable && --mon.disable.turns <= 0) { mon.disable = null; this.log.push({ type: 'effect', side, mon: name, source: 'Disable', text: 'ends' }); }
      }
    }
  }
}
