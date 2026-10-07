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
  Smeargle: { hp: 55, atk: 20, def: 35, spa: 20, spd: 45, spe: 75 },
  Sinistcha: { hp: 71, atk: 60, def: 106, spa: 121, spd: 80, spe: 70 },
  Pelipper: { hp: 60, atk: 50, def: 100, spa: 95, spd: 70, spe: 65 },
  Charizard: { hp: 78, atk: 84, def: 78, spa: 109, spd: 85, spe: 100 },
  'Charizard-Mega-Y': { hp: 78, atk: 104, def: 78, spa: 159, spd: 115, spe: 100 },
  Tyranitar: { hp: 100, atk: 134, def: 110, spa: 95, spd: 100, spe: 61 },
  'Tyranitar-Mega': { hp: 100, atk: 164, def: 150, spa: 95, spd: 120, spe: 71 },
};

export const TYPES: Record<string, string[]> = {
  Garchomp: ['Dragon', 'Ground'], Incineroar: ['Fire', 'Dark'], Rillaboom: ['Grass'], Kingambit: ['Dark', 'Steel'],
  Aerodactyl: ['Rock', 'Flying'], 'Aerodactyl-Mega': ['Rock', 'Flying'], Flutter: ['Ghost', 'Fairy'], 'Garchomp-Mega': ['Dragon', 'Ground'],
  Smeargle: ['Normal'], Sinistcha: ['Grass', 'Ghost'], Pelipper: ['Water', 'Flying'], Charizard: ['Fire', 'Flying'], 'Charizard-Mega-Y': ['Fire', 'Flying'],
  Tyranitar: ['Rock', 'Dark'], 'Tyranitar-Mega': ['Rock', 'Dark'],
};

/** A slice of the type chart (attacking type id -> defending type -> multiplier); anything else is neutral. */
const CHART: Record<string, Record<string, number>> = {
  fighting: { Normal: 2, Dark: 2, Steel: 2, Rock: 2, Ice: 2, Ghost: 0, Fairy: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Poison: 0.5 },
  rock: { Fire: 2, Flying: 2, Bug: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Steel: 0.5 },
};

/** Mega Stones the stand-in knows, by item id. */
const STONES: Record<string, Record<string, string>> = {
  aerodactylite: { Aerodactyl: 'Aerodactyl-Mega' }, garchompite: { Garchomp: 'Garchomp-Mega' },
  charizarditey: { Charizard: 'Charizard-Mega-Y' }, tyranitarite: { Tyranitar: 'Tyranitar-Mega' },
};
/** What the calculator would give a species when no ability is passed. */
export const DEFAULT_ABILITY: Record<string, string> = {
  Aerodactyl: 'Pressure', 'Aerodactyl-Mega': 'Tough Claws', Garchomp: 'Rough Skin', 'Garchomp-Mega': 'Sand Force',
  Charizard: 'Blaze', 'Charizard-Mega-Y': 'Drought', Tyranitar: 'Sand Stream', 'Tyranitar-Mega': 'Sand Stream',
};

interface MoveData { name: string; bp: number; category: string; target: string; priority: number; type: string; contact?: boolean; sound?: boolean; recoil?: [number, number]; drain?: [number, number]; multihit?: boolean }
const mv = (name: string, bp: number, category: string, target: string, priority = 0, type = 'Normal', extra: Partial<MoveData> = {}): MoveData =>
  ({ name, bp, category, target, priority, type, ...extra });
