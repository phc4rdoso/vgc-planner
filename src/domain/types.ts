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
  /** What chance decided for this action (a miss, a crit, a flinch, full paralysis...). Unset means the usual assumption. */
  outcome?: ActionOutcome;
}

/**
 * A chance effect on a Pokémon: a condition ('brn', 'par', 'psn', 'tox', 'slp', 'frz'), 'flinch', 'confusion', or a
 * stat change written as stat and signed amount ('spd-1', 'atk+1').
 */
export type ChanceEffect = string;

/** What happened to one target of the move. `hp`: its HP afterwards, in percent (pins it instead of the average roll). */
export interface TargetOutcome {
  miss?: true;
  crit?: true;
  effects?: ChanceEffect[];
  hp?: number;
}

/**
 * Chance results for one action, set by hand or filled from a replay.
 * - `cant`: it couldn't act: fully paralysed, still asleep, frozen solid, hit itself in confusion, or flinched.
 * - `wake`: it woke up, thawed out or snapped out of confusion before acting.
 * - `hits`: how many times a multi-hit move hit.
 * - `protectWorks`: a Protect used right after another one worked (the 1-in-3 case).
 * - `targets`: per target, keyed by its name.
 * - `self`: chance effects on the user itself (Meteor Mash's Attack raise...).
 * - `unknown`: the move it chose isn't known (a replay doesn't show it when the Pokémon fainted or couldn't move first).
 */
export interface ActionOutcome {
  unknown?: true;
  cant?: 'par' | 'slp' | 'frz' | 'confusion' | 'flinch';
  wake?: true;
  hits?: number;
  protectWorks?: true;
  targets?: Record<string, TargetOutcome>;
  self?: ChanceEffect[];
}

export const TARGET_KEYWORDS = ['Both foes', 'Ally', 'Self', 'All'] as const;

/** Colours a named line can take (see .lc-* in canvas.css). Without one, the line keeps the default borders. */
export const LINE_COLORS = ['teal', 'sky', 'amber', 'pink', 'lime', 'orange'] as const;
export type LineColor = (typeof LINE_COLORS)[number];
/** A named line ("Plan A: Sun") starting at a turn; every later turn in that branch belongs to it until another starts. */
export interface PlanLine { name: string; color?: LineColor }

export interface FlowNode {
  id: string;
  title: string;
  /** Label for the branch leading into this turn, e.g. "If they Protect". */
  condition: string;
  note: string;
  actions: TurnAction[];
  children: FlowNode[];
  /** The order the Pokémon really acted in (`side:name`), e.g. from a replay; it wins over Speed. */
  order?: string[];
  /**
   * Who wins speed ties this turn: keys (`side:name`) in the order they go when their Speed is equal (picked by
   * hand; otherwise the game's 50/50 is assumed to go to the first one listed). On a first turn this includes the
   * leads' entry abilities at the start of the battle.
   */
  tieOrder?: string[];
  /** Each Pokémon's HP at the end of the turn, in percent (`side:name` → %), e.g. from a replay. */
  hpEnd?: Record<string, number>;
  /** Where the turn came from, when it was imported from a replay. */
  source?: { replay: string };
  /** A named line that starts at this turn. */
  line?: PlanLine;
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
