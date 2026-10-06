import { round1, toID } from '../strings.ts';
import { BOOST_KEYS } from '../stats.ts';
import type { BoostKey, FlowNode, Side, TurnAction } from '../types.ts';
import { SIDES } from '../types.ts';
import type { FieldOptions } from './calc-types.ts';
import type { CalcEngine, MoveInfo } from './engine.ts';
import type { DebuffTarget, EndMon, HitResult, LogEntry, StatChange, StatusTarget, TurnResult } from './log.ts';
import type { BattleState, FieldState, MonState } from './state.ts';
import { aliveActive, applyBoost, bench, effSpeed, enterMon, monKey, newScratch, otherSide, outcomeOf, refreshStats, statsOf, zeroBoosts } from './state.ts';
import type { BoostChange, StatusId } from './tables.ts';
import {
  ALL_STATUS_IMMUNE, BREAKS_PROTECT, CURE_BERRIES, DEBUFF_MOVES, FIELD_MOVES, PIVOT_MOVES, POWDER_MOVES, PRIORITY_BLOCKERS, PROTECT_MOVES, SECONDARY_DROPS, SECONDARY_STATUS,
  SELF_DROPS, SETUP_MOVES, STAT_DROP_BLOCKERS, STATUS_ABILITY_IMMUNE, STATUS_LABEL, STATUS_MOVES, STATUS_TYPE_IMMUNE,
} from './tables.ts';

/** Outcome of trying to give a Pokémon a condition. */
interface Inflicted { status?: StatusId; blocked?: string; cured?: string }

/** The user can fix this by editing the turn (as opposed to a calculator problem). */
class Incomplete extends Error {
  override readonly name = 'Incomplete';
}

/** `priority` is the move's effective bracket this turn (base priority plus Prankster, Gale Wings, Grassy Glide...). */
interface Entry { action: TurnAction; index: number; mon: MonState; info: MoveInfo | null; priority: number }

const changesList = (table: BoostChange, apply: (stat: BoostKey, delta: number) => number): StatChange[] =>
  (Object.keys(table) as BoostKey[]).map((stat) => ({ stat, delta: apply(stat, table[stat] ?? 0) }));

/** Runs one turn against a battle state, mutating it. Split from {@link simulateTurn} so each rule lives in its own method. */
class TurnRunner {
  readonly log: LogEntry[] = [];
  /** The field after every action, before the end-of-turn countdown. */
  during: FieldState | null = null;
  private readonly engine: CalcEngine;
  private readonly st: BattleState;

  constructor(engine: CalcEngine, st: BattleState) {
    this.engine = engine;
    this.st = st;
  }

  private mon(side: Side, name: string): MonState {
    const m = this.st.mons[side][name];
    if (!m) throw new Incomplete(`${name} isn't on ${side === 'me' ? 'your' : "the opponent's"} team`);
    return m;
  }

  /** Effective priority of the move being executed (see {@link priorityOf}). */
  private priority = 0;
  /** Who stood in each position when the turn's moves began, so targets follow the slot after a switch. */
  private slots: Record<Side, string[]> = { me: [], opp: [] };
  /** Replacement switches already done by {@link replaceFainted}; they don't run again with the turn. */
  private readonly replaced = new Set<TurnAction>();

  /**
   * Fainted Pokémon are replaced before the turn starts (entry abilities trigger). The replacement is whichever
   * benched Pokémon the user gave an action to this turn; it takes the first free fainted slot and then acts normally.
   */
  replaceFainted(actions: readonly TurnAction[]): void {
    // Older plans spelled a replacement as a "switch" action for the fainted Pokémon.
    for (const a of actions) {
      if (a.kind !== 'switch' || !a.mon || !a.target) continue;
      const out = this.st.mons[a.side][a.mon];
      if (!out?.fainted || !this.st.active[a.side].includes(a.mon)) continue;
      this.doSwitch(a.side, a.mon, a.target, { replace: true });
      this.replaced.add(a);
    }
    for (const side of SIDES) {
      const fainted = this.st.active[side].filter((n) => this.st.mons[side][n]?.fainted);
      const comingIn = [...new Set(actions
        .filter((a) => a.side === side && a.mon && !this.replaced.has(a) && this.st.mons[side][a.mon] && !this.st.active[side].includes(a.mon))
        .map((a) => a.mon))];
      fainted.forEach((out, i) => { const inName = comingIn[i]; if (inName) this.doSwitch(side, out, inName, { replace: true }); });
    }
  }

