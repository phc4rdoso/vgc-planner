/**
 * A small stand-in for @smogon/calc with the same surface the app uses, so simulation tests are
 * deterministic and need no network or install. Damage is a simple formula, not the real one.
 */
import type { CalcGeneration, CalcLib, CalcMove, CalcPokemon, FieldOptions } from '../../src/domain/simulation/calc-types.ts';
import type { StatTable } from '../../src/domain/types.ts';

export const SPECIES: Record<string, StatTable> = {
  Garchomp: { hp: 108, atk: 130, def: 95, spa: 80, spd: 85, spe: 102 },
  Incineroar: { hp: 95, atk: 115, def: 90, spa: 80, spd: 90, spe: 60 },
  Rillaboom: { hp: 100, atk: 125, def: 90, spa: 60, spd: 70, spe: 85 },
  Kingambit: { hp: 100, atk: 135, def: 120, spa: 60, spd: 85, spe: 50 },
  Aerodactyl: { hp: 80, atk: 105, def: 65, spa: 60, spd: 75, spe: 130 },
  'Aerodactyl-Mega': { hp: 80, atk: 135, def: 85, spa: 70, spd: 95, spe: 150 },
  'Garchomp-Mega': { hp: 108, atk: 170, def: 115, spa: 120, spd: 95, spe: 92 },
  Flutter: { hp: 60, atk: 60, def: 60, spa: 60, spd: 60, spe: 60 },
};

export const TYPES: Record<string, string[]> = {
  Garchomp: ['Dragon', 'Ground'], Incineroar: ['Fire', 'Dark'], Rillaboom: ['Grass'], Kingambit: ['Dark', 'Steel'],
  Aerodactyl: ['Rock', 'Flying'], 'Aerodactyl-Mega': ['Rock', 'Flying'], Flutter: ['Ghost', 'Fairy'], 'Garchomp-Mega': ['Dragon', 'Ground'],
};

/** Mega Stones the stand-in knows, by item id. */
const STONES: Record<string, Record<string, string>> = { aerodactylite: { Aerodactyl: 'Aerodactyl-Mega' }, garchompite: { Garchomp: 'Garchomp-Mega' } };
/** What the calculator would give a species when no ability is passed. */
export const DEFAULT_ABILITY: Record<string, string> = { Aerodactyl: 'Pressure', 'Aerodactyl-Mega': 'Tough Claws', Garchomp: 'Rough Skin', 'Garchomp-Mega': 'Sand Force' };

interface MoveData { name: string; bp: number; category: string; target: string; priority: number; type: string }
const mv = (name: string, bp: number, category: string, target: string, priority = 0, type = 'Normal'): MoveData => ({ name, bp, category, target, priority, type });
export const MOVES: Record<string, MoveData> = {
  earthquake: mv('Earthquake', 100, 'Physical', 'allAdjacent'),
  rockslide: mv('Rock Slide', 75, 'Physical', 'allAdjacentFoes'),
  fakeout: mv('Fake Out', 40, 'Physical', 'normal', 3),
  flareblitz: mv('Flare Blitz', 120, 'Physical', 'normal'),
  protect: mv('Protect', 0, 'Status', 'self', 4),
  swordsdance: mv('Swords Dance', 0, 'Status', 'self'),
  tailwind: mv('Tailwind', 0, 'Status', 'allySide'),
  trickroom: mv('Trick Room', 0, 'Status', 'all', -7),
  closecombat: mv('Close Combat', 120, 'Physical', 'normal'),
  helpinghand: mv('Helping Hand', 0, 'Status', 'adjacentAlly', 5),
  screech: mv('Screech', 0, 'Status', 'normal'),
  dracometeor: mv('Draco Meteor', 130, 'Special', 'normal'),
  uturn: mv('U-turn', 70, 'Physical', 'normal', 0, 'Bug'),
  makeitrain: mv('Make It Rain', 120, 'Special', 'allAdjacentFoes', 0, 'Steel'),
  grassyglide: mv('Grassy Glide', 55, 'Physical', 'normal', 0, 'Grass'),
  bravebird: mv('Brave Bird', 120, 'Physical', 'any', 0, 'Flying'),
  quickguard: mv('Quick Guard', 0, 'Status', 'allySide', 3, 'Fighting'),
  psychicterrain: mv('Psychic Terrain', 0, 'Status', 'all', 0, 'Psychic'),
  willowisp: mv('Will-O-Wisp', 0, 'Status', 'normal', 0, 'Fire'),
  thunderwave: mv('Thunder Wave', 0, 'Status', 'normal', 0, 'Electric'),
  spore: mv('Spore', 0, 'Status', 'normal', 0, 'Grass'),
  toxic: mv('Toxic', 0, 'Status', 'normal', 0, 'Poison'),
  nuzzle: mv('Nuzzle', 20, 'Physical', 'normal', 0, 'Electric'),
};

