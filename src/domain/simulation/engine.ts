import { toID } from '../strings.ts';
import { BOOST_KEYS } from '../stats.ts';
import type { StatTable } from '../types.ts';
import type { CalcGeneration, CalcLib, FieldOptions } from './calc-types.ts';
import type { MonState } from './state.ts';
import { statsOf } from './state.ts';

export interface MoveInfo {
  exists: boolean;
  name: string;
  priority: number;
  category: string;
  /** Move type, e.g. "Electric". */
  type: string;
  /** Showdown target type: "normal", "allAdjacent", "allAdjacentFoes", "self", ... */
  target: string;
}

/** What the simulator needs from the damage calculator. */
export interface CalcEngine {
  /** True when the loaded build has a Champions mode (checked by its stat formula). */
  readonly native: boolean;
  baseStats(species: string): StatTable | null;
  /** The species' types, e.g. ["Fire", "Dark"]; empty when unknown. */
  typesOf(species: string): string[];
  /** The ability the calculator gives the species by default (a Mega's only ability, a base form's first one); '' when unknown. */
  defaultAbility(species: string): string;
  moveInfo(name: string): MoveInfo;
  megaOf(species: string, item: string): string | null;
  /** The 16 damage rolls (summed across hits for multi-hit moves). */
  damage(attacker: MonState, defender: MonState, moveName: string, field: FieldOptions): number[];
}

/** Calculator results can be a number, a list of rolls, or a list of lists (multi-hit). Normalises to one list of rolls. */
export function rollsOf(damage: unknown): number[] {
  if (typeof damage === 'number') return [damage];
  if (!Array.isArray(damage) || damage.length === 0) return [0];
  if (damage.every((x): x is number => typeof x === 'number')) return damage.slice();
  const lists = damage.map(rollsOf);
  const longest = Math.max(...lists.map((l) => l.length));
  return Array.from({ length: longest }, (_, i) => lists.reduce((sum, l) => sum + (l[i] ?? l[l.length - 1] ?? 0), 0));
}

/**
 * Wraps the loaded calculator. It looks for the Champions generation and confirms it by checking the stat
 * formula (Garchomp, Adamant, 32 Atk points -> HP 183, Atk 200). If the build has no Champions mode it falls
 * back to Gen 9 rules; stats are always computed by this app, so Champions stats stay correct either way.
 */
export function createEngine(lib: CalcLib): CalcEngine {
  const getGen = (n: number): CalcGeneration | null => {
    try { return lib.Generations ? lib.Generations.get(n) : null; } catch { return null; }
  };
  const looksLikeChampions = (gen: CalcGeneration | null): gen is CalcGeneration => {
    if (!gen) return false;
    try {
      const p = new lib.Pokemon(gen, 'Garchomp', { level: 50, nature: 'Adamant', evs: { atk: 32 } });
      return p.rawStats.atk === 200 && p.rawStats.hp === 183;
    } catch { return false; }
  };

  let gen: CalcGeneration | null = null;
  let native = false;
  for (const n of [0, 10]) {
    const candidate = getGen(n);
    if (looksLikeChampions(candidate)) { gen = candidate; native = true; break; }
  }
  gen ??= getGen(9);
  if (!gen) throw new Error('The calculator loaded but no generation data was found.');
  const generation = gen;

  const baseCache = new Map<string, StatTable | null>();
  const typeCache = new Map<string, string[]>();
  const buildPoke = (mon: MonState): InstanceType<CalcLib['Pokemon']> => {
    const options: Record<string, unknown> = { level: 50, nature: mon.set.nature || 'Serious', evs: { ...mon.sp }, boosts: { ...mon.boosts } };
    if (mon.set.item) options.item = mon.set.item;
    // The calculator applies burn's Attack cut (and Guts / Facade) from the status.
    if (mon.status) options.status = mon.status;
    // The current form's ability: the base form's until Mega Evolution, then the Mega's.
    if (mon.ability) options.ability = mon.ability;
    const p = new lib.Pokemon(generation, mon.species, options);
    const stats = statsOf(mon);
    p.rawStats = { ...stats };
    p.stats = { ...stats };
    p.originalCurHP = mon.hp;
    for (const k of BOOST_KEYS) p.boosts[k] = mon.boosts[k];
    return p;
  };

  return {
    native,
    baseStats(species) {
      if (!baseCache.has(species)) {
        try { baseCache.set(species, { ...new lib.Pokemon(generation, species, { level: 50 }).species.baseStats }); }
        catch { baseCache.set(species, null); }
      }
      return baseCache.get(species) ?? null;
    },
    typesOf(species) {
      if (!typeCache.has(species)) {
        try { typeCache.set(species, [...(new lib.Pokemon(generation, species, { level: 50 }).types ?? [])]); }
        catch { typeCache.set(species, []); }
      }
      return typeCache.get(species) ?? [];
    },
    defaultAbility(species) {
      try { return String(new lib.Pokemon(generation, species, { level: 50 }).ability ?? ''); }
      catch { return ''; }
    },
    moveInfo(name) {
      try {
        const known = generation.moves ? generation.moves.get(toID(name)) !== undefined : true;
        const m = new lib.Move(generation, name);
        return { exists: known, name: m.name || name, priority: m.priority ?? 0, category: m.category ?? 'Status', type: m.type ?? '', target: m.target ?? 'normal' };
      } catch {
        return { exists: false, name, priority: 0, category: 'Status', type: '', target: 'normal' };
      }
    },
    megaOf(species, item) {
      try {
        const stone = generation.items?.get(toID(item))?.megaStone;
        if (!stone) return null;
        return typeof stone === 'string' ? stone : (stone[species] ?? null);
      } catch { return null; }
    },
    damage(attacker, defender, moveName, field) {
      const result = lib.calculate(generation, buildPoke(attacker), buildPoke(defender), new lib.Move(generation, moveName), new lib.Field(field));
      return rollsOf(result.damage);
    },
  };
}
