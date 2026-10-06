import type { BoostKey, PokemonSet, StatKey, StatTable } from './types.ts';

export const STAT_KEYS: readonly StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
export const BOOST_KEYS: readonly BoostKey[] = ['atk', 'def', 'spa', 'spd', 'spe'] as const;
export const STAT_LABEL: Readonly<Record<StatKey, string>> = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

/** [raised stat, lowered stat]. Neutral natures are absent. */
const NATURES: Readonly<Record<string, readonly [BoostKey, BoostKey]>> = {
  Lonely: ['atk', 'def'], Brave: ['atk', 'spe'], Adamant: ['atk', 'spa'], Naughty: ['atk', 'spd'],
  Bold: ['def', 'atk'], Relaxed: ['def', 'spe'], Impish: ['def', 'spa'], Lax: ['def', 'spd'],
  Timid: ['spe', 'atk'], Hasty: ['spe', 'def'], Jolly: ['spe', 'spa'], Naive: ['spe', 'spd'],
  Modest: ['spa', 'atk'], Mild: ['spa', 'def'], Quiet: ['spa', 'spe'], Rash: ['spa', 'spd'],
  Calm: ['spd', 'atk'], Gentle: ['spd', 'def'], Sassy: ['spd', 'spe'], Careful: ['spd', 'spa'],
};

const SPREAD_ALIASES: Readonly<Record<string, StatKey>> = {
  hp: 'hp', atk: 'atk', attack: 'atk', def: 'def', defense: 'def', spa: 'spa', spatk: 'spa', satk: 'spa',
  spd: 'spd', spdef: 'spd', sdef: 'spd', spe: 'spe', speed: 'spe',
};

export const emptyStatTable = (): StatTable => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });

/** "32 HP / 2 Def / 32 Spe" -> numbers per stat. Unknown labels are ignored. */
export function readSpread(text: string | null | undefined): StatTable {
  const out = emptyStatTable();
  for (const part of String(text ?? '').split('/')) {
    const m = part.trim().match(/^(\d+)\s*([A-Za-z]+)$/);
    const key = m ? SPREAD_ALIASES[m[2]!.toLowerCase()] : undefined;
    if (m && key) out[key] = Number(m[1]);
  }
  return out;
}

export interface StatPointReading {
  sp: StatTable;
  /** True when the numbers could not be Stat Points and were converted from real EVs. */
  converted: boolean;
}

/**
 * Champions pastes label Stat Points as "EVs:" (max 32 per stat, 66 total). If the numbers cannot be
 * Stat Points (a stat above 32 or a total above 66) they are treated as real EVs and converted with the
 * game's rule: 4 EVs for the first point, 8 for each one after.
 */
export function statPoints(mon: Pick<PokemonSet, 'evs'> | null | undefined): StatPointReading | null {
  if (!mon?.evs) return null;
  const raw = readSpread(mon.evs);
  const values = STAT_KEYS.map((k) => raw[k]);
  if (values.every((v) => v <= 32) && values.reduce((a, b) => a + b, 0) <= 66) return { sp: raw, converted: false };
  const sp = emptyStatTable();
  for (const k of STAT_KEYS) sp[k] = raw[k] <= 0 ? 0 : Math.min(32, Math.floor((raw[k] + 4) / 8));
  return { sp, converted: true };
}

export const spreadText = (sp: StatTable): string =>
  STAT_KEYS.filter((k) => sp[k] > 0).map((k) => `${sp[k]} ${STAT_LABEL[k]}`).join(' / ') || 'none';

/** Level 50, 31 IVs: HP = base + SP + 75, other = floor((base + SP + 20) * nature). Integer math avoids float drift. */
export function calcStats(base: StatTable, sp: StatTable, nature: string): StatTable {
  const [up, down] = NATURES[nature] ?? [];
  const out: StatTable = { hp: base.hp + sp.hp + 75, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  for (const k of BOOST_KEYS) {
    const raw = base[k] + sp[k] + 20;
    out[k] = k === up ? Math.floor((raw * 11) / 10) : k === down ? Math.floor((raw * 9) / 10) : raw;
  }
  return out;
}
