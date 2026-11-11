/**
 * Names the team editor suggests: species, moves, items and abilities, read from the damage calculator's data for
 * the generation the app plays (Champions when the build has it). Plain data, so it can be searched without the
 * calculator.
 */
import { NATURES, STAT_LABEL } from './stats.ts';
import { toID } from './strings.ts';
import type { StatTable } from './types.ts';

export interface DexSpecies { name: string; types: string[]; base: StatTable; abilities: string[] }
export interface DexMove { name: string; type: string; category: string; bp: number }
/** `megaFor`: for a Mega Stone, base species -> the Mega it becomes ("Charizard" -> "Charizard-Mega-Y"). */
export interface DexItem { name: string; megaStone: boolean; berry: boolean; megaFor: Record<string, string> }

export interface Dex {
  species: DexSpecies[];
  moves: DexMove[];
  items: DexItem[];
  abilities: string[];
  natures: string[];
  findSpecies(name: string): DexSpecies | undefined;
  findMove(name: string): DexMove | undefined;
  findItem(name: string): DexItem | undefined;
  hasAbility(name: string): boolean;
}

/** The parts of a calculator generation read here. Each table can be iterated and looked up by id. */
interface Table<T> { get(id: string): T | undefined; [Symbol.iterator](): Iterator<T> }
interface RawSpecies { name: string; types?: string[]; baseStats?: StatTable; abilities?: Record<string, string> }
interface RawMove { name: string; type?: string; category?: string; basePower?: number; isZ?: unknown; isMax?: unknown }
interface RawItem { name: string; megaStone?: unknown; isBerry?: boolean }
interface RawGen { species?: Table<RawSpecies>; moves?: Table<RawMove>; items?: Table<RawItem>; abilities?: Table<{ name: string }> }

const iterable = <T>(t: Table<T> | undefined): T[] => {
  try { return t && typeof t[Symbol.iterator] === 'function' ? [...t] : []; } catch { return []; }
};
const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/** Builds the dex from a calculator generation. Missing tables just give empty lists. */
export function buildDex(gen: unknown): Dex {
  const g = (gen ?? {}) as RawGen;
  const species: DexSpecies[] = iterable(g.species).map((s) => ({
    name: s.name,
    types: [...(s.types ?? [])],
    base: { ...(s.baseStats ?? { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }) },
    abilities: Object.values(s.abilities ?? {}).filter(Boolean),
  })).sort(byName);
  const moves: DexMove[] = iterable(g.moves)
    .filter((m) => m.name && m.name !== '(No Move)' && !m.isZ && !m.isMax)
    .map((m) => ({ name: m.name, type: m.type ?? '', category: m.category ?? 'Status', bp: m.basePower ?? 0 }))
    .sort(byName);
  const items: DexItem[] = iterable(g.items).map((i) => ({
    name: i.name, megaStone: !!i.megaStone, berry: !!i.isBerry,
    megaFor: i.megaStone && typeof i.megaStone === 'object' ? { ...(i.megaStone as Record<string, string>) } : {},
  })).sort(byName);
  const abilities = iterable(g.abilities).map((a) => a.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return makeDex(species, moves, items, abilities);
}

/** A dex from ready-made lists (tests, or a future data file). */
export function makeDex(species: DexSpecies[], moves: DexMove[], items: DexItem[], abilities: string[]): Dex {
  const index = <T extends { name: string }>(list: T[]): Map<string, T> => new Map(list.map((x) => [toID(x.name), x]));
  const s = index(species);
  const m = index(moves);
  const i = index(items);
  const a = new Set(abilities.map(toID));
  return {
    species, moves, items, abilities,
    natures: [...Object.keys(NATURES), 'Hardy', 'Docile', 'Serious', 'Bashful', 'Quirky'].sort((x, y) => x.localeCompare(y)),
    findSpecies: (name) => s.get(toID(name)),
    findMove: (name) => m.get(toID(name)),
    findItem: (name) => i.get(toID(name)),
    hasAbility: (name) => a.has(toID(name)),
  };
}

/** "+Atk −SpA" for a nature, "neutral" for the five that change nothing. */
export function natureText(nature: string): string {
  const n = NATURES[nature];
  return n ? `+${STAT_LABEL[n[0]]} −${STAT_LABEL[n[1]]}` : 'neutral';
}

/**
 * Names matching what was typed, best first: an exact match, then names starting with it, then names with a word
 * starting with it, then names containing it. Punctuation and case are ignored ("uturn" finds "U-turn").
 */
export function search<T>(list: readonly T[], query: string, nameOf: (x: T) => string, limit = 40): T[] {
  const q = toID(query);
  if (!q) return list.slice(0, limit);
  const scored: { x: T; rank: number }[] = [];
  for (const x of list) {
    const name = nameOf(x);
    const id = toID(name);
    let rank = -1;
    if (id === q) rank = 0;
    else if (id.startsWith(q)) rank = 1;
    else if (name.toLowerCase().split(/[\s-]+/).some((w) => toID(w).startsWith(q))) rank = 2;
    else if (id.includes(q)) rank = 3;
    if (rank >= 0) scored.push({ x, rank });
  }
  return scored.sort((a, b) => a.rank - b.rank).slice(0, limit).map((s) => s.x);
}

/** Edit distance between two ids, stopping early once it passes `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      row.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

/** The known name closest to a misspelt one ("Flare Blits" -> "Flare Blitz"), or '' when nothing is close. */
export function closest(names: readonly string[], typed: string): string {
  const q = toID(typed);
  if (!q) return '';
  const max = Math.max(1, Math.floor(q.length / 4));
  let best = '';
  let bestD = max + 1;
  for (const name of names) {
    const d = distance(q, toID(name), max);
    if (d < bestD) { best = name; bestD = d; }
  }
  return best;
}