  /** Reasons the turn can't run yet; empty when every active Pokémon has a complete action. */
  missingFor(actions: readonly TurnAction[]): string[] {
    const missing: string[] = [];
    for (const side of SIDES) {
      const free = bench(this.st, side).length;
      const fainted = this.st.active[side].filter((n) => this.st.mons[side][n]?.fainted);
      const left = bench(this.st, side).join(' or ');
      fainted.slice(0, free).forEach((n) => missing.push(`${n} fainted: add an action for its replacement (${left})`));
    }
    if (!actions.length) missing.push('Add an action for each active Pokémon');
    for (const a of actions) {
      if (!a.mon) { missing.push('Choose a Pokémon for every action'); continue; }
      if (!this.st.mons[a.side][a.mon]) { missing.push(`${a.mon} isn't on ${a.side === 'me' ? 'your' : "the opponent's"} team`); continue; }
      if (!this.st.party[a.side].includes(a.mon)) { missing.push(`${a.mon} wasn't brought to this battle (pick it as a lead or back)`); continue; }
      if (a.kind === 'switch') { if (!a.target) missing.push(`${a.mon}: choose who to switch to`); }
      else if (!a.move) missing.push(`${a.mon}: choose a move`);
    }
    for (const side of SIDES) {
      for (const name of aliveActive(this.st, side)) {
        if (!actions.some((a) => a.side === side && a.mon === name)) missing.push(`${name} needs an action`);
      }
    }
    return [...new Set(missing)];
  }

  run(actions: readonly TurnAction[]): void {
    this.st.turn = newScratch();
    this.slots = { me: [...this.st.active.me], opp: [...this.st.active.opp] };
    this.megaEvolve(actions);
    const entries: Entry[] = actions.filter((action) => !this.replaced.has(action)).map((action, index) => {
      const mon = this.mon(action.side, action.mon);
      statsOf(mon);
      const info = action.kind === 'switch' ? null : this.engine.moveInfo(action.move);
      return { action, index, mon, info, priority: info ? this.priorityOf(mon, info) : 0 };
    });
    entries.sort((x, y) => this.compare(x, y));
    for (const e of entries) { this.priority = e.priority; this.execute(e); }
    this.residuals();
    this.during = structuredClone(this.st.field);
    this.tickTimers();
  }

  /**
   * A move's priority this turn, fixed when moves are chosen: Prankster (+1 status moves), Gale Wings (+1 Flying
   * moves at full HP) and Grassy Glide (+1 in Grassy Terrain for a grounded user).
   */
  private priorityOf(mon: MonState, info: MoveInfo): number {
    const ability = toID(mon.ability);
    let priority = info.priority;
    if (ability === 'prankster' && info.category === 'Status') priority++;
    if (ability === 'galewings' && info.type === 'Flying' && mon.hp >= statsOf(mon).hp) priority++;
    if (toID(info.name) === 'grassyglide' && this.st.field.terrain === 'Grassy' && this.grounded(mon)) priority++;
    return priority;
  }

  /** Not Flying type, no Levitate, no Air Balloon: affected by terrain. */
  private grounded(mon: MonState): boolean {
    return !this.engine.typesOf(mon.species).includes('Flying') && toID(mon.ability) !== 'levitate' && toID(mon.set.item) !== 'airballoon';
  }

  /**
   * Why a priority move (priority above 0, including boosts like Prankster) can't affect this foe: Quick Guard on
   * its side, a priority-blocking ability on its side (Armor Tail, Queenly Majesty, Dazzling), or Psychic Terrain
   * protecting it while grounded. Null when nothing stops it, or for moves aimed at the user's own side.
   */
  private priorityBlock(attSide: Side, t: { side: Side; name: string }): string | null {
    if (this.priority <= 0 || t.side === attSide) return null;
    if (this.st.turn.quick[t.side]) return 'Quick Guard';
    const blocker = aliveActive(this.st, t.side).map((n) => this.st.mons[t.side][n]!).find((m) => PRIORITY_BLOCKERS.includes(toID(m.ability)));
    if (blocker) return `${blocker.name}'s ${blocker.ability}`;
    if (this.st.field.terrain === 'Psychic' && this.grounded(this.st.mons[t.side][t.name]!)) return 'Psychic Terrain';
    return null;
  }

