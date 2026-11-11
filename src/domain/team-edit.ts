/**
 * Editing one Pokémon of a team without touching the paste by hand: the paste is parsed, the Pokémon changed and
 * the paste written back, so the paste stays the team's single source of truth.
 */
import { formatShowdown, parseShowdown } from './showdown.ts';
import { emptyStatTable, STAT_KEYS, STAT_LABEL, statPoints } from './stats.ts';
import type { PokemonSet, StatKey, StatTable } from './types.ts';

/** Champions Stat Points: at most this many in one stat, and this many in all. */
export const SP_MAX_STAT = 32;
export const SP_MAX_TOTAL = 66;

export type MonField = 'species' | 'nickname' | 'item' | 'ability' | 'nature';

/** The paste with the Pokémon at `index` changed by `edit`. Unchanged paste when there is no such Pokémon. */
export function editMon(paste: string, index: number, edit: (mon: PokemonSet) => void): string {
  const mons = parseShowdown(paste);
  const mon = mons[index];
  if (!mon) return paste;
  edit(mon);
  return formatShowdown(mons);
}

/** Sets a text field; trims it. */
export function setField(mon: PokemonSet, field: MonField, value: string): void {
  mon[field] = value.trim();
}

/** Sets move slot `slot` (0-3); an empty value clears the slot. */
export function setMove(mon: PokemonSet, slot: number, value: string): void {
  const moves = [0, 1, 2, 3].map((i) => mon.moves[i] ?? '');
  moves[slot] = value.trim();
  // Moves past the fourth (rare, but a paste can have them) stay where they were.
  mon.moves = [...moves, ...mon.moves.slice(4)].filter(Boolean);
}

/** The Pokémon's Stat Points (converted from EVs when the paste has real EVs). */
export const spOf = (mon: PokemonSet): StatTable => statPoints(mon)?.sp ?? emptyStatTable();

export const spTotal = (sp: StatTable): number => STAT_KEYS.reduce((sum, k) => sum + sp[k], 0);

/** "32 HP / 2 Atk / 32 Spe", the way Champions pastes write Stat Points; '' when none are set. */
export const spLine = (sp: StatTable): string => STAT_KEYS.filter((k) => sp[k] > 0).map((k) => `${sp[k]} ${STAT_LABEL[k]}`).join(' / ');

/** How many points `key` can hold given the other stats: never above 32 or past a 66 total. */
export function spRoom(sp: StatTable, key: StatKey): number {
  return Math.max(0, Math.min(SP_MAX_STAT, SP_MAX_TOTAL - (spTotal(sp) - sp[key])));
}

/** Sets one stat's points, clamped to what fits, and writes the spread as Stat Points. */
export function setStatPoints(mon: PokemonSet, key: StatKey, value: number): void {
  const sp = spOf(mon);
  sp[key] = Math.max(0, Math.min(spRoom(sp, key), Math.round(Number.isFinite(value) ? value : 0)));
  mon.evs = spLine(sp);
}

/** Replaces the whole spread (used by the presets); each stat clamped, the total cut at 66 in stat order. */
export function setSpread(mon: PokemonSet, spread: Partial<StatTable>): void {
  const sp = emptyStatTable();
  for (const k of STAT_KEYS) sp[k] = Math.max(0, Math.min(spRoom(sp, k), Math.round(spread[k] ?? 0)));
  mon.evs = spLine(sp);
}
