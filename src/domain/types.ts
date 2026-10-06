/**
 * Core domain types. Everything here is plain, JSON-serialisable data so the same shapes
 * can be persisted in the browser today and sent over an API tomorrow.
 */

/** "me" is the user's team, "opp" the opponent's. */
export type Side = 'me' | 'opp';
export const SIDES: readonly Side[] = ['me', 'opp'] as const;

export type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type BoostKey = Exclude<StatKey, 'hp'>;
export type StatTable = Record<StatKey, number>;
export type BoostTable = Record<BoostKey, number>;

/** One Pokémon as parsed from a Showdown paste. */
export interface PokemonSet {
  nickname: string;
  species: string;
  gender: string;
  item: string;
  ability: string;
  level: number | null;
  nature: string;
  /** Raw "EVs:" line. In Champions pastes this holds Stat Points. */
  evs: string;
  ivs: string;
  moves: string[];
  /** Lines the parser did not recognise, kept so nothing is silently dropped. */
  extra: string[];
}

export type ActionKind = 'move' | 'switch' | 'mega';

export interface TurnAction {
  side: Side;
  /** Species name exactly as written in the paste. */
  mon: string;
  kind: ActionKind;
  move: string;
  /** A Pokémon name, or one of the keywords in {@link TARGET_KEYWORDS}. For switches: the Pokémon coming in. */
  target: string;
  /** For pivot moves (U-turn, Volt Switch, Parting Shot...): the Pokémon that comes in afterwards. */
  pivot?: string;
}

export const TARGET_KEYWORDS = ['Both foes', 'Ally', 'Self', 'All'] as const;

export interface FlowNode {
  id: string;
  title: string;
  /** Label for the branch leading into this turn, e.g. "If they Protect". */
  condition: string;
  note: string;
  actions: TurnAction[];
  children: FlowNode[];
}

export type SlotKind = 'lead' | 'back';
export const SLOT_KINDS: readonly SlotKind[] = ['lead', 'back'] as const;

/** Two lead slots and two back slots per side; `null` means empty. */
export interface SideSelection {
  lead: (string | null)[];
  back: (string | null)[];
}

/** One tab of a gameplan: its own leads and backs and its own turn tree, against the gameplan's opponent. */
export interface PlanTab {
  id: string;
  name: string;
  selection: Record<Side, SideSelection>;
  /** First-level turns (alternatives for turn 1). */
  children: FlowNode[];
}

/** A gameplan against one opponent team. It always has at least one tab. */
export interface Plan {
  id: string;
  name: string;
  opponent: { name: string; paste: string };
  tabs: PlanTab[];
}

/**
 * What the editor and the simulation work on: one tab together with its gameplan's opponent. `selection` and
 * `children` are the tab's own objects, so changes made through a sheet land in the tab.
 */
export interface Sheet extends PlanTab {
  opponent: Plan['opponent'];
}

export interface Team {
  id: string;
  name: string;
  paste: string;
  plans: Plan[];
}

/** Everything the user owns. This is the unit that gets persisted. */
export interface Library {
  teams: Team[];
}
