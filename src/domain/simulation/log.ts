import type { BoostKey, Side } from '../types.ts';
import type { BattleState, FieldState, Outcome } from './state.ts';
import type { StatusId } from './tables.ts';

export interface StatChange { stat: BoostKey; delta: number }

export interface HitResult {
  side: Side;
  mon: string;
  protected?: boolean;
  /** A priority move stopped by Quick Guard, Psychic Terrain or a priority-blocking ability. */
  blockedBy?: string;
  immune?: boolean;
  minPct?: number;
  maxPct?: number;
  /** Percent chance (1-100) that this hit knocks the target out. */
  koChance?: number;
  changes?: StatChange[];
  /** Condition inflicted by the hit (e.g. Nuzzle), and the berry that cured it straight away. */
  status?: StatusId;
  cured?: string;
  /** Focus Sash or Sturdy left it at 1 HP (on at least the highest roll). */
  endured?: string;
}

export interface DebuffTarget { side: Side; mon: string; protected?: boolean; blocked?: string; changes?: StatChange[] }

/** `blocked` says why the condition didn't stick ("already burned", "Fire type", an ability...). */
export interface StatusTarget { side: Side; mon: string; protected?: boolean; status?: StatusId; blocked?: string; cured?: string }

/** What happened during a turn, in order. `mon` is always the actor (or, for entry effects, the affected Pokémon). */
export type LogEntry =
  | { type: 'hit'; side: Side; mon: string; move: string; results: HitResult[]; self?: StatChange[] }
  | { type: 'boost'; side: Side; mon: string; move: string; changes: StatChange[] }
  | { type: 'debuff'; side: Side; mon: string; move: string; targets: DebuffTarget[] }
  | { type: 'status'; side: Side; mon: string; move: string; targets: StatusTarget[] }
  /** HP change outside the damage roll (recoil, Life Orb, berries, weather, poison, Leftovers...); `pct` is negative for damage. */
  | { type: 'residual'; side: Side; mon: string; text: string; pct: number; fainted: boolean }
  /** An item or ability doing something with no HP or stat change of its own (an item knocked off, Unburden...). */
  | { type: 'effect'; side: Side; mon: string; source: string; text: string }
  | { type: 'cure'; side: Side; mon: string; text: string }
  /** `replace`: a fainted Pokémon is replaced before the turn starts. `via`: the status move that switched it out (Teleport, Baton Pass...). */
  | { type: 'switch'; side: Side; mon: string; in: string; replace?: true; via?: string }
  | { type: 'protect'; side: Side; mon: string; move: string; text: string }
  | { type: 'field'; side: Side; mon: string; move: string; text: string }
  | { type: 'mega'; side: Side; mon: string; species: string }
  | { type: 'skip'; side: Side; mon: string; why: string }
  | { type: 'other'; side: Side; mon: string; move: string; note: string };

/** End-of-turn snapshot of one Pokémon. */
export interface EndMon {
  side: Side;
  name: string;
  /** Current form (differs from `name` after Mega Evolution). */
  species: string;
  fainted: boolean;
  /** HP left on the average roll, 0-100. */
  pct: number;
  /** HP left if every hit rolled high / low. */
  lo: number;
  hi: number;
  mayFaint: boolean;
  mayLive: boolean;
  boosts: { stat: BoostKey; delta: number }[];
  condition: StatusId | null;
  /** The item from the paste, when it has been used up or removed. */
  lostItem?: string;
}

/** `field` is the field during the turn (before the end-of-turn countdown), so it includes what was set up this turn. */
export type TurnResult =
  | { status: 'ready'; log: LogEntry[]; entry: LogEntry[]; end: EndMon[]; state: BattleState; field: FieldState; outcome: Outcome | null }
  | { status: 'incomplete'; missing: string[]; field: FieldState }
  | { status: 'error'; message: string }
  /** `over`: the battle already ended earlier in this branch (as opposed to an earlier turn being unfinished). */
  | { status: 'blocked'; over?: true };
