import { round1, toID } from '../strings.ts';
import { BOOST_KEYS } from '../stats.ts';
import type { BoostKey, FlowNode, Side, TurnAction } from '../types.ts';
import { SIDES } from '../types.ts';
import type { FieldOptions } from './calc-types.ts';
import type { Inflicted } from './effects.ts';
import { Effects, share } from './effects.ts';
import type { CalcEngine, HitCalc, MoveInfo } from './engine.ts';
import type { DebuffTarget, EndMon, HitResult, LogEntry, StatusTarget, TurnResult } from './log.ts';
import type { BattleState, FieldState, MonState } from './state.ts';
import { aliveActive, bench, effSpeed, heldItem, monKey, newScratch, noHazards, otherSide, outcomeOf, refreshStats, statsOf, zeroBoosts } from './state.ts';
import type { BoostChange, StatusId } from './tables.ts';
import {
  ABILITY_SETTERS, CLEARS_STATS, EJECT_ITEMS, EXIT_ABILITIES, FIXED_ABILITIES, GRAVITY_BANNED, HAZARD_ATTACKS, HAZARD_MOVES, HEAL_MOVES,
  MOLD_BREAKERS, NOT_REPEATABLE, ON_HIT_ABILITIES, ON_HIT_ITEMS, ON_KO_ABILITIES, ROOM_MOVES, SCREEN_BREAKERS, TEAM_HEAL_MOVES,
  ABSORB_ABILITIES, ALWAYS_FLINCH, CONFUSE_MOVES, FREEZE_MAX_TURNS, THAW_MOVES, BREAKS_PROTECT, CHARGE_MOVES, CONTACT_ABILITIES, CONTACT_ITEMS, CONTACT_PROTECT, 
  DEBUFF_MOVES, FIELD_MOVES, FIRST_TURN_ONLY, HITS_SEMI_INVULNERABLE, IGNORES_REDIRECT, ITEM_REMOVAL, ITEM_SWAP, NEEDS_TARGET_MOVE, PIVOT_MOVES,
  POWDER_MOVES, PRIORITY_BLOCKERS, PROTECT_FAMILY, PROTECT_MOVES, RECHARGE_MOVES, REDIRECT_MOVES, SECONDARY_DROPS, SECONDARY_STATUS, SELF_DROPS, SETUP_MOVES,
  STATUS_LABEL, STATUS_MOVES,
} from './tables.ts';

/**
 * Why a Pokémon on the field has no choice this turn: it charged a two-turn move last turn (it fires it now) or must
 * recharge after Hyper Beam and the like. Null when it picks its action freely.
 */
export function lockedAction(mon: MonState): string | null {
  if (mon.fainted) return null;
  if (mon.charging) return `Fires ${mon.charging.move}, charged last turn`;
  if (mon.recharging) return `Recharges after ${mon.recharging}`;
  return null;
}

/**
 * A move the Pokémon has to use (it can still switch out): Encore, or a Choice item it's locked by. Null when free.
 */
export function moveLock(st: BattleState, mon: MonState): { move: string; reason: string } | null {
  if (mon.fainted) return null;
  if (mon.encore) return { move: mon.encore.move, reason: `Encore (${mon.encore.turns} more turn${mon.encore.turns === 1 ? '' : 's'})` };
  const item = heldItem(st, mon);
  if (mon.choiceLock && /^choice /i.test(item)) return { move: mon.choiceLock, reason: item };
  return null;
}

/** Whether something could force this Pokémon out this turn (its item or ability, or a foe's Red Card), so it needs a "comes in" pick. */
export function mayBeForcedOut(st: BattleState, side: Side, mon: MonState): boolean {
  const item = toID(heldItem(st, mon));
  if (EJECT_ITEMS.has(item) && item !== 'redcard') return true;
  if (EXIT_ABILITIES.has(toID(mon.ability))) return true;
  const foe = otherSide(side);
  return aliveActive(st, foe).some((n) => toID(heldItem(st, st.mons[foe][n]!)) === 'redcard');
}

/** The user can fix this by editing the turn (as opposed to a calculator problem). */
class Incomplete extends Error {
  override readonly name = 'Incomplete';
}

/** `priority` is the move's effective bracket this turn (base priority plus Prankster, Gale Wings, Grassy Glide...). */
interface Entry { action: TurnAction; index: number; mon: MonState; info: MoveInfo | null; priority: number }

interface Target { side: Side; name: string }

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Moves that hit back for damage taken this turn: `category` limits it to physical or special hits. */
const COUNTER_MOVES: Readonly<Record<string, { category?: string; mult: number }>> = {
  counter: { category: 'Physical', mult: 2 }, mirrorcoat: { category: 'Special', mult: 2 }, metalburst: { mult: 1.5 }, comeuppance: { mult: 1.5 },
};

