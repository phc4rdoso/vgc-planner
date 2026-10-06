import { REGULATION } from './regulation.ts';
import type { PokemonSet } from './types.ts';

/** Parses a Showdown team paste. Unknown lines are preserved in `extra`. */
export function parseShowdown(text: string | null | undefined): PokemonSet[] {
  const blocks = String(text ?? '')
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const mons: PokemonSet[] = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length && /^===.*===$/.test(lines[0]!)) lines.shift(); // "=== [format] Folder/Name ==="
    const first = lines.shift();
    if (!first) continue;
    const mon: PokemonSet = {
      nickname: '', species: '', gender: '', item: '', ability: '', level: null,
      nature: '', evs: '', ivs: '', moves: [], extra: [],
    };
    let namePart = first;
    const at = first.indexOf(' @ ');
    if (at >= 0) {
      namePart = first.slice(0, at).trim();
      mon.item = first.slice(at + 3).trim();
    } else if (first.endsWith(' @')) {
      namePart = first.slice(0, -2).trim();
    }
    const gender = namePart.match(/\s\((M|F)\)$/);
    if (gender?.index !== undefined) {
      mon.gender = gender[1]!;
      namePart = namePart.slice(0, gender.index).trim();
    }
    const nick = namePart.match(/^(.*?)\s\((.+)\)$/);
    if (nick) {
      mon.nickname = nick[1]!.trim();
      mon.species = nick[2]!.trim();
    } else {
      mon.species = namePart;
    }
    for (const line of lines) {
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^Ability:\s*(.+)$/i))) mon.ability = m[1]!.trim();
      else if ((m = line.match(/^Level:\s*(\d+)/i))) mon.level = Number(m[1]);
      else if ((m = line.match(/^EVs?:\s*(.+)$/i))) mon.evs = m[1]!.trim();
      else if ((m = line.match(/^IVs?:\s*(.+)$/i))) mon.ivs = m[1]!.trim();
      else if ((m = line.match(/^(\w+)\s+Nature$/i))) mon.nature = m[1]!;
      else if (/^[-–•]\s*/.test(line)) {
        const move = line.replace(/^[-–•]\s*/, '').trim();
        if (move) mon.moves.push(move);
      } else mon.extra.push(line);
    }
    if (mon.species) mons.push(mon);
  }
  return mons;
}

/** True for "Aerodactyl-Mega", "Charizard-Mega-Y", "Absol-Mega-Z". */
export const isMega = (species: string | null | undefined): boolean => /-mega(-[xyz])?$/i.test(species ?? '') || /-mega-/i.test(species ?? '');

/** Soft rule checks shown to the user; they never block anything. */
export function teamWarnings(mons: readonly PokemonSet[]): string[] {
  const out: string[] = [];
  if (mons.length > REGULATION.teamSize) out.push(`This paste has ${mons.length} Pokémon; a team has at most ${REGULATION.teamSize}.`);
  const megas = mons.filter((m) => isMega(m.species)).length;
  if (megas > REGULATION.maxMegas) out.push(`${megas} megas found; ${REGULATION.label} allows at most ${REGULATION.maxMegas}.`);
  return out;
}

/** The base form of a Mega ("Garchomp-Mega-Z" -> "Garchomp"); other names unchanged. */
export const baseSpecies = (species: string): string => species.replace(/-Mega(-[XYZ])?$/i, '');