const contact = { contact: true };
export const MOVES: Record<string, MoveData> = {
  earthquake: mv('Earthquake', 100, 'Physical', 'allAdjacent'),
  rockslide: mv('Rock Slide', 75, 'Physical', 'allAdjacentFoes'),
  fakeout: mv('Fake Out', 40, 'Physical', 'normal', 3, 'Normal', contact),
  flareblitz: mv('Flare Blitz', 120, 'Physical', 'normal', 0, 'Fire', { contact: true, recoil: [33, 100] }),
  protect: mv('Protect', 0, 'Status', 'self', 4),
  swordsdance: mv('Swords Dance', 0, 'Status', 'self'),
  tailwind: mv('Tailwind', 0, 'Status', 'allySide'),
  trickroom: mv('Trick Room', 0, 'Status', 'all', -7),
  closecombat: mv('Close Combat', 120, 'Physical', 'normal', 0, 'Fighting', contact),
  helpinghand: mv('Helping Hand', 0, 'Status', 'adjacentAlly', 5),
  screech: mv('Screech', 0, 'Status', 'normal'),
  dracometeor: mv('Draco Meteor', 130, 'Special', 'normal'),
  uturn: mv('U-turn', 70, 'Physical', 'normal', 0, 'Bug', contact),
  makeitrain: mv('Make It Rain', 120, 'Special', 'allAdjacentFoes', 0, 'Steel'),
  grassyglide: mv('Grassy Glide', 55, 'Physical', 'normal', 0, 'Grass'),
  bravebird: mv('Brave Bird', 120, 'Physical', 'any', 0, 'Flying'),
  quickguard: mv('Quick Guard', 0, 'Status', 'allySide', 3, 'Fighting'),
  psychicterrain: mv('Psychic Terrain', 0, 'Status', 'all', 0, 'Psychic'),
  willowisp: mv('Will-O-Wisp', 0, 'Status', 'normal', 0, 'Fire'),
  thunderwave: mv('Thunder Wave', 0, 'Status', 'normal', 0, 'Electric'),
  spore: mv('Spore', 0, 'Status', 'normal', 0, 'Grass'),
  toxic: mv('Toxic', 0, 'Status', 'normal', 0, 'Poison'),
  nuzzle: mv('Nuzzle', 20, 'Physical', 'normal', 0, 'Electric', contact),
  knockoff: mv('Knock Off', 65, 'Physical', 'normal', 0, 'Dark', contact),
  gigadrain: mv('Giga Drain', 75, 'Special', 'normal', 0, 'Grass', { drain: [1, 2] }),
  ragepowder: mv('Rage Powder', 0, 'Status', 'self', 2, 'Bug'),
  followme: mv('Follow Me', 0, 'Status', 'self', 2),
  wideguard: mv('Wide Guard', 0, 'Status', 'allySide', 3, 'Rock'),
  sandstorm: mv('Sandstorm', 0, 'Status', 'all', 0, 'Rock'),
  grassyterrain: mv('Grassy Terrain', 0, 'Status', 'all', 0, 'Grass'),
  bellydrum: mv('Belly Drum', 0, 'Status', 'self'),
  aquajet: mv('Aqua Jet', 40, 'Physical', 'normal', 1, 'Water', contact),
  solarbeam: mv('Solar Beam', 120, 'Special', 'normal', 0, 'Grass'),
  electroshot: mv('Electro Shot', 130, 'Special', 'normal', 0, 'Electric'),
  fly: mv('Fly', 90, 'Physical', 'any', 0, 'Flying', contact),
  feint: mv('Feint', 30, 'Physical', 'normal', 2),
  suckerpunch: mv('Sucker Punch', 70, 'Physical', 'normal', 1, 'Dark', contact),
  ragefist: mv('Rage Fist', 50, 'Physical', 'normal', 0, 'Ghost', contact),
  lastrespects: mv('Last Respects', 50, 'Physical', 'normal', 0, 'Ghost'),
  stompingtantrum: mv('Stomping Tantrum', 75, 'Physical', 'normal', 0, 'Ground', contact),
  payback: mv('Payback', 50, 'Physical', 'normal', 0, 'Dark', contact),
  sunnyday: mv('Sunny Day', 0, 'Status', 'all', 0, 'Fire'),
  raindance: mv('Rain Dance', 0, 'Status', 'all', 0, 'Water'),
  auroraveil: mv('Aurora Veil', 0, 'Status', 'allySide', 0, 'Ice'),
  beatup: mv('Beat Up', 0, 'Physical', 'normal', 0, 'Dark'),
  hyperbeam: mv('Hyper Beam', 150, 'Special', 'normal'),
  recover: mv('Recover', 0, 'Status', 'self', 0, 'Normal'),
  synthesis: mv('Synthesis', 0, 'Status', 'self', 0, 'Grass'),
  lifedew: mv('Life Dew', 0, 'Status', 'allies', 0, 'Water'),
  wish: mv('Wish', 0, 'Status', 'self', 0, 'Normal'),
  painsplit: mv('Pain Split', 0, 'Status', 'normal', 0, 'Normal'),
  rest: mv('Rest', 0, 'Status', 'self', 0, 'Psychic'),
  substitute: mv('Substitute', 0, 'Status', 'self', 0, 'Normal'),
  haze: mv('Haze', 0, 'Status', 'all', 0, 'Ice'),
  stealthrock: mv('Stealth Rock', 0, 'Status', 'foeSide', 0, 'Rock'),
  spikes: mv('Spikes', 0, 'Status', 'foeSide', 0, 'Ground'),
  defog: mv('Defog', 0, 'Status', 'normal', 0, 'Flying'),
  gravity: mv('Gravity', 0, 'Status', 'all', 0, 'Psychic'),
  taunt: mv('Taunt', 0, 'Status', 'normal', 0, 'Dark'),
  encore: mv('Encore', 0, 'Status', 'normal', 0, 'Normal'),
  disable: mv('Disable', 0, 'Status', 'normal', 0, 'Normal'),
  yawn: mv('Yawn', 0, 'Status', 'normal', 0, 'Normal'),
  perishsong: mv('Perish Song', 0, 'Status', 'all', 0, 'Normal'),
  leechseed: mv('Leech Seed', 0, 'Status', 'normal', 0, 'Grass'),
  destinybond: mv('Destiny Bond', 0, 'Status', 'self', 0, 'Ghost'),
  allyswitch: mv('Ally Switch', 0, 'Status', 'self', 2, 'Psychic'),
  afteryou: mv('After You', 0, 'Status', 'normal', 0, 'Normal'),
  quash: mv('Quash', 0, 'Status', 'normal', 0, 'Dark'),
  instruct: mv('Instruct', 0, 'Status', 'normal', 0, 'Psychic'),
  skillswap: mv('Skill Swap', 0, 'Status', 'normal', 0, 'Psychic'),
  counter: mv('Counter', 0, 'Physical', 'scripted', -5, 'Fighting', contact),
  pollenpuff: mv('Pollen Puff', 90, 'Special', 'normal', 0, 'Bug'),
  brickbreak: mv('Brick Break', 75, 'Physical', 'normal', 0, 'Fighting', contact),
  clearsmog: mv('Clear Smog', 50, 'Special', 'normal', 0, 'Poison'),
  rapidspin: mv('Rapid Spin', 50, 'Physical', 'normal', 0, 'Normal', contact),
  hypervoice: mv('Hyper Voice', 90, 'Special', 'allAdjacentFoes', 0, 'Normal', { sound: true }),
  swagger: mv('Swagger', 0, 'Status', 'normal'),
  chillingwater: mv('Chilling Water', 50, 'Special', 'normal', 0, 'Water'),
  meteormash: mv('Meteor Mash', 90, 'Physical', 'normal', 0, 'Steel', contact),
  icebeam: mv('Ice Beam', 90, 'Special', 'normal', 0, 'Ice'),
  bulletseed: mv('Bullet Seed', 25, 'Physical', 'normal', 0, 'Grass', { multihit: true }),
};