/** Beast Boost: the highest stat other than HP (stat stages don't count). */
const bestStatOf = (mon: MonState): BoostKey => {
  const stats = statsOf(mon);
  return (['atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((best, k) => (stats[k] > stats[best] ? k : best), 'atk' as BoostKey);
};
/** Hits every foe (or everyone): Wide Guard blocks it, and the damage is cut when it has two targets. */
const isSpread = (info: MoveInfo, a: TurnAction): boolean =>
  info.target === 'allAdjacentFoes' || info.target === 'allAdjacent' || a.target === 'Both foes' || a.target === 'All';

/**
 * Runs one turn against a battle state, mutating it. Split from {@link simulateTurn} so each rule lives in its own
 * method. This decides the order things happen in; damage comes from the calculator, which is handed each
 * Pokémon's current state (HP, item, ability, boosts, status) and the field, and what follows from it (HP changes,
 * items, stat changes) is applied through {@link Effects}.
 */
class TurnRunner {
  readonly log: LogEntry[] = [];
  /** The field after every action, before the end-of-turn countdown. */
  during: FieldState | null = null;
  private readonly engine: CalcEngine;
  private readonly st: BattleState;
  private readonly fx: Effects;

  constructor(engine: CalcEngine, st: BattleState) {
    this.engine = engine;
    this.st = st;
    this.fx = new Effects(engine, st, this.log);
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
  /** The order the Pokémon really acted in (`side:name`), when the turn records it (e.g. from a replay). */
  private observedOrder: string[] = [];
  /** Each Pokémon's action this turn, by {@link monKey} (what Sucker Punch and Upper Hand look at). */
  private readonly planned = new Map<string, Entry>();
  /** Whether the Pokémon now acting had its previous action fail (Stomping Tantrum, Temper Flare). */
  private failedBefore = false;
  /** The field positions in the order they acted this turn. */
  private readonly acted: { side: Side; slot: number }[] = [];

  /** When each position acted, credited to whoever stands there at the end of the turn (see TurnResult). */
  actionOrder(): Record<string, number> {
    const order: Record<string, number> = {};
    this.acted.forEach(({ side, slot }, i) => {
      const name = this.st.active[side][slot];
      if (name) order[monKey(side, name)] = i + 1;
    });
    return order;
  }

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
      // A charged two-turn move is released, or a recharge spent, whatever is picked.
      if (lockedAction(this.st.mons[a.side][a.mon]!) && this.st.active[a.side].includes(a.mon)) continue;
      if (a.kind === 'switch') { if (!a.target) missing.push(`${a.mon}: choose who to switch to`); }
      else if (!a.move && !a.outcome?.unknown) missing.push(`${a.mon}: choose a move`);
    }
    for (const side of SIDES) {
      for (const name of aliveActive(this.st, side)) {
        if (!actions.some((a) => a.side === side && a.mon === name)) missing.push(`${name} needs an action`);
      }
    }
    return [...new Set(missing)];
  }

  /** Switches first, then Mega Evolution, then moves by priority and Speed, then the end-of-turn effects. */
  run(actions: readonly TurnAction[], node?: FlowNode): void {
    this.observedOrder = node?.order ?? [];
    this.st.turn = newScratch();
    this.slots = { me: [...this.st.active.me], opp: [...this.st.active.opp] };
    const entries: Entry[] = actions.filter((planned) => !this.replaced.has(planned)).map((planned, index) => {
      const mon = this.mon(planned.side, planned.mon);
      statsOf(mon);
      // A Pokémon that charged a two-turn move last turn is locked into releasing it; one that used Hyper Beam recharges.
      const locked = !mon.fainted && this.st.active[planned.side].includes(planned.mon);
      const charge = locked ? mon.charging : null;
      const recharge = locked && !charge && mon.recharging !== null;
      const lock = locked && !charge && !recharge && planned.kind !== 'switch' ? moveLock(this.st, mon) : null;
      const action: TurnAction = charge ? { ...planned, kind: 'move', move: charge.move, target: charge.target }
        : recharge ? { ...planned, kind: 'move', move: '', target: '' }
        : lock && toID(lock.move) !== toID(planned.move) ? { ...planned, move: lock.move, target: planned.target || mon.lastTarget } : planned;
      const info = action.kind === 'switch' || recharge ? null : this.engine.moveInfo(action.move);
      return { action, index, mon, info, priority: 0 };
    });
    for (const e of entries) this.planned.set(monKey(e.action.side, e.action.mon), e);
    const switches = entries.filter((e) => e.action.kind === 'switch').sort((x, y) => this.compare(x, y));
    for (const e of switches) { this.execute(e); this.forcedSwitches(); }
    this.megaEvolve(entries.map((e) => e.action));
    this.forcedSwitches();
    // Priority is fixed when moves are chosen; Speed is read again before every action, as in Scarlet/Violet and
    // Champions, so a Tailwind, Trick Room, paralysis or Speed drop changes the order of the actions still to come.
    const queue = entries.filter((e) => e.action.kind !== 'switch');
    for (const e of queue) if (e.info) e.priority = this.priorityOf(e.mon, e.info);
    while (queue.length) {
      queue.sort((x, y) => this.compare(x, y));
      const e = queue.shift()!;
      this.priority = e.priority;
      this.execute(e);
      this.forcedSwitches();
    }
    this.fx.residuals();
    this.forcedSwitches();
    if (node?.hpEnd) this.pinEndHp(node.hpEnd);
    for (const side of SIDES) {
      for (const name of aliveActive(this.st, side)) {
        const m = this.st.mons[side][name]!;
        m.activeTurns++;
        // A charge that wasn't released this turn (it flinched, fell asleep...) is lost; one started this turn carries on.
        if (m.charging && !this.st.turn.charged[monKey(side, name)]) m.charging = null;
      }
    }
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
    if (toID(info.name) === 'grassyglide' && this.st.field.terrain === 'Grassy' && this.fx.grounded(mon)) priority++;
    return priority;
  }

  /**
   * Why a priority move (priority above 0, including boosts like Prankster) can't affect this foe: Quick Guard on
   * its side, a priority-blocking ability on its side (Armor Tail, Queenly Majesty, Dazzling), or Psychic Terrain
   * protecting it while grounded. Null when nothing stops it, or for moves aimed at the user's own side.
   */
  private priorityBlock(attSide: Side, t: Target): string | null {
    if (this.priority <= 0 || t.side === attSide) return null;
    if (this.st.turn.quick[t.side]) return 'Quick Guard';
    const blocker = aliveActive(this.st, t.side).map((n) => this.st.mons[t.side][n]!).find((m) => PRIORITY_BLOCKERS.includes(toID(m.ability)));
    if (blocker) return `${blocker.name}'s ${blocker.ability}`;
    if (this.st.field.terrain === 'Psychic' && this.fx.grounded(this.st.mons[t.side][t.name]!)) return 'Psychic Terrain';
    return null;
  }

  /** Switches first, then priority, then speed (reversed under Trick Room); ties keep the order they were entered. */
  private compare(x: Entry, y: Entry): number {
    const bracket = (e: Entry): number => (e.action.kind === 'switch' ? 1000 : e.priority);
    // After You: acts next, whatever its priority. Quash: acts last.
    const moved = (e: Entry): number => {
      const key = monKey(e.action.side, e.action.mon);
      return this.st.turn.next[key] ? 1 : this.st.turn.last[key] ? -1 : 0;
    };
    // The order the turn recorded (a replay) wins over everything else for the Pokémon it lists.
    const seen = (e: Entry): number => this.observedOrder.indexOf(monKey(e.action.side, e.action.mon));
    if (seen(x) >= 0 && seen(y) >= 0) return seen(x) - seen(y);
    const trick = this.st.field.trick > 0 ? 1 : -1;
    const speed = effSpeed(this.st, x.action.side, x.mon) - effSpeed(this.st, y.action.side, y.mon);
    return moved(y) - moved(x) || bracket(y) - bracket(x) || trick * speed || x.index - y.index;
  }

  /**
   * Mega Evolution happens after switches and before any move, fastest first (slowest first under Trick Room), so
   * when two Megas set weather the slower one's stays. Only one Pokémon per side can Mega Evolve in a battle, and it
   * needs its Mega Stone. The Mega's ability takes over and triggers like on entry (e.g. Charizard-Mega-Y's Drought
   * replacing the rain a Pelipper brought in when it switched in, however fast the Pelipper is).
   */
  private megaEvolve(actions: readonly TurnAction[]): void {
    const trick = this.st.field.trick > 0 ? -1 : 1;
    const megas = actions.filter((a) => a.kind === 'mega' && !this.replaced.has(a)).map((a) => ({ a, mon: this.mon(a.side, a.mon) }))
      .filter(({ a, mon }) => !mon.fainted && !mon.mega && this.st.active[a.side].includes(a.mon))
      .sort((x, y) => trick * (effSpeed(this.st, y.a.side, y.mon) - effSpeed(this.st, x.a.side, x.mon)));
    for (const { a, mon } of megas) {
      if (!mon.megaForm) throw new Incomplete(`${a.mon} can't Mega Evolve (it isn't holding its Mega Stone)`);
      const used = this.st.megaUsed[a.side];
      if (used) throw new Incomplete(`${a.mon} can't Mega Evolve: ${used} already did in this branch (one per battle)`);
      mon.species = mon.megaForm;
      mon.ability = mon.megaAbility || this.engine.defaultAbility(mon.megaForm);
      mon.mega = true;
      this.st.megaUsed[a.side] = a.mon;
      refreshStats(this.engine, mon);
      this.log.push({ type: 'mega', side: a.side, mon: a.mon, species: mon.megaForm });
      this.fx.enter(a.side, a.mon, true);
    }
  }

  /**
   * Switches forced by Eject Button, Eject Pack, Red Card or Emergency Exit, carried out after the action that caused
   * them, into the Pokémon picked on the forced Pokémon's own action ("If forced out, switch to").
   */
  private forcedSwitches(): void {
    for (const f of this.st.turn.forced.splice(0)) {
      const mon = this.st.mons[f.side][f.name];
      if (!mon || mon.fainted || !this.st.active[f.side].includes(f.name)) continue;
      const options = bench(this.st, f.side);
      if (!options.length) continue;
      const to = this.planned.get(monKey(f.side, f.name))?.action.pivot;
      if (!to) throw new Incomplete(`${f.name}: ${f.reason} forces it out; choose who comes in on its action`);
      if (!options.includes(to)) throw new Incomplete(`${f.name}: ${to} can't come in after ${f.reason}`);
      this.doSwitch(f.side, f.name, to, { via: f.reason });
    }
  }

  private execute(e: Entry, instructed = false): void {
    const { action: a, mon: actor } = e;
    const side = a.side;
    this.st.turn.acted[monKey(side, a.mon)] = true;
    const wasProtecting = actor.protectStreak;
    this.failedBefore = actor.lastFailed;
    actor.protectStreak = false;
    actor.lastFailed = false;
    if (actor.fainted) {
      const what = a.kind === 'switch' ? `switching to ${a.target}` : a.move;
      const pivotNote = a.kind !== 'switch' && a.pivot && PIVOT_MOVES[toID(a.move)] ? `, so ${a.pivot} doesn't come in` : '';
      this.log.push({ type: 'skip', side, mon: a.mon, why: what ? `fainted before ${a.kind === 'switch' ? '' : 'using '}${what}${pivotNote}` : 'has fainted' });
      return;
    }
    // e.g. it was pivoted out earlier this turn, or the action was planned for a Pokémon on the bench.
    if (!this.st.active[side].includes(a.mon)) { this.log.push({ type: 'skip', side, mon: a.mon, why: "isn't on the field" }); return; }
    if (!instructed) this.acted.push({ side, slot: this.st.active[side].indexOf(a.mon) });
    actor.destinyBond = false;
    if (actor.recharging) {
      this.log.push({ type: 'skip', side, mon: a.mon, why: `must recharge after ${actor.recharging}` });
      actor.recharging = null;
      return;
    }
    if (a.kind === 'switch' || !e.info) { this.doSwitch(side, a.mon, a.target); return; }
    if (!this.beforeMove(side, a, actor, e.info)) return;

    const info = e.info;
    const id = toID(a.move);
    if (!a.move && a.outcome?.unknown) { this.log.push({ type: 'skip', side, mon: a.mon, why: "its move isn't known (not shown in the replay)" }); return; }
    if (!info.exists) { this.log.push({ type: 'other', side, mon: a.mon, move: a.move, note: 'move not found in the calculator' }); return; }
    const fail = PROTECT_FAMILY.has(id) && wasProtecting && !a.outcome?.protectWorks
      ? 'used right after another protecting move: it only works 1 time in 3'
      : this.failReason(side, a, actor, info, id);
    if (fail) {
      actor.lastFailed = true;
      this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: `fails (${fail})` });
      return;
    }
    actor.protectStreak = PROTECT_FAMILY.has(id);
    actor.lastMove = info.name;
    actor.lastTarget = a.target;
    if (/^choice /i.test(heldItem(this.st, actor)) && !actor.choiceLock) actor.choiceLock = info.name;
    if (PROTECT_MOVES.has(id)) { this.st.turn.protect[monKey(side, a.mon)] = id; this.log.push({ type: 'protect', side, mon: a.mon, move: info.name, text: 'protects itself' }); return; }
    if (id === 'wideguard') { this.st.turn.wide[side] = true; this.log.push({ type: 'protect', side, mon: a.mon, move: info.name, text: 'guards its side from spread moves' }); return; }
    if (id === 'quickguard') { this.st.turn.quick[side] = true; this.log.push({ type: 'protect', side, mon: a.mon, move: info.name, text: 'guards its side from priority moves' }); return; }
    if (id === 'helpinghand') {
      const ally = aliveActive(this.st, side).find((n) => n !== a.mon);
      if (ally) this.st.turn.helped[monKey(side, ally)] = true;
      this.log.push({ type: 'protect', side, mon: a.mon, move: info.name, text: ally ? `boosts ${ally}` : 'fails (no ally)' });
      return;
    }
    const redirect = REDIRECT_MOVES[id];
    if (redirect) {
      this.st.turn.redirect[side] = { name: a.mon, powder: redirect.powder === true };
      this.log.push({ type: 'protect', side, mon: a.mon, move: info.name, text: `draws the opponents' moves${redirect.powder ? ' (not from Grass types)' : ''}` });
      return;
    }
    if (info.category === 'Status') this.statusMove(side, a, actor, info, id);
    else this.damagingMove(side, a, actor, info, id);
  }

  /**
   * What can stop a Pokémon before its move, in the games' order: sleep, freeze, flinch, confusion, full paralysis.
   * Chance decides most of these; the turn's outcome says what happened, and without one the usual assumption holds
   * (wakes on its second action, stays frozen, doesn't hit itself, isn't fully paralysed). False when it can't move.
   */
  private beforeMove(side: Side, a: TurnAction, actor: MonState, info: MoveInfo): boolean {
    const o = a.outcome;
    const skip = (why: string): false => { this.log.push({ type: 'skip', side, mon: a.mon, why }); return false; };
    if (actor.status === 'slp') {
      // Sleep lasts 1-3 turns; without an outcome it's assumed to wake on its second action (Rest: its third).
      const stays = o?.cant === 'slp' || (!o?.wake && actor.slept < 1);
      if (stays && actor.slept < 3) {
        actor.slept++;
        return skip(actor.slept <= 0 ? 'is asleep (Rest: one more turn)' : o?.cant === 'slp' ? 'is still asleep' : 'is asleep (may sleep up to 2 more turns)');
      }
      actor.status = null; actor.slept = 0;
      this.log.push({ type: 'cure', side, mon: a.mon, text: 'wakes up' });
    }
    // Freeze (Champions): a 25% chance to thaw on each of its first two turns frozen, and it always thaws on the
    // third. Without an outcome it's assumed to stay frozen (the likelier result) until then. Moves like Scald and
    // Flare Blitz thaw their user first.
    if (actor.status === 'frz') {
      actor.frozen++;
      const thawMove = THAW_MOVES.has(toID(info.name));
      if (o?.wake || thawMove || actor.frozen >= FREEZE_MAX_TURNS) {
        actor.status = null;
        actor.frozen = 0;
        const why = o?.wake ? '' : thawMove ? ` (${info.name} thaws it)` : ' (third turn frozen: it always thaws)';
        this.log.push({ type: 'cure', side, mon: a.mon, text: `thaws out${why}` });
      } else {
        const left = FREEZE_MAX_TURNS - actor.frozen;
        return skip(`is frozen solid (25% chance to thaw each turn; thaws for sure ${left === 1 ? 'next turn' : `in ${left} turns`})`);
      }
    }
    if (this.st.turn.flinched[monKey(side, a.mon)] || o?.cant === 'flinch') return skip('flinched');
    if (actor.confused > 0) {
      actor.confused--;
      if (o?.wake || actor.confused === 0) {
        actor.confused = 0;
        this.log.push({ type: 'cure', side, mon: a.mon, text: 'snaps out of its confusion' });
      } else if (o?.cant === 'confusion') {
        this.log.push({ type: 'skip', side, mon: a.mon, why: 'hurt itself in its confusion' });
        this.fx.confusionHit(side, a.mon, o.targets?.[a.mon]?.hp);
        return false;
      }
    }
    if (actor.status === 'par' && o?.cant === 'par') return skip('is fully paralysed');
    return true;
  }

  /** End-of-turn HP the turn recorded (a replay's percentages): the battle goes on from there. */
  private pinEndHp(hpEnd: Record<string, number>): void {
    for (const [key, pct] of Object.entries(hpEnd)) {
      const [side, name] = key.split(':') as [Side, string];
      const mon = this.st.mons[side]?.[name];
      if (!mon?.stats) continue;
      const hp = pct > 0 ? Math.max(1, Math.round((pct * mon.stats.hp) / 100)) : 0;
      mon.hp = mon.hpLo = mon.hpHi = hp;
      mon.fainted = hp <= 0;
      mon.actual = pct;
    }
  }

  /**
   * Why a move fails before doing anything, given the battle as it stands: Fake Out after the user's first turn out,
   * Sucker Punch / Thunderclap when the target isn't attacking (or has already moved), Upper Hand when it isn't
   * using a priority move, Poltergeist on a target with no item, Dream Eater on one that's awake, Focus Punch after
   * being hit, Steel Roller with no terrain... Null when nothing stops it.
   */
  private failReason(side: Side, a: TurnAction, actor: MonState, info: MoveInfo, id: string): string | null {
    if (FIRST_TURN_ONLY.has(id) && actor.activeTurns > 0) return 'only works on its first turn out';
    if (actor.taunt > 0 && info.category === 'Status') return "it's taunted (attacks only)";
    if (info.category === 'Status' && toID(heldItem(this.st, actor)) === 'assaultvest') return 'Assault Vest allows attacks only';
    if (actor.disable && toID(actor.disable.move) === id) return 'the move is disabled';
    if (this.st.field.gravity > 0 && GRAVITY_BANNED.has(id)) return "it can't be used under Gravity";
    const foeSide = otherSide(side);
    const imprisoner = aliveActive(this.st, foeSide).map((n) => this.st.mons[foeSide][n]!).find((m) => m.imprison && m.set.moves.some((x) => toID(x) === id));
    if (imprisoner) return `${imprisoner.name} imprisoned it`;
    if (id === 'destinybond' && toID(actor.lastMove) === 'destinybond' && !this.failedBefore) return "can't be used twice in a row";
    if ((id === 'afteryou' || id === 'quash' || id === 'instruct') && !this.repeatOrMoveTarget(side, a, info, actor, id)) return 'nothing to do';
    if ((id === 'snore' || id === 'sleeptalk') && actor.status !== 'slp') return "it isn't asleep";
    if (id === 'fling' && !actor.item) return 'no item to fling';
    if (id === 'steelroller' && !this.st.field.terrain) return 'no terrain';
    if (id === 'burnup' && !this.engine.typesOf(actor.species).includes('Fire')) return "it isn't Fire type";
    if (id === 'focuspunch' && (this.st.turn.hitBy[monKey(side, a.mon)]?.length ?? 0) > 0) return 'it lost its focus (hit first)';
    if (id === 'beatup' && !this.beatUpCrew(side).length) return 'no Pokémon able to join in';
    const needs = NEEDS_TARGET_MOVE[id];
    if (!needs && id !== 'poltergeist' && id !== 'dreameater') return null;
    const t = this.resolveTargets(side, a, info, actor)[0];
    const target = t ? this.st.mons[t.side][t.name] : undefined;
    if (!t || !target) return null;
    if (id === 'poltergeist' && !target.item) return `${t.name} holds no item`;
    if (id === 'dreameater' && target.status !== 'slp') return `${t.name} isn't asleep`;
    if (needs) {
      const key = monKey(t.side, t.name);
      if (this.st.turn.acted[key]) return `${t.name} has already moved`;
      const plan = this.planned.get(key);
      const ok = !!plan?.info && plan.action.kind !== 'switch' && (needs === 'attack' ? plan.info.category !== 'Status' : plan.priority > 0);
      if (!ok) return needs === 'attack' ? `${t.name} isn't attacking` : `${t.name} isn't using a priority move`;
    }
    return null;
  }

  /** Feint and the like lift the target's Protect, and Wide Guard / Quick Guard on its side, for the rest of the turn. */
  private breakProtection(t: Target, source: string): void {
    const key = monKey(t.side, t.name);
    const broken: string[] = [];
    if (this.st.turn.protect[key]) { delete this.st.turn.protect[key]; broken.push('its protection'); }
    if (this.st.turn.wide[t.side]) { this.st.turn.wide[t.side] = false; broken.push('Wide Guard'); }
    if (this.st.turn.quick[t.side]) { this.st.turn.quick[t.side] = false; broken.push('Quick Guard'); }
    if (broken.length) this.log.push({ type: 'effect', side: t.side, mon: t.name, source, text: `breaks ${broken.join(' and ')}` });
  }

  /** Beat Up's hitters: every Pokémon its side brought that hasn't fainted and has no condition, the user included. */
  private beatUpCrew(side: Side): MonState[] {
    return this.st.party[side].map((n) => this.st.mons[side][n]).filter((m): m is MonState => !!m && !m.fainted && !m.status);
  }

  /**
   * The calculator's damage for one target. Beat Up (power 0 in the calculator) is worked out hit by hit: one per
   * member of the crew, each with 5 + that Pokémon's base Attack / 10 power, added up.
   */
  private attack(side: Side, actor: MonState, target: MonState, info: MoveInfo, id: string, field: FieldOptions, opts: { basePower?: number; alliesFainted?: number }): { hit: HitCalc; hits: number } {
    if (id !== 'beatup') return { hit: this.engine.damage(actor, target, info.name, field, opts), hits: info.hits };
    const parts = this.beatUpCrew(side).map((m) => this.engine.damage(actor, target, info.name, field, { ...opts, basePower: 5 + Math.floor((this.engine.baseStats(m.species)?.atk ?? 0) / 10) }));
    const first = parts[0];
    if (!first) return { hit: { rolls: [0], attackerItem: '', defenderItem: '', recoil: 0, drain: 0 }, hits: 0 };
    const rolls = first.rolls.map((_, i) => parts.reduce((s, p) => s + (p.rolls[i] ?? p.rolls[p.rolls.length - 1] ?? 0), 0));
    return { hit: { ...first, rolls, recoil: 0, drain: 0 }, hits: parts.length };
  }

  /** Fainted Pokémon among those its side brought, other than `name` (Last Respects, Supreme Overlord). */
  private faintedAllies(side: Side, name: string): number {
    return this.st.party[side].filter((n) => n !== name && this.st.mons[side][n]?.fainted).length;
  }

  /**
   * Power that depends on the battle so far, which the calculator can't see: Last Respects (fainted allies), Rage
   * Fist (hits taken), Stomping Tantrum / Temper Flare (last move failed), Avalanche / Revenge (hit by the target
   * this turn), Assurance (target already hit this turn), Payback / Bolt Beak / Fishious Rend (who really moved
   * first). `send` is what the calculator gets, `shown` the move's actual power. Null to leave it to the calculator.
   */
  private powerFor(side: Side, user: string, actor: MonState, info: MoveInfo, id: string, t: Target, target: MonState): { send: number; shown: number } | null {
    const bp = info.bp;
    const same = (p: number): { send: number; shown: number } => ({ send: p, shown: p });
    const targetKey = monKey(t.side, t.name);
    switch (id) {
      case 'lastrespects': return same(50 + 50 * this.faintedAllies(side, user));
      case 'ragefist': return same(Math.min(350, 50 + 50 * actor.timesHit));
      case 'stompingtantrum': case 'temperflare': return same(this.failedBefore ? bp * 2 : bp);
      case 'avalanche': case 'revenge': return same((this.st.turn.hitBy[monKey(side, user)] ?? []).includes(targetKey) ? bp * 2 : bp);
      case 'assurance': return same((this.st.turn.hitBy[targetKey]?.length ?? 0) > 0 ? bp * 2 : bp);
      case 'payback': case 'boltbeak': case 'fishiousrend': {
        const targetMoved = this.st.turn.acted[targetKey] === true;
        const shown = (id === 'payback' ? targetMoved : !targetMoved) ? bp * 2 : bp;
        // The calculator guesses the order from Speed alone and doubles by itself; undo its guess.
        const calcFirst = statsOf(actor).spe > statsOf(target).spe;
        const calcDoubles = id === 'payback' ? !calcFirst : calcFirst;
        return { send: calcDoubles ? shown / 2 : shown, shown };
      }
      default: return null;
    }
  }

  private doSwitch(side: Side, outName: string, inName: string, opts: { replace?: true; passBoosts?: boolean; via?: string; sub?: number } = {}): void {
    const incoming = this.mon(side, inName);
    if (incoming.fainted) throw new Incomplete(`${inName} has fainted and can't switch in`);
    if (this.st.active[side].includes(inName)) throw new Incomplete(`${inName} is already on the field`);
    if (!this.st.party[side].includes(inName)) throw new Incomplete(`${inName} wasn't brought to this battle (pick it as a lead or back)`);
    statsOf(incoming);
    const outgoing = this.mon(side, outName);
    if (opts.passBoosts) { incoming.boosts = { ...outgoing.boosts }; incoming.sub = outgoing.sub; incoming.seeded = outgoing.seeded; incoming.perish = outgoing.perish; }
    if (opts.sub) incoming.sub = opts.sub;
    // Stat stages, Unburden and every volatile effect end on switching out; the condition, HP and a lost item stay.
    outgoing.boosts = zeroBoosts();
    outgoing.unburden = false;
    outgoing.charging = null;
    outgoing.protectStreak = false;
    Object.assign(outgoing, {
      choiceLock: null, encore: null, disable: null, taunt: 0, imprison: false, sub: 0, yawn: 0, perish: null, seeded: null, saltCure: false,
      destinyBond: false, boosted: null, charge: false, flashFire: false, confused: 0,
    });
    if (outgoing.transformedFrom) {
      const back = outgoing.transformedFrom;
      outgoing.species = back.species; outgoing.ability = back.ability; outgoing.stats = back.stats; outgoing.transformedFrom = null;
    }
    incoming.activeTurns = 0;
    if (outgoing.status === 'tox') outgoing.toxic = 1;
    if (!outgoing.fainted && outgoing.status && toID(outgoing.ability) === 'naturalcure') {
      outgoing.status = null;
      this.log.push({ type: 'cure', side, mon: outName, text: 'is cured by Natural Cure' });
    }
    outgoing.recharging = null;
    if (!outgoing.fainted && toID(outgoing.ability) === 'regenerator') {
      const max = statsOf(outgoing).hp;
      const heal = Math.min(max - outgoing.hp, Math.floor(max / 3));
      if (heal > 0) {
        outgoing.hp += heal;
        outgoing.hpLo = outgoing.hpLo > 0 ? Math.min(max, outgoing.hpLo + heal) : 0;
        outgoing.hpHi = Math.min(max, outgoing.hpHi + heal);
      }
    }
    const slot = this.st.active[side].indexOf(outName);
    if (slot >= 0) this.st.active[side][slot] = inName; else this.st.active[side].push(inName);
    const entry: Extract<LogEntry, { type: 'switch' }> = { type: 'switch', side, mon: outName, in: inName };
    if (opts.replace) entry.replace = true;
    if (opts.via) entry.via = opts.via;
    this.log.push(entry);
    this.fx.enter(side, inName);
  }

  /** Switches the user out after a pivot move. Nothing happens if nobody is left to come in. */
  private pivot(side: Side, a: TurnAction, moveName: string, opts: { passBoosts?: boolean; via?: string; sub?: number } = {}): void {
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

  /** Logs a stat change first, so whatever it sets off (White Herb, Defiant) reads after it. */
  private boostLog(side: Side, name: string, move: string, table: BoostChange | undefined, opts: { own?: boolean; foe?: boolean }): void {
    const entry: Extract<LogEntry, { type: 'boost' }> = { type: 'boost', side, mon: name, move, changes: [] };
    this.log.push(entry);
    entry.changes = this.fx.changes(side, name, table, opts);
  }

  private statusMove(side: Side, a: TurnAction, actor: MonState, info: MoveInfo, id: string): void {
    const foe = otherSide(side);
    const stats = statsOf(actor);

    if (id === 'bellydrum' || id === 'clangoroussoul') {
      const cost = Math.floor(stats.hp / (id === 'bellydrum' ? 2 : 3));
      if (actor.hp <= cost) { this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: 'fails (not enough HP)' }); return; }
      const table: BoostChange = id === 'bellydrum' ? { atk: 12 } : { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
      this.boostLog(side, a.mon, info.name, table, { own: true });
      this.fx.hurt(side, a.mon, cost, null); // a Sitrus Berry can then kick in
      return;
    }

    const inflicts = STATUS_MOVES[id];
    if (inflicts) { this.statusInflictingMove(side, a, actor, info, id, inflicts); return; }

    const setup = SETUP_MOVES[id];
    if (setup) {
      const table: BoostChange = { ...setup };
      if (id === 'growth' && this.st.field.weather === 'Sun') { table.atk = 2; table.spa = 2; }
      this.boostLog(side, a.mon, info.name, table, { own: true });
      if (id === 'tidyup') {
        for (const s2 of SIDES) { this.st.field.hazards[s2] = noHazards(); for (const n of aliveActive(this.st, s2)) this.st.mons[s2][n]!.sub = 0; }
        this.log.push({ type: 'field', side, mon: a.mon, move: info.name, text: 'clears hazards and Substitutes' });
      }
      return;
    }

    if (ITEM_SWAP.has(id)) { this.swapItems(side, a, actor, info); return; }

    if (DEBUFF_MOVES[id]) {
      const spread = isSpread(info, a);
      let names: string[] = [];
      if (spread) names = aliveActive(this.st, foe);
      else if (this.st.mons[foe][a.target]) { const name = this.foeInSlot(foe, a.target); names = name ? [this.redirected(actor, foe, info, name)] : []; }
      else if (!a.target) throw new Incomplete(`${a.mon}: pick a target for ${info.name}`);
      const targets: DebuffTarget[] = [];
      this.log.push({ type: 'debuff', side, mon: a.mon, move: info.name, targets });
      for (const n of names) {
        const t: DebuffTarget = { side: foe, mon: n };
        targets.push(t);
        const priorityBlock = this.priorityBlock(side, { side: foe, name: n });
        if (this.st.turn.protect[monKey(foe, n)] || (spread && this.st.turn.wide[foe])) t.protected = true;
        else if (a.outcome?.targets?.[n]?.miss) t.blocked = 'missed';
        else if (priorityBlock) t.blocked = priorityBlock;
        else t.changes = this.fx.changes(foe, n, DEBUFF_MOVES[id], { foe: true });
      }
      // Parting Shot switches out unless it was blocked.
      if (PIVOT_MOVES[id] && targets.some((t) => !t.protected && !t.blocked)) this.pivot(side, a, info.name);
      return;
    }

    const fm = FIELD_MOVES[id];
    if (fm) {
      const f = this.st.field;
      // Logged first, so seeds set off by a new terrain read after it.
      const entry: Extract<LogEntry, { type: 'field' }> = { type: 'field', side, mon: a.mon, move: info.name, text: '' };
      this.log.push(entry);
      if (fm.weather) {
        const turns = this.fx.setWeather(fm.weather, side, a.mon, info.name, false);
        entry.text = turns ? `${fm.weather} for ${turns} turns` : 'fails (already active)';
      } else if (fm.terrain) {
        const turns = this.fx.setTerrain(fm.terrain, side, a.mon, info.name, false);
        entry.text = turns ? `${fm.terrain} Terrain for ${turns} turns` : 'fails (already active)';
      } else if (fm.trick) {
        if (f.trick > 0) { f.trick = 0; entry.text = 'Trick Room ends'; } else { f.trick = 5; entry.text = 'Trick Room for 5 turns'; }
      } else if (fm.tailwind) {
        f.tailwind[side] = 4; entry.text = 'Tailwind for 4 turns';
      } else if (fm.screen) {
        if (fm.screen === 'veil' && f.weather !== 'Snow') entry.text = 'fails (needs Snow)';
        else { f.screens[side][fm.screen] = toID(actor.item) === 'lightclay' ? 8 : 5; entry.text = `up for ${f.screens[side][fm.screen]} turns`; }
      }
      if (entry.text.startsWith('fails')) actor.lastFailed = true;
      if (PIVOT_MOVES[id]) this.pivot(side, a, info.name); // Chilly Reception
      return;
    }

    const pivot = PIVOT_MOVES[id];
    if (pivot) {
      if (id === 'shedtail') {
        const cost = Math.ceil(stats.hp / 2);
        if (actor.hp <= cost) { this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: 'fails (not enough HP)' }); return; }
        this.fx.hurt(side, a.mon, cost, null);
      }
      this.pivot(side, a, info.name, { passBoosts: pivot.passBoosts === true, via: info.name, ...(id === 'shedtail' ? { sub: Math.floor(stats.hp / 4) } : {}) });
      return;
    }

    if (this.utilityMove(side, a, actor, info, id)) return;
    this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: 'no effect is modeled' });
  }

  /** The single target of a status move, unless Protect, a Substitute or Magic Bounce / Good as Gold stops it (logged as a failure). */
  private statusTarget(side: Side, a: TurnAction, actor: MonState, info: MoveInfo): { t: Target; target: MonState } | null {
    const t = this.resolveTargets(side, a, info, actor)[0];
    const target = t ? this.st.mons[t.side][t.name] : undefined;
    const fail = (why: string): null => { actor.lastFailed = true; this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: `fails (${why})` }); return null; };
    if (!t || !target || target.fainted) return fail('no target');
    if (t.side !== side) {
      if (this.st.turn.protect[monKey(t.side, t.name)]) return fail(`${t.name} protected itself`);
      if (a.outcome?.targets?.[t.name]?.miss) return fail('missed');
      const block = this.priorityBlock(side, t);
      if (block) return fail(`blocked by ${block}`);
      if (['goodasgold', 'magicbounce'].includes(toID(target.ability))) return fail(target.ability);
      if (target.sub && !info.sound && toID(actor.ability) !== 'infiltrator') return fail(`${t.name}'s Substitute`);
    }
    return { t, target };
  }

  /** For After You, Quash and Instruct: whether the target can be moved in the order / made to repeat its move. */
  private repeatOrMoveTarget(side: Side, a: TurnAction, info: MoveInfo, actor: MonState, id: string): boolean {
    const t = this.resolveTargets(side, a, info, actor)[0];
    const target = t ? this.st.mons[t.side][t.name] : undefined;
    if (!t || !target || target.fainted) return false;
    if (id === 'instruct') return !!target.lastMove && !NOT_REPEATABLE.has(toID(target.lastMove)) && !target.charging && !target.recharging && !CHARGE_MOVES[toID(target.lastMove)];
    return !this.st.turn.acted[monKey(t.side, t.name)] && this.planned.has(monKey(t.side, t.name));
  }

  /**
   * Recovery and utility status moves: Recover and friends (by weather for Moonlight / Synthesis / Shore Up), Life Dew,
   * Heal Pulse, Floral Healing, Wish, Pain Split, Rest, Substitute, Haze, hazards, Defog, Court Change, rooms and
   * Gravity, Taunt, Encore, Disable, Imprison, Yawn, Perish Song, Leech Seed, Destiny Bond, ability changers,
   * Transform, Ally Switch, After You, Quash, Instruct. Returns false for moves it doesn't know.
   */
  private utilityMove(side: Side, a: TurnAction, actor: MonState, info: MoveInfo, id: string): boolean {
    const f = this.st.field;
    const max = statsOf(actor).hp;
    const note = (text: string, failed = false): true => {
      if (failed) actor.lastFailed = true;
      this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: text });
      return true;
    };

    const heal = HEAL_MOVES[id];
    if (heal !== undefined) {
      const weather = f.weather && toID(heldItem(this.st, actor)) !== 'utilityumbrella' ? f.weather : null;
      const frac = heal === 'weather' ? (weather === 'Sun' ? 2 / 3 : weather ? 1 / 4 : 1 / 2) : heal === 'sand' ? (weather === 'Sand' ? 2 / 3 : 1 / 2) : heal;
      if (actor.hp >= max) return note('fails (already at full HP)', true);
      this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: 'restores HP' });
      this.fx.heal(side, a.mon, share(max, frac).amount, info.name, frac);
      return true;
    }
    const team = TEAM_HEAL_MOVES[id];
    if (team) {
      this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: 'heals its side' });
      for (const n of aliveActive(this.st, side)) {
        const m = this.st.mons[side][n]!;
        this.fx.heal(side, n, share(statsOf(m).hp, team.share).amount, info.name, team.share);
        if (team.cure && m.status) { m.status = null; this.log.push({ type: 'cure', side, mon: n, text: `is cured by ${info.name}` }); }
      }
      return true;
    }
    if (id === 'healpulse' || id === 'floralhealing') {
      const got = this.statusTarget(side, a, actor, info);
      if (!got) return true;
      const frac = id === 'floralhealing' && f.terrain === 'Grassy' ? 2 / 3 : 1 / 2;
      if (got.target.hp >= statsOf(got.target).hp) return note('fails (already at full HP)', true);
      this.fx.heal(got.t.side, got.t.name, share(statsOf(got.target).hp, frac).amount, info.name, frac);
      return true;
    }
    if (id === 'wish') {
      const slot = this.st.active[side].indexOf(a.mon);
      if (f.wish[side].some((w) => w.slot === slot)) return note('fails (a Wish is already coming)', true);
      f.wish[side].push({ slot, amount: Math.floor(max / 2), turns: 2 });
      return note('makes a wish (heals this position at the end of next turn)');
    }
    if (id === 'painsplit') {
      const got = this.statusTarget(side, a, actor, info);
      if (!got) return true;
      const avg = Math.floor((actor.hp + got.target.hp) / 2);
      for (const m of [actor, got.target]) {
        const cap = statsOf(m).hp;
        const value = Math.min(cap, avg);
        m.hp = value; m.hpLo = Math.min(cap, value); m.hpHi = Math.min(cap, value);
      }
      return note(`shares HP with ${got.t.name}: both at ${avg} HP`);
    }
    if (id === 'rest') {
      const ability = toID(actor.ability);
      if (actor.hp >= max) return note('fails (already at full HP)', true);
      if (actor.status === 'slp' || ['insomnia', 'vitalspirit', 'comatose', 'purifyingsalt'].includes(ability)) return note("fails (it can't fall asleep)", true);
      if (this.fx.grounded(actor) && (f.terrain === 'Electric' || f.terrain === 'Misty')) return note(`fails (${f.terrain} Terrain)`, true);
      this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: 'sleeps for two turns and restores all HP' });
      this.fx.heal(side, a.mon, max - actor.hp, info.name);
      actor.status = 'slp'; actor.toxic = 0; actor.slept = -1;
      const berry = heldItem(this.st, actor);
      if (['chestoberry', 'lumberry'].includes(toID(berry))) { this.fx.takeItem(side, a.mon); actor.status = null; actor.slept = 0; this.log.push({ type: 'cure', side, mon: a.mon, text: `wakes up thanks to ${berry}` }); }
      return true;
    }
    if (id === 'substitute') {
      const cost = Math.floor(max / 4);
      if (actor.sub) return note('fails (it already has a Substitute)', true);
      if (actor.hp <= cost) return note('fails (not enough HP)', true);
      this.fx.hurt(side, a.mon, cost, null);
      actor.sub = cost;
      return note('puts up a Substitute (25% of its HP)');
    }
    if (id === 'haze') {
      for (const s2 of SIDES) for (const n of aliveActive(this.st, s2)) this.fx.clearBoosts(s2, n);
      return note('resets every stat change');
    }
    const hazard = HAZARD_MOVES[id];
    if (hazard) {
      if (!this.layHazard(otherSide(side), hazard, info.name, side, a.mon)) return note('fails (already at its limit)', true);
      return true;
    }
    if (id === 'defog') {
      const foe = otherSide(side);
      f.screens[foe] = { reflect: 0, light: 0, veil: 0 };
      f.hazards = { me: noHazards(), opp: noHazards() };
      f.terrain = null; f.tTurns = 0;
      return note("clears hazards, the terrain and the opponent's screens");
    }
    if (id === 'courtchange') {
      const swap = <T,>(rec: Record<Side, T>): void => { const me = rec.me; rec.me = rec.opp; rec.opp = me; };
      swap(f.screens); swap(f.tailwind); swap(f.hazards);
      return note('swaps the effects on each side');
    }
    const room = ROOM_MOVES[id];
    if (room) {
      if (f[room] > 0) {
        if (room === 'gravity') return note('fails (Gravity is already in effect)', true);
        f[room] = 0;
        return note(`${info.name} ends`);
      }
      f[room] = 5;
      if (room === 'gravity') for (const s2 of SIDES) for (const n of aliveActive(this.st, s2)) { const m = this.st.mons[s2][n]!; if (m.charging?.semi && ['fly', 'bounce'].includes(toID(m.charging.move))) m.charging = null; }
      return note(`${info.name} for 5 turns`);
    }
    if (id === 'perishsong') {
      for (const s2 of SIDES) for (const n of aliveActive(this.st, s2)) {
        const m = this.st.mons[s2][n]!;
        if (m.perish === null && toID(m.ability) !== 'soundproof') m.perish = 4;
      }
      return note('every Pokémon that hears it faints in 3 turns');
    }
    if (id === 'destinybond') { actor.destinyBond = true; return note('takes its attacker down with it if it faints before moving again'); }
    if (id === 'imprison') { actor.imprison = true; return note("the opponents can't use the moves it knows"); }
    if (id === 'allyswitch') {
      const row = this.st.active[side];
      if (row.length < 2 || !aliveActive(this.st, side).some((n) => n !== a.mon)) return note('fails (no partner)', true);
      row.reverse();
      return note('swaps places with its partner');
    }

    if (id in CONFUSE_MOVES) {
      const boost = CONFUSE_MOVES[id];
      const names = id === 'teeterdance'
        ? SIDES.flatMap((s2) => aliveActive(this.st, s2).filter((n) => !(s2 === side && n === a.mon)).map((n) => ({ t: { side: s2, name: n }, target: this.st.mons[s2][n]! })))
        : [this.statusTarget(side, a, actor, info)].filter((x): x is { t: Target; target: MonState } => x !== null);
      for (const { t } of names) {
        if (a.outcome?.targets?.[t.name]?.miss) { note(`misses ${t.name}`, true); continue; }
        if (boost) this.boostLog(t.side, t.name, info.name, boost, { own: true });
        const why = this.fx.confuse(t.side, t.name, t.side !== side || t.name !== a.mon);
        note(why ? `${t.name} isn't confused (${why})` : `${t.name} becomes confused`, !!why);
      }
      return true;
    }

    const targeted = ['taunt', 'encore', 'disable', 'yawn', 'leechseed', 'skillswap', 'entrainment', 'transform', 'afteryou', 'quash', 'instruct', ...Object.keys(ABILITY_SETTERS)];
    if (!targeted.includes(id)) return false;
    const got = this.statusTarget(side, a, actor, info);
    if (!got) return true;
    const { t, target } = got;
    const tAbility = toID(target.ability);
    const aromaVeil = aliveActive(this.st, t.side).some((n) => toID(this.st.mons[t.side][n]!.ability) === 'aromaveil');
    switch (id) {
      case 'taunt':
        if (target.taunt > 0 || tAbility === 'oblivious' || aromaVeil) return note(`fails (${target.taunt > 0 ? 'already taunted' : aromaVeil ? 'Aroma Veil' : target.ability})`, true);
        target.taunt = 3;
        if (toID(heldItem(this.st, target)) === 'mentalherb') { this.fx.loseItem(t.side, t.name, 'cures the Taunt'); target.taunt = 0; }
        return note(`${t.name} can only attack for 3 turns`);
      case 'encore': {
        if (!target.lastMove || target.encore || NOT_REPEATABLE.has(toID(target.lastMove)) || aromaVeil) return note('fails (nothing to repeat)', true);
        target.encore = { move: target.lastMove, turns: 3 };
        // If it hasn't moved yet, it uses the encored move this turn.
        const pending = this.planned.get(monKey(t.side, t.name));
        if (pending && !this.st.turn.acted[monKey(t.side, t.name)] && pending.action.kind !== 'switch') {
          pending.action = { ...pending.action, move: target.lastMove, target: target.lastTarget };
          pending.info = this.engine.moveInfo(target.lastMove);
          pending.priority = this.priorityOf(target, pending.info);
        }
        return note(`${t.name} must repeat ${target.lastMove} for 3 turns`);
      }
      case 'disable':
        if (!target.lastMove || target.disable || aromaVeil) return note('fails (nothing to disable)', true);
        target.disable = { move: target.lastMove, turns: 4 };
        return note(`${t.name} can't use ${target.lastMove} for 4 turns`);
      case 'yawn':
        if (target.status || target.yawn) return note(`fails (${target.status ? `already ${STATUS_LABEL[target.status]}` : 'already drowsy'})`, true);
        target.yawn = 2;
        return note(`${t.name} grows drowsy: it falls asleep at the end of next turn`);
      case 'leechseed':
        if (target.seeded || this.engine.typesOf(target.species).includes('Grass')) return note(`fails (${target.seeded ? 'already seeded' : 'Grass type'})`, true);
        target.seeded = { side, slot: this.st.active[side].indexOf(a.mon) };
        return note(`${t.name} is seeded`);
      case 'skillswap':
        if (FIXED_ABILITIES.has(toID(actor.ability)) || FIXED_ABILITIES.has(tAbility)) return note("fails (an ability can't be swapped)", true);
        [actor.ability, target.ability] = [target.ability, actor.ability];
        note(`swaps abilities with ${t.name}`);
        this.fx.enter(side, a.mon, true);
        this.fx.enter(t.side, t.name, true);
        return true;
      case 'entrainment':
        if (FIXED_ABILITIES.has(toID(actor.ability)) || FIXED_ABILITIES.has(tAbility) || tAbility === toID(actor.ability)) return note("fails (the ability can't be passed on)", true);
        target.ability = actor.ability;
        note(`${t.name} gets ${actor.ability}`);
        this.fx.enter(t.side, t.name, true);
        return true;
      case 'transform':
        if (!this.fx.transform(side, a.mon, t.side, t.name, info.name)) return note('fails', true);
        return true;
      case 'afteryou':
        this.st.turn.next[monKey(t.side, t.name)] = true;
        return note(`${t.name} moves next`);
      case 'quash':
        this.st.turn.last[monKey(t.side, t.name)] = true;
        return note(`${t.name} moves last`);
      case 'instruct': {
        note(`${t.name} uses ${target.lastMove} again`);
        const again: TurnAction = { side: t.side, mon: t.name, kind: 'move', move: target.lastMove, target: target.lastTarget };
        const info2 = this.engine.moveInfo(target.lastMove);
        this.execute({ action: again, index: -1, mon: target, info: info2, priority: this.priorityOf(target, info2) }, true);
        return true;
      }
      default: {
        const set = ABILITY_SETTERS[id];
        if (!set || FIXED_ABILITIES.has(tAbility) || tAbility === toID(set)) return note("fails (the ability can't be changed)", true);
        target.ability = set;
        if (id === 'worryseed' && target.status === 'slp') { target.status = null; this.log.push({ type: 'cure', side: t.side, mon: t.name, text: 'wakes up' }); }
        return note(`${t.name}'s ability becomes ${set}`);
      }
    }
  }

  /** Trick / Switcheroo: the user and the target swap items (not Mega Stones, not with Sticky Hold, not through Protect). */
  private swapItems(side: Side, a: TurnAction, actor: MonState, info: MoveInfo): void {
    const fail = (note: string): void => { this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note }); };
    const t = this.resolveTargets(side, a, info, actor)[0];
    const target = t ? this.st.mons[t.side][t.name] : undefined;
    if (!t || !target) { fail('fails (no target)'); return; }
    if (this.st.turn.protect[monKey(t.side, t.name)]) { fail(`fails (${t.name} protected itself)`); return; }
    if (!actor.item && !target.item) { fail('fails (neither holds an item)'); return; }
    const movable = (m: MonState): boolean => !m.item || this.fx.removable(m);
    if (!movable(actor) || !movable(target)) { fail("fails (an item can't be moved)"); return; }
    const mine = actor.item;
    const theirs = target.item;
    fail(`swaps items with ${t.name}: gets ${theirs || 'nothing'}, gives ${mine || 'nothing'}`);
    // Ending up with nothing counts as losing the item (Unburden).
    if (!theirs) this.fx.takeItem(side, a.mon);
    if (!mine) this.fx.takeItem(t.side, t.name);
    actor.item = theirs;
    target.item = mine;
  }

  private statusInflictingMove(side: Side, a: TurnAction, actor: MonState, info: MoveInfo, id: string, status: StatusId): void {
    const attackerAbility = toID(actor.ability);
    const spread = isSpread(info, a);
    const targets: StatusTarget[] = [];
    this.log.push({ type: 'status', side, mon: a.mon, move: info.name, targets });
    for (const t of this.resolveTargets(side, a, info, actor)) {
      const target = this.st.mons[t.side][t.name]!;
      const out: StatusTarget = { side: t.side, mon: t.name };
      targets.push(out);
      const types = this.engine.typesOf(target.species);
      const ability = toID(target.ability);
      const foe = t.side !== side;
      const priorityBlock = this.priorityBlock(side, t);
      if (foe && (this.st.turn.protect[monKey(t.side, t.name)] || (spread && this.st.turn.wide[t.side]))) out.protected = true;
      else if (a.outcome?.targets?.[t.name]?.miss) out.blocked = 'missed';
      else if (priorityBlock) out.blocked = priorityBlock;
      else if (foe && (ability === 'goodasgold' || ability === 'magicbounce')) out.blocked = target.ability;
      else if (foe && attackerAbility === 'prankster' && types.includes('Dark')) out.blocked = 'Dark types ignore Prankster';
      else if (POWDER_MOVES.has(id) && this.fx.powderImmune(target)) out.blocked = 'immune to powder';
      else if (ABSORB_ABILITIES[ability]?.type === info.type) { out.blocked = target.ability; this.absorb(t.side, t.name, target, info); }
      else if (info.type === 'Electric' && types.includes('Ground')) out.blocked = 'Ground type';
      else Object.assign(out, this.inflict(t.side, t.name, actor, target, status));
    }
  }

  /** Gives `target` a condition (see {@link Effects.inflict}); a Substitute blocks conditions from others. */
  private inflict(side: Side, name: string, actor: MonState, target: MonState, status: StatusId): Inflicted {
    if (target.sub && target !== actor) return { blocked: 'Substitute' };
    return this.fx.inflict(side, name, actor, status);
  }

  private resolveTargets(side: Side, a: TurnAction, info: MoveInfo, actor: MonState): Target[] {
    const foe = otherSide(side);
    const spread = info.target === 'allAdjacentFoes' || info.target === 'allAdjacent';
    if (spread || a.target === 'Both foes' || a.target === 'All') {
      const out = aliveActive(this.st, foe).map((name) => ({ side: foe, name }));
      // Telepathy keeps a Pokémon out of its partner's spread moves.
      if (info.target === 'allAdjacent') {
        aliveActive(this.st, side).filter((n) => n !== a.mon && toID(this.st.mons[side][n]!.ability) !== 'telepathy').forEach((name) => out.push({ side, name }));
      }
      return out;
    }
    let t: Target | null = null;
    if (a.target === 'Self') t = { side, name: a.mon };
    else if (a.target === 'Ally') {
      const ally = aliveActive(this.st, side).find((n) => n !== a.mon);
      if (ally) t = { side, name: ally };
    } else if (a.target && this.st.mons[foe][a.target]) t = { side: foe, name: a.target };
    else if (a.target && this.st.mons[side][a.target]) t = { side, name: a.target };
    if (!t) throw new Incomplete(`${a.mon}: pick a target for ${info.name}`);
    if (t.side === foe) {
      const name = this.foeInSlot(foe, t.name);
      return name ? [{ side: foe, name: this.redirected(actor, foe, info, name) }] : [];
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

  /**
   * Where a single-target move aimed at foe `name` really goes: to a foe using Follow Me / Rage Powder this turn
   * (Rage Powder doesn't draw Grass types, Overcoat or Safety Goggles), or else to a Lightning Rod / Storm Drain foe
   * for moves of its type. A redirector that has fainted draws nothing, so later moves go to their own target, or
   * to its partner when they were aimed at the redirector. Stalwart, Propeller Tail and Snipe Shot ignore all of it.
   */
  private redirected(actor: MonState, foe: Side, info: MoveInfo, name: string): string {
    if (IGNORES_REDIRECT.includes(toID(actor.ability)) || IGNORES_REDIRECT.includes(toID(info.name))) return name;
    const alive = (n: string): boolean => this.st.active[foe].includes(n) && this.st.mons[foe][n]?.fainted === false;
    const r = this.st.turn.redirect[foe];
    if (r && alive(r.name) && !(r.powder && this.fx.powderImmune(actor))) return r.name;
    const rod = this.st.active[foe].filter(alive).find((n) => {
      const ab = ABSORB_ABILITIES[toID(this.st.mons[foe][n]!.ability)];
      return ab?.redirect === true && ab.type === info.type;
    });
    return rod ?? name;
  }

  /** An ability that absorbed the move (the calculator found the holder immune): its boost or healing. */
  private absorb(side: Side, name: string, target: MonState, info: MoveInfo): void {
    if (toID(target.ability) === 'flashfire' && info.type === 'Fire' && !target.flashFire) {
      target.flashFire = true;
      this.log.push({ type: 'effect', side, mon: name, source: target.ability, text: 'powers up its Fire moves' });
    }
    const ab = ABSORB_ABILITIES[toID(target.ability)];
    if (!ab || ab.type !== info.type) return;
    if (ab.boost) this.boostLog(side, name, target.ability, ab.boost, { own: true });
    if (ab.heal) this.fx.heal(side, name, share(statsOf(target).hp, ab.heal).amount, target.ability, ab.heal);
  }

  /** Protective Pads and Long Reach avoid contact effects. */
  private contactProof(actor: MonState): boolean {
    return toID(actor.item) === 'protectivepads' || toID(actor.ability) === 'longreach';
  }

  /** Contact with a Pokémon whose ability or item hurts attackers (Rough Skin, Iron Barbs, Rocky Helmet), even if it fainted. */
  private contactDamage(side: Side, name: string, actor: MonState, target: MonState): void {
    if (this.contactProof(actor) || this.fx.indirectImmune(actor)) return;
    const max = statsOf(actor).hp;
    const ability = CONTACT_ABILITIES[toID(target.ability)];
    if (ability) this.fx.hurt(side, name, share(max, ability).amount, `${target.name}'s ${target.ability}`, ability);
    const item = CONTACT_ITEMS[toID(heldItem(this.st, target))];
    if (item) this.fx.hurt(side, name, share(max, item).amount, `${target.name}'s ${target.item}`, item);
  }

  /** Contact with a Protect variant that punishes it (Spiky Shield, Baneful Bunker, King's Shield...). */
  private punishContact(side: Side, name: string, actor: MonState, protectId: string, protector: string): void {
    const punish = CONTACT_PROTECT[protectId];
    if (!punish || this.contactProof(actor)) return;
    const source = `${protector}'s ${this.engine.moveInfo(protectId).name}`;
    if (punish.damage && !this.fx.indirectImmune(actor)) this.fx.hurt(side, name, share(statsOf(actor).hp, punish.damage).amount, source, punish.damage);
    if (punish.status) {
      const got = this.inflict(side, name, actor, actor, punish.status);
      if (got.status) this.log.push({ type: 'effect', side, mon: name, source, text: got.cured ? `${STATUS_LABEL[got.status]}, cured by ${got.cured}` : STATUS_LABEL[got.status] });
    }
    if (punish.drop) this.boostLog(side, name, source, punish.drop, { foe: true });
  }

  /** Knock Off, Thief / Covet and Incinerate take the target's item once they hit (not if the user fainted first). */
  private takeTargetItem(name: string, actor: MonState, t: Target, target: MonState, id: string): void {
    const kind = ITEM_REMOVAL[id];
    if (!kind || actor.fainted || target.fainted || !this.fx.removable(target)) return;
    if (kind === 'knock') this.fx.loseItem(t.side, t.name, `knocked off by ${name}`);
    else if (kind === 'steal' && !actor.item) {
      const item = target.item;
      this.fx.loseItem(t.side, t.name, `stolen by ${name}`);
      actor.item = item;
    } else if (kind === 'burn' && (this.engine.isBerry(target.item) || / Gem$/.test(target.item))) this.fx.loseItem(t.side, t.name, 'burned up');
  }

  /**
   * The field the calculator sees for one hit: weather, terrain, rooms, Gravity, screens, Tailwind, Helping Hand, the
   * partners' abilities (Friend Guard, Battery, Power Spot, Steely Spirit, Flower Gift), any Ruin ability in play, and
   * a Charge from Electromorphosis / Wind Power.
   */
  private fieldOptions(attSide: Side, attName: string, defSide: Side, defName: string, gameType: 'Singles' | 'Doubles', helped: boolean): FieldOptions {
    const f = this.st.field;
    const partners = (side: Side, name: string): string[] => aliveActive(this.st, side).filter((n) => n !== name).map((n) => toID(this.st.mons[side][n]!.ability));
    const att = partners(attSide, attName);
    const def = partners(defSide, defName);
    const inPlay = (ability: string): boolean => SIDES.some((side) => aliveActive(this.st, side).some((n) => toID(this.st.mons[side][n]!.ability) === ability));
    const sun = f.weather === 'Sun';
    return {
      gameType,
      weather: f.weather ?? undefined,
      terrain: f.terrain ?? undefined,
      isGravity: f.gravity > 0, isMagicRoom: f.magicRoom > 0, isWonderRoom: f.wonderRoom > 0,
      isSwordOfRuin: inPlay('swordofruin'), isBeadsOfRuin: inPlay('beadsofruin'), isTabletsOfRuin: inPlay('tabletsofruin'), isVesselOfRuin: inPlay('vesselofruin'),
      attackerSide: {
        isHelpingHand: helped, isTailwind: f.tailwind[attSide] > 0,
        isBattery: att.includes('battery'), isPowerSpot: att.includes('powerspot'), isSteelySpirit: att.includes('steelyspirit'),
        isFlowerGift: sun && att.includes('flowergift'), isCharge: this.st.mons[attSide][attName]?.charge === true,
      },
      defenderSide: {
        isReflect: f.screens[defSide].reflect > 0, isLightScreen: f.screens[defSide].light > 0,
        isAuroraVeil: f.screens[defSide].veil > 0, isTailwind: f.tailwind[defSide] > 0,
        isFriendGuard: def.includes('friendguard'), isFlowerGift: sun && def.includes('flowergift'),
      },
    };
  }

  /** Abilities the calculator applies only when told they're on: Plus / Minus with a partner, Flash Fire once lit, Stakeout on a Pokémon that just came in. */
  private abilityOn(side: Side, name: string, actor: MonState, t: Target): boolean {
    const ability = toID(actor.ability);
    if (ability === 'plus' || ability === 'minus') return aliveActive(this.st, side).some((n) => n !== name && ['plus', 'minus'].includes(toID(this.st.mons[side][n]!.ability)));
    if (ability === 'flashfire') return actor.flashFire;
    if (ability === 'stakeout') return this.st.turn.entered[monKey(t.side, t.name)] === true;
    return false;
  }

  /**
   * An attack, target by target: damage from the calculator, then in order Focus Sash / Sturdy, the items the
   * calculator used (Gem, resist berry, Air Balloon), drain, HP berries, contact damage, added effects and item
   * removal. After all targets: the user's own stat drops, recoil, Life Orb, and pivoting out.
   */
  private damagingMove(side: Side, a: TurnAction, actor: MonState, info: MoveInfo, id: string): void {
    // Two-turn moves: the first action charges (with Electro Shot's or Meteor Beam's boost) unless the weather or a
    // Power Herb lets it attack at once; the next one attacks.
    const charge = CHARGE_MOVES[id];
    if (charge && !actor.charging) {
      if (charge.boost) this.boostLog(side, a.mon, info.name, charge.boost, { own: true });
      const instant = charge.instantIn !== undefined && this.st.field.weather === charge.instantIn && toID(actor.item) !== 'utilityumbrella';
      if (!instant) {
        if (toID(actor.item) === 'powerherb') this.fx.loseItem(side, a.mon, `lets it use ${info.name} at once`);
        else {
          actor.charging = { move: info.name, target: a.target, semi: charge.semi ?? null };
          this.st.turn.charged[monKey(side, a.mon)] = true;
          this.log.push({ type: 'effect', side, mon: a.mon, source: info.name, text: `${charge.semi ?? charge.text ?? 'charges up'}: attacks on its next action` });
          return;
        }
      }
    }
    actor.charging = null;

    if (COUNTER_MOVES[id]) { this.counterMove(side, a, actor, info, id); return; }
    const spread = info.target === 'allAdjacentFoes' || info.target === 'allAdjacent';
    const targets = this.resolveTargets(side, a, info, actor);
    const gameType = spread && targets.length < 2 ? 'Singles' : 'Doubles'; // the 0.75 spread cut needs two targets
    const moldBreaker = MOLD_BREAKERS.has(toID(actor.ability));
    const bypassSub = info.sound || toID(actor.ability) === 'infiltrator';
    let hazardsLaid = false;
    const helped = this.st.turn.helped[monKey(side, a.mon)] === true;
    // Sheer Force drops the move's added effects, and with them Life Orb's recoil (the calculator adds the power).
    const sheerForce = toID(actor.ability) === 'sheerforce' && info.secondaries;
    const entry: Extract<LogEntry, { type: 'hit' }> = { type: 'hit', side, mon: a.mon, move: info.name, results: [] };
    this.log.push(entry);
    let anyHit = false;
    let recoil = 0;
    let lifeOrb = false;

    for (const t of targets) {
      const target = this.st.mons[t.side][t.name]!;
      const result: HitResult = { side: t.side, mon: t.name };
      entry.results.push(result);
      const isSelf = t.side === side && t.name === a.mon;
      if (!isSelf) {
        if (BREAKS_PROTECT.has(id) && t.side !== side) this.breakProtection(t, info.name);
        const protectId = this.st.turn.protect[monKey(t.side, t.name)];
        if (protectId && !BREAKS_PROTECT.has(id)) {
          result.protected = true;
          if (info.contact) this.punishContact(side, a.mon, actor, protectId, t.name);
          continue;
        }
        // Wide Guard covers its whole side from spread moves, an ally's Earthquake included.
        if (spread && this.st.turn.wide[t.side]) { result.protected = true; continue; }
        const priorityBlock = this.priorityBlock(side, t);
        if (priorityBlock) { result.blockedBy = priorityBlock; continue; }
        // Up in the air, underground...: only a few moves reach it.
        if (target.charging?.semi && !(HITS_SEMI_INVULNERABLE[toID(target.charging.move)] ?? []).includes(id)) {
          result.blockedBy = `out of reach (${t.name} ${target.charging.semi})`;
          continue;
        }
        // Pollen Puff heals a partner instead of hurting it.
        if (id === 'pollenpuff' && t.side === side) {
          const healed = this.fx.heal(t.side, t.name, share(statsOf(target).hp, 1 / 2).amount, info.name, 1 / 2);
          if (!healed) result.blockedBy = 'already at full HP';
          else anyHit = true;
          continue;
        }
        // Brick Break and friends shatter screens on the target's side before hitting.
        if (SCREEN_BREAKERS.has(id) && t.side !== side) {
          const sc = this.st.field.screens[t.side];
          if (sc.reflect || sc.light || sc.veil) {
            this.st.field.screens[t.side] = { reflect: 0, light: 0, veil: 0 };
            this.log.push({ type: 'effect', side: t.side, mon: t.name, source: info.name, text: 'shatters the screens' });
          }
        }
        // Disguise (any attack) and Ice Face (physical) take the first hit, unless the attacker breaks the mould.
        const shield = toID(target.ability);
        if (!moldBreaker && !target.disguiseBroken && (shield === 'disguise' || (shield === 'iceface' && info.category === 'Physical'))) {
          target.disguiseBroken = true;
          result.blockedBy = target.ability;
          anyHit = true;
          this.log.push({ type: 'effect', side: t.side, mon: t.name, source: target.ability, text: 'takes the hit and is broken' });
          if (shield === 'disguise') this.fx.hurt(t.side, t.name, share(statsOf(target).hp, 1 / 8).amount, target.ability, 1 / 8);
          continue;
        }
      }
      const told = a.outcome?.targets?.[t.name];
      if (told?.miss) { result.missed = true; continue; }
      const power = this.powerFor(side, a.mon, actor, info, id, t, target);
      if (power && power.shown !== info.bp) result.power = power.shown;
      const alliesFainted = this.faintedAllies(side, a.mon);
      const { hit, hits } = this.attack(side, actor, target, info, id, this.fieldOptions(side, a.mon, t.side, t.name, gameType, helped), {
        ...(power ? { basePower: power.send } : {}), ...(alliesFainted ? { alliesFainted } : {}), ...(this.abilityOn(side, a.mon, actor, t) ? { attackerOn: true } : {}),
        ...(told?.crit ? { crit: true } : {}), ...(a.outcome?.hits && info.multihit ? { hits: a.outcome.hits } : {}),
      });
      if (told?.crit) result.crit = true;
      if (id === 'beatup') result.hits = hits;
      const rolls = hit.rolls;
      const min = Math.min(...rolls);
      const max = Math.max(...rolls);
      const avg = Math.round(mean(rolls));
      const maxHP = statsOf(target).hp;
      result.minPct = round1((min / maxHP) * 100);
      result.maxPct = round1((max / maxHP) * 100);
      if (max === 0) { result.immune = true; this.absorb(t.side, t.name, target, info); continue; }

      // A Substitute takes the hit (sound moves and Infiltrator go around it); none of the other effects happen.
      if (target.sub && !isSelf && !bypassSub) {
        const taken = Math.min(target.sub, avg);
        target.sub -= taken;
        anyHit = true;
        result.substitute = target.sub > 0 ? 'hit' : 'broken';
        if (target.sub <= 0) { target.sub = 0; this.log.push({ type: 'effect', side: t.side, mon: t.name, source: 'Substitute', text: 'breaks' }); }
        continue;
      }

      // Focus Sash and Sturdy: at full HP, a single hit that would knock it out leaves it at 1 HP.
      const before = target.hp;
      const sash = toID(heldItem(this.st, target)) === 'focussash';
      const sturdy = toID(target.ability) === 'sturdy' && !moldBreaker;
      const holdsOn = before === maxHP && before > 1 && !info.multihit && hits <= 1 && (sash || sturdy);
      const cap = (x: number): number => (holdsOn ? Math.min(x, before - 1) : x);
      const kos = rolls.filter((x) => cap(x) >= before).length;
      if (kos) result.koChance = kos === rolls.length ? 100 : Math.max(1, Math.round((kos / rolls.length) * 100));
      target.hp = Math.max(0, before - cap(avg));
      target.hpLo = Math.max(0, target.hpLo - cap(max));
      target.hpHi = Math.max(0, target.hpHi - cap(min));
      if (target.hp <= 0) target.fainted = true;
      // HP the turn recorded (a replay) replaces the average roll.
      if (told?.hp !== undefined) {
        const pinned = told.hp > 0 ? Math.max(1, Math.round((told.hp * maxHP) / 100)) : 0;
        target.hp = target.hpLo = target.hpHi = pinned;
        target.fainted = pinned <= 0;
        result.actualPct = told.hp;
      }
      const dealt = before - target.hp;
      anyHit = true;
      if (!isSelf) {
        // Each hit counts for Rage Fist (Beat Up from an ally is the classic way to stack it).
        target.timesHit += Math.max(1, hits);
        (this.st.turn.hitBy[monKey(t.side, t.name)] ??= []).push(monKey(side, a.mon));
        if (t.side !== side) this.st.turn.damaged[monKey(t.side, t.name)] = { amount: dealt, category: info.category, by: monKey(side, a.mon) };
      }
      if (holdsOn && max >= before) {
        result.endured = sash ? target.item : target.ability;
        if (sash && avg >= before) this.fx.loseItem(t.side, t.name, 'hangs on at 1 HP');
      }

      // Items the calculator applied to this hit.
      if (hit.attackerItem === 'Life Orb') lifeOrb = true;
      else if (/ Gem$/.test(hit.attackerItem) && actor.item === hit.attackerItem) this.fx.loseItem(side, a.mon, 'is used up');
      if (hit.defenderItem && hit.defenderItem === target.item && this.engine.isBerry(target.item)) this.fx.loseItem(t.side, t.name, 'weakens the hit');
      if (toID(target.item) === 'airballoon') this.fx.loseItem(t.side, t.name, 'pops');

      // Drain and recoil follow the damage actually dealt (less when Focus Sash held or the target had little HP left).
      const scaled = (x: number): number => Math.round((x * dealt) / Math.max(1, Math.min(avg, before)));
      if (hit.drain > 0) this.fx.heal(side, a.mon, scaled(hit.drain), info.name);
      recoil += scaled(hit.recoil);

      this.fx.berries(t.side, t.name);
      if (info.contact && !isSelf) this.contactDamage(side, a.mon, actor, target);
      if (!isSelf) this.reactToHit(side, a.mon, actor, t, target, info, before);
      if (told?.crit && !target.fainted && toID(target.ability) === 'angerpoint') this.boostLog(t.side, t.name, target.ability, { atk: 12 }, { own: true });
      if (target.fainted) this.knockedOut(side, a.mon, actor, t, target);
      if (HAZARD_ATTACKS[id] && t.side !== side && !hazardsLaid) { hazardsLaid = true; this.layHazard(t.side, HAZARD_ATTACKS[id], info.name, side, a.mon); }
      if (id === 'saltcure' && !target.fainted && !target.saltCure) { target.saltCure = true; this.log.push({ type: 'effect', side: t.side, mon: t.name, source: info.name, text: 'is being salt cured' }); }

      const targetAbility = toID(target.ability);
      if (!sheerForce) {
        if (ALWAYS_FLINCH.has(id) && !target.fainted && !['innerfocus', 'shielddust'].includes(targetAbility) && toID(target.item) !== 'covertcloak') {
          this.st.turn.flinched[monKey(t.side, t.name)] = true;
        }
        if (SECONDARY_DROPS[id] && !target.fainted) result.changes = this.fx.changes(t.side, t.name, SECONDARY_DROPS[id], { foe: t.side !== side, secondary: true });
        const secondary = SECONDARY_STATUS[id];
        if (secondary && !target.fainted && targetAbility !== 'shielddust' && toID(target.item) !== 'covertcloak') {
          const got = this.inflict(t.side, t.name, actor, target, secondary);
          if (got.status) { result.status = got.status; if (got.cured) result.cured = got.cured; }
        }
      }
      if (CLEARS_STATS.has(id) && !target.fainted) this.fx.clearBoosts(t.side, t.name);
      // A frozen target thaws when a Fire move (or Scald and the like) hits it.
      if (target.status === 'frz' && !target.fainted && (info.type === 'Fire' || THAW_MOVES.has(id))) {
        target.status = null;
        this.log.push({ type: 'cure', side: t.side, mon: t.name, text: 'thaws out' });
      }
      // Chance effects the turn says happened (a flinch, a burn, a stat drop...).
      if (!sheerForce) {
        const landed = (told?.effects ?? []).map((fx) => this.fx.chanceEffect(t.side, t.name, fx, actor, t.side !== side)).filter((x): x is string => !!x);
        if (landed.length) result.effects = landed;
      }
      this.takeTargetItem(a.mon, actor, t, target, id);
    }

    if (actor.charge && info.type === 'Electric') actor.charge = false;
    if (!anyHit && entry.results.some((r) => r.missed) && toID(heldItem(this.st, actor)) === 'blunderpolicy') {
      const policy = this.fx.takeItem(side, a.mon);
      this.boostLog(side, a.mon, policy, { spe: 2 }, { own: true });
    }
    if (!anyHit) { actor.lastFailed = true; return; }
    for (const fx of a.outcome?.self ?? []) this.fx.chanceEffect(side, a.mon, fx, actor, false);
    // Rapid Spin and Mortal Spin clear hazards from the user's side (Rapid Spin also raises Speed).
    if ((id === 'rapidspin' || id === 'mortalspin') && !actor.fainted) {
      this.st.field.hazards[side] = noHazards();
      if (id === 'rapidspin') this.boostLog(side, a.mon, info.name, { spe: 1 }, { own: true });
    }
    if (info.sound && toID(heldItem(this.st, actor)) === 'throatspray' && !actor.fainted) {
      const spray = this.fx.takeItem(side, a.mon);
      this.boostLog(side, a.mon, spray, { spa: 1 }, { own: true });
    }
    if (RECHARGE_MOVES.has(id) && !actor.fainted) actor.recharging = info.name;
    if (SELF_DROPS[id] && !actor.fainted) entry.self = this.fx.changes(side, a.mon, SELF_DROPS[id], { own: true });
    if (!this.fx.indirectImmune(actor)) {
      if (recoil > 0) this.fx.hurt(side, a.mon, recoil, 'recoil');
      if (lifeOrb && !sheerForce) this.fx.hurt(side, a.mon, share(statsOf(actor).hp, 1 / 10).amount, 'Life Orb', 1 / 10);
    }
    if (PIVOT_MOVES[id]) this.pivot(side, a, info.name);
  }

  /**
   * What a hit sets off in the target: Stamina, Weak Armor, Justified and the like, Electromorphosis / Wind Power,
   * Cotton Down, Seed Sower, Sand Spit, Toxic Debris, Kee / Maranga Berry and the other type-triggered items,
   * Weakness Policy, Berserk / Anger Shell / Emergency Exit, Eject Button and Red Card.
   */
  private reactToHit(side: Side, user: string, actor: MonState, t: Target, target: MonState, info: MoveInfo, before: number): void {
    const ability = toID(target.ability);
    if (!target.fainted) {
      const onHit = ON_HIT_ABILITIES[ability];
      if (onHit && (!onHit.type || onHit.type.includes(info.type)) && (!onHit.category || onHit.category === info.category)) {
        this.boostLog(t.side, t.name, target.ability, onHit.boost, { own: true });
      }
      if ((ability === 'electromorphosis' || (ability === 'windpower' && info.wind)) && !target.charge) {
        target.charge = true;
        this.log.push({ type: 'effect', side: t.side, mon: t.name, source: target.ability, text: 'is charged: its next Electric move doubles' });
      }
      const item = toID(heldItem(this.st, target));
      const onItem = ON_HIT_ITEMS[item];
      if (onItem && (!onItem.type || onItem.type === info.type) && (!onItem.category || onItem.category === info.category)) {
        const used = this.fx.takeItem(t.side, t.name);
        this.boostLog(t.side, t.name, used, onItem.boost, { own: true });
      }
      if (item === 'weaknesspolicy' && this.engine.effectiveness(info.type, target.species) > 1) {
        const used = this.fx.takeItem(t.side, t.name);
        this.boostLog(t.side, t.name, used, { atk: 2, spa: 2 }, { own: true });
      }
      this.fx.droppedBelowHalf(t.side, t.name, before, true);
      if (item === 'ejectbutton' && t.side !== side) { this.fx.loseItem(t.side, t.name, 'sends it back'); this.fx.forceOut(t.side, t.name, 'Eject Button'); }
      if (item === 'redcard' && t.side !== side && !actor.fainted) { this.fx.loseItem(t.side, t.name, `sends ${user} back`); this.fx.forceOut(side, user, 'Red Card'); }
    }
    if (ability === 'cottondown') {
      for (const s2 of SIDES) for (const n of aliveActive(this.st, s2)) {
        if (s2 === t.side && n === t.name) continue;
        this.boostLog(s2, n, `${t.name}'s Cotton Down`, { spe: -1 }, { foe: s2 !== t.side });
      }
    }
    if (ability === 'seedsower') this.fx.setTerrain('Grassy', t.side, t.name, target.ability);
    if (ability === 'sandspit') this.fx.setWeather('Sand', t.side, t.name, target.ability);
    if (ability === 'toxicdebris' && info.category === 'Physical' && this.st.field.hazards[side].tspikes < 2) {
      this.layHazard(side, 'tspikes', target.ability, t.side, t.name);
    }
  }

  /** A Pokémon knocked out by an attack: Destiny Bond takes the attacker too; Moxie and friends raise its stats. */
  private knockedOut(side: Side, user: string, actor: MonState, t: Target, target: MonState): void {
    this.fx.fainted(t.side, t.name);
    if (t.side === side) return;
    if (target.destinyBond && !actor.fainted) { this.fx.hurt(side, user, actor.hp, `${t.name}'s Destiny Bond`); return; }
    const onKo = ON_KO_ABILITIES[toID(actor.ability)];
    if (!onKo || actor.fainted) return;
    const stat = onKo === 'best' ? bestStatOf(actor) : null;
    this.boostLog(side, user, actor.ability, stat ? { [stat]: 1 } : (onKo as BoostChange), { own: true });
  }

  /** Lays one layer of an entry hazard on `on`'s side (Stealth Rock and Sticky Web once, Spikes up to 3, Toxic Spikes up to 2). */
  private layHazard(on: Side, kind: 'rocks' | 'spikes' | 'tspikes' | 'web', source: string, side: Side, name: string): boolean {
    const h = this.st.field.hazards[on];
    const label = { rocks: 'Stealth Rock', spikes: 'Spikes', tspikes: 'Toxic Spikes', web: 'Sticky Web' }[kind];
    if ((kind === 'rocks' && h.rocks) || (kind === 'web' && h.web) || (kind === 'spikes' && h.spikes >= 3) || (kind === 'tspikes' && h.tspikes >= 2)) return false;
    if (kind === 'rocks') h.rocks = true; else if (kind === 'web') h.web = true; else if (kind === 'spikes') h.spikes++; else h.tspikes++;
    this.log.push({ type: 'field', side, mon: name, move: source, text: `${label} on ${on === 'me' ? 'your' : "the opponent's"} side` });
    return true;
  }

  /** Counter (2× physical damage taken), Mirror Coat (2× special), Metal Burst / Comeuppance (1.5× either), back at whoever dealt it. */
  private counterMove(side: Side, a: TurnAction, actor: MonState, info: MoveInfo, id: string): void {
    const rule = COUNTER_MOVES[id]!;
    const taken = this.st.turn.damaged[monKey(side, a.mon)];
    const fail = (why: string): void => { actor.lastFailed = true; this.log.push({ type: 'other', side, mon: a.mon, move: info.name, note: `fails (${why})` }); };
    if (!taken || (rule.category && taken.category !== rule.category)) { fail(`no ${rule.category ? rule.category.toLowerCase() : ''} hit taken from a foe this turn`.replace('  ', ' ')); return; }
    const [bySide, byName] = taken.by.split(':') as [Side, string];
    const target = this.st.mons[bySide][byName];
    if (!target || target.fainted || !this.st.active[bySide].includes(byName)) { fail("the attacker isn't on the field"); return; }
    const entry: Extract<LogEntry, { type: 'hit' }> = { type: 'hit', side, mon: a.mon, move: info.name, results: [] };
    this.log.push(entry);
    const result: HitResult = { side: bySide, mon: byName };
    entry.results.push(result);
    if (this.st.turn.protect[monKey(bySide, byName)]) { result.protected = true; return; }
    const damage = Math.max(1, Math.floor(taken.amount * rule.mult));
    const maxHP = statsOf(target).hp;
    result.minPct = result.maxPct = round1((damage / maxHP) * 100);
    if (damage >= target.hp) result.koChance = 100;
    target.hp = Math.max(0, target.hp - damage);
    target.hpLo = Math.max(0, target.hpLo - damage);
    target.hpHi = Math.max(0, target.hpHi - damage);
    if (target.hp <= 0) { target.fainted = true; this.knockedOut(side, a.mon, actor, { side: bySide, name: byName }, target); }
    else this.fx.berries(bySide, byName);
  }

  private tickTimers(): void {
    const f = this.st.field;
    if (f.gravity > 0) f.gravity--;
    if (f.magicRoom > 0) f.magicRoom--;
    if (f.wonderRoom > 0) f.wonderRoom--;
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
          ...(m.set.item && !m.item ? { lostItem: m.set.item } : {}),
          ...(m.charging && !m.fainted ? { charging: m.charging.move } : {}),
          ...(m.fainted ? {} : { effects: volatileLabels(this.st, m) }),
          ...(m.actual !== undefined ? { actual: m.actual } : {}),
        });
        delete m.actual;
      }
    }
    return end;
  }
}

