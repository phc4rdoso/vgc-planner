import type { CalcLib, CalcLoader } from '../domain/simulation/calc-types.ts';

/**
 * Loads the official Smogon damage calculator. The dynamic import makes the bundler put it in its own
 * chunk, which is only downloaded the first time a turn result is needed.
 */
export const loadCalc: CalcLoader = async () => (await import('@smogon/calc')) as unknown as CalcLib;