  /** Switches first, then priority, then speed (reversed under Trick Room); ties keep the order they were entered. */
  private compare(x: Entry, y: Entry): number {
    const bracket = (e: Entry): number => (e.action.kind === 'switch' ? 1000 : e.priority);
    const trick = this.st.field.trick > 0 ? 1 : -1;
    const speed = effSpeed(this.st, x.action.side, x.mon) - effSpeed(this.st, y.action.side, y.mon);
    return bracket(y) - bracket(x) || trick * speed || x.index - y.index;
  }

  /**
   * Mega Evolution happens before any move. Only one Pokémon per side can Mega Evolve in a battle, and it needs its
   * Mega Stone. The Mega's ability takes over and triggers like on entry (e.g. Charizard-Mega-Y's Drought).
   */
  private megaEvolve(actions: readonly TurnAction[]): void {
    for (const a of actions) {
      if (a.kind !== 'mega') continue;
      const mon = this.mon(a.side, a.mon);
      if (mon.fainted || mon.mega || !this.st.active[a.side].includes(a.mon)) continue;
      if (!mon.megaForm) throw new Incomplete(`${a.mon} can't Mega Evolve (it isn't holding its Mega Stone)`);
      const used = this.st.megaUsed[a.side];
      if (used) throw new Incomplete(`${a.mon} can't Mega Evolve: ${used} already did in this branch (one per battle)`);
      mon.species = mon.megaForm;
      mon.ability = mon.megaAbility || this.engine.defaultAbility(mon.megaForm);
      mon.mega = true;
      this.st.megaUsed[a.side] = a.mon;
      refreshStats(this.engine, mon);
      this.log.push({ type: 'mega', side: a.side, mon: a.mon, species: mon.megaForm });
      enterMon(this.st, a.side, a.mon, this.log);
    }
  }

  private execute(e: Entry): void {
    const { action: a, mon: actor } = e;
    const side = a.side;
    if (actor.fainted) {
      const what = a.kind === 'switch' ? `switching to ${a.target}` : a.move;
      const pivotNote = a.kind !== 'switch' && a.pivot && PIVOT_MOVES[toID(a.move)] ? `, so ${a.pivot} doesn't come in` : '';
      this.log.push({ type: 'skip', side, mon: a.mon, why: what ? `fainted before ${a.kind === 'switch' ? '' : 'using '}${what}${pivotNote}` : 'has fainted' });
      return;
    }
    // e.g. it was pivoted out earlier this turn, or the action was planned for a Pokémon on the bench.
    if (!this.st.active[side].includes(a.mon)) { this.log.push({ type: 'skip', side, mon: a.mon, why: "isn't on the field" }); return; }
    if (this.st.turn.flinched[monKey(side, a.mon)]) { this.log.push({ type: 'skip', side, mon: a.mon, why: 'flinched' }); return; }
    if (a.kind === 'switch' || !e.info) { this.doSwitch(side, a.mon, a.target); return; }
    // Sleep lasts 1-3 turns; only the first is certain, so the Pokémon is assumed to wake on its next action.
    if (actor.status === 'slp') {
      if (actor.slept < 1) { actor.slept++; this.log.push({ type: 'skip', side, mon: a.mon, why: 'is asleep (may sleep up to 2 more turns)' }); return; }
      actor.status = null; actor.slept = 0;
      this.log.push({ type: 'cure', side, mon: a.mon, text: 'wakes up' });
    }

    const info = e.info;
    const id = toID(a.move);
    if (!info.exists) { this.log.push({ type: 'other', side, mon: a.mon, move: a.move, note: 'move not found in the calculator' }); return; }
    if (PROTECT_MOVES.has(id)) { this.st.turn.protect[monKey(side, a.mon)] = true; this.log.push({ type: 'protect', side, mon: a.mon, move: info.name, text: 'protects itself' }); return; }
    if (id === 'wideguard') { this.st.turn.wide[side] = true; this.log.push({ type: 'protect', side, mon: a.mon, move: info.name, text: 'guards its side from spread moves' }); return; }
    if (id === 'quickguard') { this.st.turn.quick[side] = true; this.log.push({ type: 'protect', side, mon: a.mon, move: info.name, text: 'guards its side from priority moves' }); return; }
    if (id === 'helpinghand') {
      const ally = aliveActive(this.st, side).find((n) => n !== a.mon);
      if (ally) this.st.turn.helped[monKey(side, ally)] = true;
      this.log.push({ type: 'protect', side, mon: a.mon, move: info.name, text: ally ? `boosts ${ally}` : 'fails (no ally)' });
      return;
    }
    if (info.category === 'Status') this.statusMove(side, a, actor, info, id);
    else this.damagingMove(side, a, actor, info, id);
  }

