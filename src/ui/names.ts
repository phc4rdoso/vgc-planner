import { baseSpecies, isMega } from '../domain/showdown.ts';
import type { BattleState } from '../domain/simulation/state.ts';
import { SIDES } from '../domain/types.ts';
import type { Side } from '../domain/types.ts';

/**
 * How a Pokémon is shown: its current form. Plans refer to Pokémon by the name in the paste (which may be the Mega,
 * e.g. "Raichu-Mega-Y"), but until it Mega Evolves in the branch it is shown, and simulated, as its base form.
 */
export function formOf(st: BattleState | null | undefined, side: Side, key: string): string {
  if (!key) return key;
  return st?.mons[side][key]?.species ?? (isMega(key) ? baseSpecies(key) : key);
}

/** Every paste name that is currently shown differently (a Mega listed in the paste that hasn't Mega Evolved). */
export function renamedForms(st: BattleState | null | undefined, names: Partial<Record<Side, readonly string[]>> = {}): Map<string, string> {
  const out = new Map<string, string>();
  for (const side of SIDES) {
    const keys = st ? Object.keys(st.mons[side]) : (names[side] ?? []);
    for (const key of keys) {
      const form = formOf(st, side, key);
      if (form !== key) out.set(key, form);
    }
  }
  return out;
}

/** Rewrites paste names inside a message ("Raichu-Mega-Y fainted…") to how they are shown. */
export function showNames(text: string, forms: ReadonlyMap<string, string>): string {
  let out = text;
  // Longest first, so "Charizard-Mega-X" is replaced before a shorter name it contains.
  for (const key of [...forms.keys()].sort((a, b) => b.length - a.length)) out = out.split(key).join(forms.get(key)!);
  return out;
}