/** Short labels for what is affecting a Pokémon besides its condition and stat stages (shown on the turn result). */
function volatileLabels(st: BattleState, m: MonState): string[] {
  const out: string[] = [];
  const lock = moveLock(st, m);
  if (lock) out.push(`${lock.reason.startsWith('Encore') ? 'Encore' : 'Locked'}: ${lock.move}`);
  if (m.recharging) out.push('must recharge');
  if (m.sub) out.push('Substitute');
  if (m.taunt) out.push(`Taunt ${m.taunt}`);
  if (m.disable) out.push(`Disabled: ${m.disable.move}`);
  if (m.yawn) out.push('drowsy');
  if (m.perish !== null) out.push(`Perish ${m.perish}`);
  if (m.seeded) out.push('Leech Seed');
  if (m.saltCure) out.push('Salt Cure');
  if (m.destinyBond) out.push('Destiny Bond');
  if (m.imprison) out.push('Imprison');
  if (m.charge) out.push('Charged');
  if (m.confused) out.push('confused');
  if (m.flashFire) out.push('Flash Fire');
  if (m.boosted) out.push(`${m.ability}: ${m.boosted.toUpperCase()}`);
  if (m.transformedFrom) out.push(`Transformed`);
  return out;
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
    runner.run(node.actions, node);
    const end = runner.snapshot();
    st.turn = newScratch();
    return { status: 'ready', log: runner.log, entry, end, state: st, field: runner.during ?? start, outcome: outcomeOf(st), order: runner.actionOrder() };
  } catch (e) {
    if (e instanceof Incomplete) return { status: 'incomplete', missing: [e.message], field: start };
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