  private doSwitch(side: Side, outName: string, inName: string, opts: { replace?: true; passBoosts?: boolean; via?: string } = {}): void {
    const incoming = this.mon(side, inName);
    if (incoming.fainted) throw new Incomplete(`${inName} has fainted and can't switch in`);
    if (this.st.active[side].includes(inName)) throw new Incomplete(`${inName} is already on the field`);
    if (!this.st.party[side].includes(inName)) throw new Incomplete(`${inName} wasn't brought to this battle (pick it as a lead or back)`);
    statsOf(incoming);
    const outgoing = this.mon(side, outName);
    if (opts.passBoosts) incoming.boosts = { ...outgoing.boosts };
    outgoing.boosts = zeroBoosts();
    if (outgoing.status === 'tox') outgoing.toxic = 1;
    if (!outgoing.fainted && outgoing.status && toID(outgoing.ability) === 'naturalcure') {
      outgoing.status = null;
      this.log.push({ type: 'cure', side, mon: outName, text: 'is cured by Natural Cure' });
    }
    const slot = this.st.active[side].indexOf(outName);
    if (slot >= 0) this.st.active[side][slot] = inName; else this.st.active[side].push(inName);
    const entry: Extract<LogEntry, { type: 'switch' }> = { type: 'switch', side, mon: outName, in: inName };
    if (opts.replace) entry.replace = true;
    if (opts.via) entry.via = opts.via;
    this.log.push(entry);
    enterMon(this.st, side, inName, this.log);
  }

  /** Switches the user out after a pivot move. Nothing happens if nobody is left to come in. */
  private pivot(side: Side, a: TurnAction, moveName: string, opts: { passBoosts?: boolean; via?: string } = {}): void {
    if (this.mon(side, a.mon).fainted) return;
    const options = bench(this.st, side);
    if (!options.length) {
      if (opts.via) this.log.push({ type: 'other', side, mon: a.mon, move: opts.via, note: 'no one to switch to' });
      return;
    }
    if (!a.pivot) throw new Incomplete(`${a.mon}: choose who comes in after ${moveName}`);
    if (!options.includes(a.pivot)) throw new Incomplete(`${a.mon}: ${a.pivot} can't come in after ${moveName}`);
    this.doSwitch(side, a.mon, a.pivot, opts);
  }

  /**
   * Stat changes for a Pokémon, respecting Contrary (reverses every change) and drop-blocking abilities. Clear Body
   * and the like only stop drops caused by others, so `own` (e.g. Draco Meteor's drop on its user) skips them.
   */
  private changesFor(mon: MonState, table: Readonly<Record<string, BoostChange>>, id: string, secondary: boolean, own = false): StatChange[] {
    const ability = toID(mon.ability);
    const entry = table[id];
    if (!entry) return [];
    const out: StatChange[] = [];
    for (const stat of Object.keys(entry) as BoostKey[]) {
      let delta = entry[stat] ?? 0;
      if (delta < 0 && !own && (STAT_DROP_BLOCKERS.includes(ability) || (secondary && ability === 'shielddust'))) continue;
      if (ability === 'contrary') delta = -delta;
      out.push({ stat, delta: applyBoost(mon, stat, delta) });
    }
    return out;
  }

  private statusMove(side: Side, a: TurnAction, actor: MonState, info: MoveInfo, id: string): void {
    const foe = otherSide(side);
    const stats = statsOf(actor);

    if (id === 'bellydrum' || id === 'clangoroussoul') {
      const cost = Math.floor(stats.hp / (id === 'bellydrum' ? 2 : 3));
      if (actor.hp <= cost) { this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: 'fails (not enough HP)' }); return; }
      actor.hp -= cost;
      actor.hpLo = Math.max(0, actor.hpLo - cost);
      actor.hpHi = Math.max(0, actor.hpHi - cost);
      const table: BoostChange = id === 'bellydrum' ? { atk: 12 } : { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
      this.log.push({ type: 'boost', side, mon: a.mon, move: info.name, changes: changesList(table, (s, d) => applyBoost(actor, s, d)) });
      return;
    }

