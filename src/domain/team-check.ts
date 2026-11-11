/**
 * Team checks that need the dex: swapping a Pokémon for another, and the problems shown on each team member's card
 * (unknown names, missing moves, a Mega without its stone, rule limits). They never block anything.
 */
import type { Dex } from './dex.ts';
import { REGULATION } from './regulation.ts';
import { baseSpecies, isMega } from './showdown.ts';
import { toID } from './strings.ts';
import type { PokemonSet } from './types.ts';

/** True when `item` is a Mega Stone that doesn't belong to `species` (or its base form). */
export function stoneMismatch(dex: Dex, item: string, species: string): boolean {
  const stone = dex.findItem(item);
  if (!stone?.megaStone) return false;
  const ids = new Set([toID(species), toID(baseSpecies(species))]);
  return !Object.entries(stone.megaFor).some(([base, mega]) => ids.has(toID(base)) || ids.has(toID(mega)));
}

/**
 * Swaps the Pokémon for another species, keeping what still applies: moves stay (the data has no learnsets), the
 * item stays unless it is another Pokémon's Mega Stone, and the ability stays unless it was the old species' usual
 * one, which becomes the new species' usual one.
 */
export function swapSpecies(mon: PokemonSet, species: string, dex: Dex | null): void {
  const next = species.trim();
  if (!next || toID(next) === toID(mon.species)) { mon.species = next || mon.species; return; }
  if (dex) {
    const oldDefault = dex.findSpecies(mon.species)?.abilities ?? [];
    const newAbilities = dex.findSpecies(next)?.abilities ?? [];
    if (newAbilities.length && (!mon.ability || oldDefault.some((a) => toID(a) === toID(mon.ability))) && !newAbilities.some((a) => toID(a) === toID(mon.ability))) {
      mon.ability = newAbilities[0]!;
    }
    if (mon.item && stoneMismatch(dex, mon.item, next)) mon.item = '';
  }
  mon.species = next;
}

export interface MonIssue {
  /** Which field the problem is in, so the editor can mark it; '' for the Pokémon as a whole. */
  field: 'species' | 'item' | 'ability' | 'moves' | '';
  text: string;
}

/** Problems with each team member, by position. Unknown-name checks need the dex and are skipped without it. */
export function teamIssues(mons: readonly PokemonSet[], dex: Dex | null): MonIssue[][] {
  const megas = mons.filter((m) => isMega(m.species)).length;
  const speciesCount = new Map<string, number>();
  for (const m of mons) speciesCount.set(toID(m.species), (speciesCount.get(toID(m.species)) ?? 0) + 1);
  return mons.map((m) => {
    const out: MonIssue[] = [];
    if (dex && !dex.findSpecies(m.species)) out.push({ field: 'species', text: `Unknown Pokémon “${m.species}”` });
    if (dex && m.item && !dex.findItem(m.item)) out.push({ field: 'item', text: `Unknown item “${m.item}”` });
    if (dex && m.ability && !dex.hasAbility(m.ability)) out.push({ field: 'ability', text: `Unknown ability “${m.ability}”` });
    const unknownMoves = dex ? m.moves.filter((mv) => !dex.findMove(mv)) : [];
    if (unknownMoves.length) out.push({ field: 'moves', text: `Unknown move${unknownMoves.length > 1 ? 's' : ''}: ${unknownMoves.join(', ')}` });
    if (!m.moves.length) out.push({ field: 'moves', text: 'No moves yet' });
    if (m.moves.length > 4) out.push({ field: 'moves', text: `${m.moves.length} moves; only 4 can be used` });
    if ((speciesCount.get(toID(m.species)) ?? 0) > 1) out.push({ field: 'species', text: `${m.species} is on the team twice; gameplans can't tell them apart` });
    if (isMega(m.species)) {
      if (megas > REGULATION.maxMegas) out.push({ field: 'species', text: `${megas} Megas on the team; ${REGULATION.label} allows ${REGULATION.maxMegas}` });
      if (dex && m.item && dex.findItem(m.item) && stoneMismatch(dex, m.item, m.species)) out.push({ field: 'item', text: `${m.item} isn't ${baseSpecies(m.species)}'s Mega Stone` });
      else if (dex && (!m.item || !dex.findItem(m.item)?.megaStone)) out.push({ field: 'item', text: `${m.species} needs its Mega Stone` });
    }
    return out;
  });
}
