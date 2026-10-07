/**
 * The slice of `@smogon/calc` this app relies on. Describing it ourselves keeps the rest of the code
 * independent of the library's typings and lets tests inject a stand-in.
 */
import type { BoostTable, StatTable } from '../types.ts';

export interface CalcSpecies { baseStats: StatTable }

export interface CalcPokemon {
  species: CalcSpecies;
  rawStats: StatTable;
  stats: StatTable;
  originalCurHP: number;
  boosts: BoostTable;
  types?: string[];
  ability?: string;
}

export interface CalcMove {
  name?: string; bp?: number; type?: string; priority?: number; category?: string; target?: string;
  flags?: { contact?: number };
  /** Number of hits the calculator applies (more than 1 for multi-hit moves). */
  hits?: number;
  secondaries?: unknown;
}

export interface CalcItem { megaStone?: string | Record<string, string>; isBerry?: boolean }

export interface CalcGeneration {
  num?: number;
  moves?: { get(id: string): unknown };
  items?: { get(id: string): CalcItem | undefined };
}

export interface SideOptions {
  isHelpingHand?: boolean;
  isTailwind?: boolean;
  isReflect?: boolean;
  isLightScreen?: boolean;
  isAuroraVeil?: boolean;
}

export interface FieldOptions {
  gameType: 'Singles' | 'Doubles';
  weather?: string;
  terrain?: string;
  attackerSide: SideOptions;
  defenderSide: SideOptions;
}

/** A damage result: the rolls, which held items took part, and the user's recoil (% of its max HP) and recovery (HP). */
export interface CalcResult {
  damage: unknown;
  rawDesc?: { attackerItem?: string; defenderItem?: string };
  recoil?(notation?: string): { recoil: number | number[] };
  recovery?(notation?: string): { recovery: number[] };
}

export interface CalcLib {
  Generations?: { get(num: number): CalcGeneration };
  Pokemon: new (gen: CalcGeneration, name: string, options?: Record<string, unknown>) => CalcPokemon;
  /** `overrides.basePower` sets the power for moves whose power the calculator can't know (Rage Fist, Last Respects). */
  Move: new (gen: CalcGeneration, name: string, options?: { overrides?: { basePower?: number } }) => CalcMove;
  Field: new (options?: FieldOptions) => object;
  calculate(gen: CalcGeneration, attacker: CalcPokemon, defender: CalcPokemon, move: CalcMove, field: object): CalcResult;
}

/** Loads the calculator on demand. The browser build uses a dynamic import so it stays out of the main bundle. */
export type CalcLoader = () => Promise<CalcLib>;