    const inflicts = STATUS_MOVES[id];
    if (inflicts) { this.statusInflictingMove(side, a, actor, info, id, inflicts); return; }

    const setup = SETUP_MOVES[id];
    if (setup) {
      const table: BoostChange = { ...setup };
      if (id === 'growth' && this.st.field.weather === 'Sun') { table.atk = 2; table.spa = 2; }
      this.log.push({ type: 'boost', side, mon: a.mon, move: info.name, changes: changesList(table, (s, d) => applyBoost(actor, s, d)) });
      return;
    }

    if (DEBUFF_MOVES[id]) {
      let names: string[] = [];
      if (info.target === 'allAdjacentFoes' || a.target === 'Both foes' || a.target === 'All') names = aliveActive(this.st, foe);
      else if (this.st.mons[foe][a.target]) { const name = this.foeInSlot(foe, a.target); names = name ? [name] : []; }
      else if (!a.target) throw new Incomplete(`${a.mon}: pick a target for ${info.name}`);
      const targets: DebuffTarget[] = names.map((n) => {
        if (this.st.turn.protect[monKey(foe, n)]) return { side: foe, mon: n, protected: true };
        const priorityBlock = this.priorityBlock(side, { side: foe, name: n });
        if (priorityBlock) return { side: foe, mon: n, blocked: priorityBlock };
        return { side: foe, mon: n, changes: this.changesFor(this.st.mons[foe][n]!, DEBUFF_MOVES, id, false) };
      });
      this.log.push({ type: 'debuff', side, mon: a.mon, move: info.name, targets });
      // Parting Shot switches out unless it was blocked.
      if (PIVOT_MOVES[id] && targets.some((t) => !t.protected && !t.blocked)) this.pivot(side, a, info.name);
      return;
    }

    const fm = FIELD_MOVES[id];
    if (fm) {
      const f = this.st.field;
      let text = '';
      if (fm.weather) {
        if (f.weather === fm.weather) text = 'fails (already active)'; else { f.weather = fm.weather; f.wTurns = 5; text = `${fm.weather} for 5 turns`; }
      } else if (fm.terrain) {
        if (f.terrain === fm.terrain) text = 'fails (already active)'; else { f.terrain = fm.terrain; f.tTurns = 5; text = `${fm.terrain} Terrain for 5 turns`; }
      } else if (fm.trick) {
        if (f.trick > 0) { f.trick = 0; text = 'Trick Room ends'; } else { f.trick = 5; text = 'Trick Room for 5 turns'; }
      } else if (fm.tailwind) {
        f.tailwind[side] = 4; text = 'Tailwind for 4 turns';
      } else if (fm.screen) {
        if (fm.screen === 'veil' && f.weather !== 'Snow') text = 'fails (needs Snow)';
        else { f.screens[side][fm.screen] = 5; text = 'up for 5 turns'; }
      }
      this.log.push({ type: 'field', side, mon: a.mon, move: info.name, text });
      if (PIVOT_MOVES[id]) this.pivot(side, a, info.name); // Chilly Reception
      return;
    }