export interface CalcCall { attacker: string; defender: string; move: string; field: FieldOptions; attackerBoostAtk: number; defenderHP: number; attackerStatus: string; attackerAbility: string; bp: number; crit: boolean; hits: number }

const idOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const mult = (b: number): number => (b >= 0 ? (2 + b) / 2 : 2 / (2 - b));

interface StubPokemon extends CalcPokemon { name: string; status: string; item: string }

export function makeStubCalc(options: { champions?: boolean } = {}): { lib: CalcLib; calls: CalcCall[] } {
  const champions = options.champions ?? true;
  const calls: CalcCall[] = [];
  const gen9: CalcGeneration = {
    num: 9,
    moves: { get: (id) => MOVES[id] },
    items: { get: (id) => (STONES[id] ? { megaStone: STONES[id] } : id.endsWith('berry') ? { isBerry: true } : undefined) },
    types: { get: (id) => (CHART[id] ? { effectiveness: CHART[id] } : undefined) },
  };
  const gen0: CalcGeneration = { ...gen9, num: 0 };

  class Pokemon implements StubPokemon {
    name: string; species: { baseStats: StatTable }; rawStats: StatTable; stats: StatTable; types: string[]; status: string; ability: string; item: string;
    boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }; originalCurHP = 0;
    constructor(gen: CalcGeneration, name: string, o: Record<string, unknown> = {}) {
      const base = SPECIES[name];
      if (!base) throw new Error(`unknown species ${name}`);
      this.name = name; this.species = { baseStats: base }; this.types = TYPES[name] ?? []; this.status = String(o.status ?? '');
      this.ability = String(o.ability ?? DEFAULT_ABILITY[name] ?? '');
      this.item = String(o.item ?? '');
      const ev = (o.evs ?? {}) as Partial<StatTable>;
      this.rawStats = gen.num === 0
        ? { hp: base.hp + (ev.hp ?? 0) + 75, atk: Math.floor((base.atk + (ev.atk ?? 0) + 20) * (o.nature === 'Adamant' ? 1.1 : 1)), def: base.def + 20, spa: base.spa + 20, spd: base.spd + 20, spe: base.spe + 20 }
        : { hp: base.hp * 2 + 110, atk: base.atk * 2, def: base.def * 2, spa: base.spa * 2, spd: base.spd * 2, spe: base.spe * 2 };
      this.stats = { ...this.rawStats };
    }
  }
  class Move implements CalcMove {
    name: string; priority: number; category: string; target: string; bp: number; type: string; flags: { contact?: number; sound?: number }; recoil?: [number, number]; drain?: [number, number];
    isCrit: boolean; hits: number;
    constructor(_gen: CalcGeneration, name: string, options: { overrides?: { basePower?: number }; isCrit?: boolean; hits?: number } = {}) {
      const d = MOVES[idOf(name)] ?? mv(name, 0, 'Status', 'normal');
      this.name = d.name; this.priority = d.priority; this.category = d.category; this.target = d.target; this.type = d.type;
      this.bp = options.overrides?.basePower ?? d.bp;
      this.isCrit = options.isCrit === true;
      this.hits = options.hits ?? (d.multihit ? 3 : 1);
      this.flags = { ...(d.contact ? { contact: 1 } : {}), ...(d.sound ? { sound: 1 } : {}) };
      if (d.recoil) this.recoil = d.recoil;
      if (d.drain) this.drain = d.drain;
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
      calls.push({ attacker: att.name, defender: def.name, move: move.name ?? '', field: f, attackerBoostAtk: att.boosts.atk, defenderHP: def.originalCurHP, attackerStatus: att.status, attackerAbility: att.ability ?? '', bp: (move as Move).bp, crit: (move as Move).isCrit, hits: (move as Move).hits });
      if (move.name === 'Earthquake' && def.name === 'Aerodactyl') return { damage: 0 };
      const bp = (move as Move).bp;
      let base = Math.floor((bp * att.stats.atk * mult(att.boosts.atk)) / def.stats.def / 3);
      if (att.status === 'brn' && move.category === 'Physical') base = Math.floor(base / 2);
      if (f.gameType === 'Doubles' && /allAdjacent/.test(move.target ?? '')) base = Math.floor(base * 0.75);
      if (f.attackerSide.isHelpingHand) base = Math.floor(base * 1.5);
      if ((move as Move).isCrit) base = Math.floor(base * 1.5);
      base *= (move as Move).hits;
      const rawDesc: { attackerItem?: string } = {};
      if (att.item === 'Life Orb' && base > 0) { base = Math.floor(base * 1.3); rawDesc.attackerItem = 'Life Orb'; }
      const damage = Array.from({ length: 16 }, (_, i) => Math.floor((base * (85 + i)) / 100));
      const m = move as Move;
      // Like the real calculator: recoil in % of the user's max HP, recovery in HP, both from damage capped at the target's HP.
      const dealt = (x: number): number => Math.min(x, def.originalCurHP);
      const ends = [damage[0] ?? 0, damage[15] ?? 0];
      const recoil = m.recoil;
      const drain = m.drain;
      return {
        damage, rawDesc,
        recoil: () => ({ recoil: recoil && att.ability !== 'Rock Head' ? ends.map((x) => Math.floor(((dealt(x) * recoil[0]) / recoil[1]) * 1000 / att.stats.hp) / 10) : [0, 0] }),
        recovery: () => ({ recovery: drain ? ends.map((x) => Math.round((dealt(x) * drain[0]) / drain[1])) : [0, 0] }),
      };
    },
  };
  return { lib, calls };
}