export interface CalcCall { attacker: string; defender: string; move: string; field: FieldOptions; attackerBoostAtk: number; defenderHP: number; attackerStatus: string; attackerAbility: string }

const idOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const mult = (b: number): number => (b >= 0 ? (2 + b) / 2 : 2 / (2 - b));

interface StubPokemon extends CalcPokemon { name: string; status: string }

export function makeStubCalc(options: { champions?: boolean } = {}): { lib: CalcLib; calls: CalcCall[] } {
  const champions = options.champions ?? true;
  const calls: CalcCall[] = [];
  const gen9: CalcGeneration = {
    num: 9,
    moves: { get: (id) => MOVES[id] },
    items: { get: (id) => (STONES[id] ? { megaStone: STONES[id] } : undefined) },
  };
  const gen0: CalcGeneration = { ...gen9, num: 0 };

  class Pokemon implements StubPokemon {
    name: string; species: { baseStats: StatTable }; rawStats: StatTable; stats: StatTable; types: string[]; status: string; ability: string;
    boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }; originalCurHP = 0;
    constructor(gen: CalcGeneration, name: string, o: Record<string, unknown> = {}) {
      const base = SPECIES[name];
      if (!base) throw new Error(`unknown species ${name}`);
      this.name = name; this.species = { baseStats: base }; this.types = TYPES[name] ?? []; this.status = String(o.status ?? '');
      this.ability = String(o.ability ?? DEFAULT_ABILITY[name] ?? '');
      const ev = (o.evs ?? {}) as Partial<StatTable>;
      this.rawStats = gen.num === 0
        ? { hp: base.hp + (ev.hp ?? 0) + 75, atk: Math.floor((base.atk + (ev.atk ?? 0) + 20) * (o.nature === 'Adamant' ? 1.1 : 1)), def: base.def + 20, spa: base.spa + 20, spd: base.spd + 20, spe: base.spe + 20 }
        : { hp: base.hp * 2 + 110, atk: base.atk * 2, def: base.def * 2, spa: base.spa * 2, spd: base.spd * 2, spe: base.spe * 2 };
      this.stats = { ...this.rawStats };
    }
  }
  class Move implements CalcMove {
    name: string; priority: number; category: string; target: string; bp: number; type: string;
    constructor(_gen: CalcGeneration, name: string) {
      const d = MOVES[idOf(name)] ?? mv(name, 0, 'Status', 'normal');
      this.name = d.name; this.priority = d.priority; this.category = d.category; this.target = d.target; this.bp = d.bp; this.type = d.type;
    }
  }
  class Field { gameType: string; attackerSide: FieldOptions['attackerSide']; constructor(o: FieldOptions) { Object.assign(this, o); this.gameType = o.gameType; this.attackerSide = o.attackerSide; } }

  const lib: CalcLib = {
    Pokemon: Pokemon as unknown as CalcLib['Pokemon'],
    Move,
    Field: Field as unknown as CalcLib['Field'],
    Generations: {
      get(n: number) {
        if (n === 0) { if (!champions) throw new Error('no gen 0'); return gen0; }
        if (n === 9) return gen9;
        throw new Error('unsupported generation');
      },
    },
    calculate(_gen, attacker, defender, move, field) {
      const att = attacker as StubPokemon; const def = defender as StubPokemon; const f = field as unknown as FieldOptions;
      calls.push({ attacker: att.name, defender: def.name, move: move.name ?? '', field: f, attackerBoostAtk: att.boosts.atk, defenderHP: def.originalCurHP, attackerStatus: att.status, attackerAbility: att.ability ?? '' });
      if (move.name === 'Earthquake' && def.name === 'Aerodactyl') return { damage: 0 };
      const bp = (MOVES[idOf(move.name ?? '')]?.bp) ?? 0;
      let base = Math.floor((bp * att.stats.atk * mult(att.boosts.atk)) / def.stats.def / 3);
      if (att.status === 'brn' && move.category === 'Physical') base = Math.floor(base / 2);
      if (f.gameType === 'Doubles' && /allAdjacent/.test(move.target ?? '')) base = Math.floor(base * 0.75);
      if (f.attackerSide.isHelpingHand) base = Math.floor(base * 1.5);
      return { damage: Array.from({ length: 16 }, (_, i) => Math.floor((base * (85 + i)) / 100)) };
    },
  };
  return { lib, calls };
}