    const pivot = PIVOT_MOVES[id];
    if (pivot) {
      if (id === 'shedtail') {
        const cost = Math.ceil(stats.hp / 2);
        if (actor.hp <= cost) { this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: 'fails (not enough HP)' }); return; }
        actor.hp -= cost;
        actor.hpLo = Math.max(0, actor.hpLo - cost);
        actor.hpHi = Math.max(0, actor.hpHi - cost);
      }
      this.pivot(side, a, info.name, { passBoosts: pivot.passBoosts === true, via: info.name });
      return;
    }

    this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: 'no effect is modeled' });
  }

  private statusInflictingMove(side: Side, a: TurnAction, actor: MonState, info: MoveInfo, id: string, status: StatusId): void {
    const attackerAbility = toID(actor.ability);
    const targets: StatusTarget[] = this.resolveTargets(side, a, info).map((t) => {
      const target = this.st.mons[t.side][t.name]!;
      const out: StatusTarget = { side: t.side, mon: t.name };
      const types = this.engine.typesOf(target.species);
      const ability = toID(target.ability);
      const foe = t.side !== side;
      const priorityBlock = this.priorityBlock(side, t);
      if (foe && this.st.turn.protect[monKey(t.side, t.name)]) out.protected = true;
      else if (priorityBlock) out.blocked = priorityBlock;
      else if (foe && (ability === 'goodasgold' || ability === 'magicbounce')) out.blocked = target.ability;
      else if (foe && attackerAbility === 'prankster' && types.includes('Dark')) out.blocked = 'Dark types ignore Prankster';
      else if (POWDER_MOVES.has(id) && (types.includes('Grass') || ability === 'overcoat' || toID(target.set.item) === 'safetygoggles')) out.blocked = 'immune to powder';
      else if (info.type === 'Electric' && types.includes('Ground')) out.blocked = 'Ground type';
      else Object.assign(out, this.inflict(actor, target, status));
      return out;
    });
    this.log.push({ type: 'status', side, mon: a.mon, move: info.name, targets });
  }

  /** Gives `target` a condition unless its type, ability, the terrain or an existing condition prevents it. */
  private inflict(actor: MonState, target: MonState, status: StatusId): Inflicted {
    if (target.fainted) return { blocked: 'fainted' };
    if (target.status) return { blocked: `already ${STATUS_LABEL[target.status]}` };
    const types = this.engine.typesOf(target.species);
    const ability = toID(target.ability);
    const corrosion = toID(actor.ability) === 'corrosion' && (status === 'psn' || status === 'tox');
    const immuneType = corrosion ? undefined : STATUS_TYPE_IMMUNE[status].find((t) => types.includes(t));
    if (immuneType) return { blocked: `${immuneType} type` };
    if (ALL_STATUS_IMMUNE.includes(ability) || STATUS_ABILITY_IMMUNE[status].includes(ability) || (ability === 'leafguard' && this.st.field.weather === 'Sun')) {
      return { blocked: target.ability };
    }
    const grounded = this.grounded(target);
    if (grounded && this.st.field.terrain === 'Misty') return { blocked: 'Misty Terrain' };
    if (grounded && this.st.field.terrain === 'Electric' && status === 'slp') return { blocked: 'Electric Terrain' };

    target.status = status;
    target.toxic = status === 'tox' ? 1 : 0;
    target.slept = 0;
    const berry = target.set.item;
    if (CURE_BERRIES[toID(berry)]?.includes(status)) {
      target.status = null;
      target.set = { ...target.set, item: '' };
      return { status, cured: berry };
    }
    return { status };
  }

  /** End-of-turn damage from burn and poison, fastest first. */
  private residuals(): void {
    const order = SIDES.flatMap((side) => aliveActive(this.st, side).map((name) => ({ side, name, mon: this.st.mons[side][name]! })))
      .sort((x, y) => effSpeed(this.st, y.side, y.mon) - effSpeed(this.st, x.side, x.mon));
    for (const { side, name, mon } of order) {
      const s = mon.status;
      const ability = toID(mon.ability);
      if (!s || s === 'par' || s === 'slp' || mon.fainted || ability === 'magicguard') continue;
      const max = statsOf(mon).hp;
      const poisoned = s === 'psn' || s === 'tox';
      if (poisoned && ability === 'poisonheal') {
        const heal = Math.min(max - mon.hp, Math.floor(max / 8));
        if (heal <= 0) continue;
        mon.hp += heal;
        mon.hpLo = Math.min(max, mon.hpLo + heal);
        mon.hpHi = Math.min(max, mon.hpHi + heal);
        this.log.push({ type: 'residual', side, mon: name, text: 'Poison Heal', pct: round1((heal / max) * 100), fainted: false });
        continue;
      }
      let dmg = s === 'brn' ? Math.floor(max / (ability === 'heatproof' ? 32 : 16)) : s === 'psn' ? Math.floor(max / 8) : Math.floor((max * Math.min(15, mon.toxic)) / 16);
      dmg = Math.max(1, dmg);
      if (s === 'tox') mon.toxic++;
      mon.hp = Math.max(0, mon.hp - dmg);
      mon.hpLo = Math.max(0, mon.hpLo - dmg);
      mon.hpHi = Math.max(0, mon.hpHi - dmg);
      if (mon.hp <= 0) mon.fainted = true;
      this.log.push({ type: 'residual', side, mon: name, text: s === 'brn' ? 'burn' : 'poison', pct: -round1((dmg / max) * 100), fainted: mon.fainted });
    }
  }

  private resolveTargets(side: Side, a: TurnAction, info: MoveInfo): { side: Side; name: string }[] {
    const foe = otherSide(side);
    const spread = info.target === 'allAdjacentFoes' || info.target === 'allAdjacent';
    if (spread || a.target === 'Both foes' || a.target === 'All') {
      const out = aliveActive(this.st, foe).map((name) => ({ side: foe, name }));
      if (info.target === 'allAdjacent') aliveActive(this.st, side).filter((n) => n !== a.mon).forEach((name) => out.push({ side, name }));
      return out;
    }
    let t: { side: Side; name: string } | null = null;
    if (a.target === 'Self') t = { side, name: a.mon };
    else if (a.target === 'Ally') {
      const ally = aliveActive(this.st, side).find((n) => n !== a.mon);
      if (ally) t = { side, name: ally };
    } else if (a.target && this.st.mons[foe][a.target]) t = { side: foe, name: a.target };
    else if (a.target && this.st.mons[side][a.target]) t = { side, name: a.target };
    if (!t) throw new Incomplete(`${a.mon}: pick a target for ${info.name}`);
    if (t.side === foe) {
      const name = this.foeInSlot(foe, t.name);
      return name ? [{ side: foe, name }] : [];
    }
    return [t];
  }

  /**
   * Moves aim at a position: if the chosen foe has switched out (e.g. U-turn) the move hits whoever took its place,
   * and if that Pokémon fainted it redirects to the other foe. Null when no foe is left.
   */
  private foeInSlot(foe: Side, name: string): string | null {
    const slot = this.slots[foe].indexOf(name);
    const current = slot >= 0 ? this.st.active[foe][slot] : name;
    if (current && this.st.active[foe].includes(current) && !this.st.mons[foe][current]?.fainted) return current;
    return aliveActive(this.st, foe)[0] ?? null;
  }

  private fieldOptions(attSide: Side, defSide: Side, gameType: 'Singles' | 'Doubles', helped: boolean): FieldOptions {
    const f = this.st.field;
    return {
      gameType,
      weather: f.weather ?? undefined,
      terrain: f.terrain ?? undefined,
      attackerSide: { isHelpingHand: helped, isTailwind: f.tailwind[attSide] > 0 },
      defenderSide: {
        isReflect: f.screens[defSide].reflect > 0, isLightScreen: f.screens[defSide].light > 0,
        isAuroraVeil: f.screens[defSide].veil > 0, isTailwind: f.tailwind[defSide] > 0,
      },
    };
  }

  private damagingMove(side: Side, a: TurnAction, actor: MonState, info: MoveInfo, id: string): void {
    const spread = info.target === 'allAdjacentFoes' || info.target === 'allAdjacent';
    const targets = this.resolveTargets(side, a, info);
    const gameType = spread && targets.length < 2 ? 'Singles' : 'Doubles'; // the 0.75 spread cut needs two targets
    const helped = this.st.turn.helped[monKey(side, a.mon)] === true;
    const results: HitResult[] = [];
    let anyHit = false;

    for (const t of targets) {
      const target = this.st.mons[t.side][t.name]!;
      const result: HitResult = { side: t.side, mon: t.name };
      const isSelf = t.side === side && t.name === a.mon;
      if (!isSelf) {
        const blocked = (this.st.turn.protect[monKey(t.side, t.name)] && !BREAKS_PROTECT.has(id))
          || (spread && t.side !== side && this.st.turn.wide[t.side]);
        if (blocked) { result.protected = true; results.push(result); continue; }
        const priorityBlock = this.priorityBlock(side, t);
        if (priorityBlock) { result.blockedBy = priorityBlock; results.push(result); continue; }
      }
      const rolls = this.engine.damage(actor, target, info.name, this.fieldOptions(side, t.side, gameType, helped));
      const min = Math.min(...rolls);
      const max = Math.max(...rolls);
      const avg = Math.round(rolls.reduce((s, x) => s + x, 0) / rolls.length);
      const maxHP = statsOf(target).hp;
      result.minPct = round1((min / maxHP) * 100);
      result.maxPct = round1((max / maxHP) * 100);
      if (max === 0) { result.immune = true; results.push(result); continue; }

      const before = target.hp;
      const kos = rolls.filter((x) => x >= before).length;
      if (kos) result.koChance = kos === rolls.length ? 100 : Math.max(1, Math.round((kos / rolls.length) * 100));
      target.hp = Math.max(0, target.hp - avg);
      target.hpLo = Math.max(0, target.hpLo - max);
      target.hpHi = Math.max(0, target.hpHi - min);
      if (target.hp <= 0) target.fainted = true;
      anyHit = true;

      const targetAbility = toID(target.ability);
      if (id === 'fakeout' && !target.fainted && !['innerfocus', 'shielddust'].includes(targetAbility)) this.st.turn.flinched[monKey(t.side, t.name)] = true;
      if (SECONDARY_DROPS[id] && !target.fainted) result.changes = this.changesFor(target, SECONDARY_DROPS, id, true);
      const secondary = SECONDARY_STATUS[id];
      if (secondary && !target.fainted && targetAbility !== 'shielddust' && toID(target.set.item) !== 'covertcloak') {
        const got = this.inflict(actor, target, secondary);
        if (got.status) { result.status = got.status; if (got.cured) result.cured = got.cured; }
      }
      results.push(result);
    }

    const entry: LogEntry = { type: 'hit', side, mon: a.mon, move: info.name, results };
    if (anyHit && SELF_DROPS[id]) entry.self = this.changesFor(actor, SELF_DROPS, id, false, true);
    this.log.push(entry);
    if (anyHit && PIVOT_MOVES[id]) this.pivot(side, a, info.name);
  }

  private tickTimers(): void {
    const f = this.st.field;
    if (f.weather && --f.wTurns <= 0) { f.weather = null; f.wTurns = 0; }
    if (f.terrain && --f.tTurns <= 0) { f.terrain = null; f.tTurns = 0; }
    if (f.trick > 0) f.trick--;
    for (const s of SIDES) {
      if (f.tailwind[s] > 0) f.tailwind[s]--;
      for (const k of Object.keys(f.screens[s]) as (keyof typeof f.screens.me)[]) if (f.screens[s][k] > 0) f.screens[s][k]--;
    }
  }

  /** Active Pokémon plus everyone who acted or was hit, with end-of-turn HP and stat stages. */
  snapshot(): EndMon[] {
    const seen: Record<Side, Set<string>> = { me: new Set(), opp: new Set() };
    for (const s of SIDES) this.st.active[s].forEach((n) => seen[s].add(n));
    for (const entry of this.log) {
      seen[entry.side].add(entry.mon);
      if (entry.type === 'switch') seen[entry.side].add(entry.in);
      if (entry.type === 'hit') entry.results.forEach((r) => seen[r.side].add(r.mon));
      if (entry.type === 'debuff' || entry.type === 'status') entry.targets.forEach((r) => seen[r.side].add(r.mon));
    }
    const end: EndMon[] = [];
    for (const s of SIDES) {
      for (const [name, m] of Object.entries(this.st.mons[s])) {
        if (!seen[s].has(name) || !m.stats) continue;
        const max = m.stats.hp;
        end.push({
          side: s, name, species: m.species, fainted: m.fainted,
          pct: m.fainted ? 0 : Math.max(1, Math.round((m.hp / max) * 100)),
          lo: Math.round((m.hpLo / max) * 100), hi: Math.round((m.hpHi / max) * 100),
          mayFaint: !m.fainted && m.hpLo === 0, mayLive: m.fainted && m.hpHi > 0,
          boosts: BOOST_KEYS.filter((k) => m.boosts[k] !== 0).map((k) => ({ stat: k, delta: m.boosts[k] })),
          condition: m.fainted ? null : m.status,
        });
      }
    }
    return end;
  }
}

/**
 * Simulates one turn on a *copy-safe* state (the caller passes a clone). Returns `incomplete` when the user still
 * has to fill something in, `error` for calculator problems.
 */
export function simulateTurn(engine: CalcEngine, st: BattleState, node: FlowNode, entry: LogEntry[]): TurnResult {
  const runner = new TurnRunner(engine, st);
  // Inherited from the parent turn; shown for turns that can't run yet.
  const start = structuredClone(st.field);
  try {
    runner.replaceFainted(node.actions);
    const missing = runner.missingFor(node.actions);
    if (missing.length) return { status: 'incomplete', missing, field: start };
    runner.run(node.actions);
    const end = runner.snapshot();
    st.turn = newScratch();
    return { status: 'ready', log: runner.log, entry, end, state: st, field: runner.during ?? start, outcome: outcomeOf(st) };
  } catch (e) {
    if (e instanceof Incomplete) return { status: 'incomplete', missing: [e.message], field: start };
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
