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

export interface CalcMove { name?: string; type?: string; priority?: number; category?: string; target?: string }

export interface CalcItem { megaStone?: string | Record<string, string> }

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

export interface CalcLib {
  Generations?: { get(num: number): CalcGeneration };
  Pokemon: new (gen: CalcGeneration, name: string, options?: Record<string, unknown>) => CalcPokemon;
  Move: new (gen: CalcGeneration, name: string) => CalcMove;
  Field: new (options?: FieldOptions) => object;
  calculate(gen: CalcGeneration, attacker: CalcPokemon, defender: CalcPokemon, move: CalcMove, field: object): { damage: unknown };
}

/** Loads the calculator on demand. The browser build uses a dynamic import so it stays out of the main bundle. */
export type CalcLoader = () => Promise<CalcLib>;
