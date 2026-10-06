/**
 * Move and ability effects the simulator applies. Only effects that always happen are listed
 * (no accuracy rolls, crits, or chance-based secondaries).
 */
import type { BoostKey } from '../types.ts';

export type BoostChange = Partial<Record<BoostKey, number>>;

/** Status moves that raise (or trade) the user's own stats. */
export const SETUP_MOVES: Readonly<Record<string, BoostChange>> = {
  swordsdance: { atk: 2 }, dragondance: { atk: 1, spe: 1 }, nastyplot: { spa: 2 }, calmmind: { spa: 1, spd: 1 },
  bulkup: { atk: 1, def: 1 }, quiverdance: { spa: 1, spd: 1, spe: 1 }, agility: { spe: 2 }, irondefense: { def: 2 },
  amnesia: { spd: 2 }, coil: { atk: 1, def: 1 }, shellsmash: { atk: 2, spa: 2, spe: 2, def: -1, spd: -1 },
  workup: { atk: 1, spa: 1 }, cosmicpower: { def: 1, spd: 1 }, defendorder: { def: 1, spd: 1 }, honeclaws: { atk: 1 },
  rockpolish: { spe: 2 }, autotomize: { spe: 2 }, acidarmor: { def: 2 }, barrier: { def: 2 }, cottonguard: { def: 3 },
  tailglow: { spa: 3 }, victorydance: { atk: 1, def: 1, spe: 1 }, tidyup: { atk: 1, spe: 1 }, shiftgear: { atk: 1, spe: 2 },
  noretreat: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, growth: { atk: 1, spa: 1 },
};

/** Status moves that lower the target's stats. */
export const DEBUFF_MOVES: Readonly<Record<string, BoostChange>> = {
  screech: { def: -2 }, faketears: { spd: -2 }, metalsound: { spd: -2 }, charm: { atk: -2 }, featherdance: { atk: -2 },
  partingshot: { atk: -1, spa: -1 }, growl: { atk: -1 }, leer: { def: -1 }, tailwhip: { def: -1 }, scaryface: { spe: -2 }, stringshot: { spe: -2 },
  cottonspore: { spe: -2 }, tickle: { atk: -1, def: -1 }, confide: { spa: -1 }, babydolleyes: { atk: -1 }, eerieimpulse: { spa: -2 },
};

/** Attacks that always lower the target's stats after hitting. */
export const SECONDARY_DROPS: Readonly<Record<string, BoostChange>> = {
  icywind: { spe: -1 }, snarl: { spa: -1 }, electroweb: { spe: -1 }, breakingswipe: { atk: -1 }, strugglebug: { spa: -1 },
  lunge: { atk: -1 }, tropkick: { atk: -1 }, bulldoze: { spe: -1 }, rocktomb: { spe: -1 }, mudshot: { spe: -1 },
  mysticalfire: { spa: -1 }, skittersmack: { spa: -1 }, spiritbreak: { spa: -1 },
};

/** Attacks that lower the user's own stats. */
export const SELF_DROPS: Readonly<Record<string, BoostChange>> = {
  dracometeor: { spa: -2 }, overheat: { spa: -2 }, leafstorm: { spa: -2 }, fleurcannon: { spa: -2 }, psychoboost: { spa: -2 },
  closecombat: { def: -1, spd: -1 }, superpower: { atk: -1, def: -1 }, hammerarm: { spe: -1 }, icehammer: { spe: -1 },
  vcreate: { def: -1, spd: -1, spe: -1 },
  // Pokémon Champions: Make It Rain lowers the user's Sp. Atk by 2 stages (it was 1 in Scarlet/Violet).
  makeitrain: { spa: -2 }, clangingscales: { def: -1 }, armorcannon: { def: -1, spd: -1 },
  headlongrush: { def: -1, spd: -1 }, dragonascent: { def: -1, spd: -1 }, hyperspacefury: { def: -1 }, spinout: { spe: -2 },
  scaleshot: { def: -1, spe: 1 },
};

export type ScreenKey = 'reflect' | 'light' | 'veil';
export interface FieldMove {
  weather?: 'Sun' | 'Rain' | 'Sand' | 'Snow';
  terrain?: 'Electric' | 'Grassy' | 'Psychic' | 'Misty';
  trick?: true;
  tailwind?: true;
  screen?: ScreenKey;
}
export const FIELD_MOVES: Readonly<Record<string, FieldMove>> = {
  sunnyday: { weather: 'Sun' }, raindance: { weather: 'Rain' }, sandstorm: { weather: 'Sand' }, snowscape: { weather: 'Snow' }, hail: { weather: 'Snow' },
  electricterrain: { terrain: 'Electric' }, grassyterrain: { terrain: 'Grassy' }, psychicterrain: { terrain: 'Psychic' }, mistyterrain: { terrain: 'Misty' },
  chillyreception: { weather: 'Snow' }, trickroom: { trick: true }, tailwind: { tailwind: true }, reflect: { screen: 'reflect' }, lightscreen: { screen: 'light' }, auroraveil: { screen: 'veil' },
};

export const PROTECT_MOVES: ReadonlySet<string> = new Set(['protect', 'detect', 'spikyshield', 'kingsshield', 'banefulbunker', 'obstruct', 'silktrap', 'burningbulwark']);
export const BREAKS_PROTECT: ReadonlySet<string> = new Set(['feint', 'phantomforce', 'shadowforce', 'hyperspacefury', 'hyperspacehole']);

export const ENTRY_WEATHER: Readonly<Record<string, 'Sun' | 'Rain' | 'Sand' | 'Snow'>> = { drizzle: 'Rain', drought: 'Sun', sandstream: 'Sand', snowwarning: 'Snow', orichalcumpulse: 'Sun' };
export const ENTRY_TERRAIN: Readonly<Record<string, 'Electric' | 'Grassy' | 'Psychic' | 'Misty'>> = { electricsurge: 'Electric', hadronengine: 'Electric', grassysurge: 'Grassy', psychicsurge: 'Psychic', mistysurge: 'Misty' };

/** Abilities that stop priority moves from hitting the holder or its ally (Farigiraf, Tsareena, Bruxish). */
export const PRIORITY_BLOCKERS: readonly string[] = ['armortail', 'queenlymajesty', 'dazzling'];

/** Abilities that stop other Pokémon from lowering this one's stats. */
export const STAT_DROP_BLOCKERS: readonly string[] = ['clearbody', 'whitesmoke', 'fullmetalbody'];
/** Abilities that make Intimidate do nothing. */
export const INTIMIDATE_IMMUNE: readonly string[] = ['clearbody', 'whitesmoke', 'fullmetalbody', 'hypercutter', 'innerfocus', 'owntempo', 'oblivious', 'scrappy', 'mirrorarmor'];

/** Non-volatile status conditions the simulator tracks (freeze only comes from chance effects, so it is not modeled). */
export type StatusId = 'brn' | 'par' | 'psn' | 'tox' | 'slp';
export const STATUS_LABEL: Readonly<Record<StatusId, string>> = { brn: 'burned', par: 'paralyzed', psn: 'poisoned', tox: 'badly poisoned', slp: 'asleep' };
export const STATUS_SHORT: Readonly<Record<StatusId, string>> = { brn: 'BRN', par: 'PAR', psn: 'PSN', tox: 'TOX', slp: 'SLP' };

/** Status moves that inflict a condition (accuracy is not modeled, so they always land unless something blocks them). */
export const STATUS_MOVES: Readonly<Record<string, StatusId>> = {
  willowisp: 'brn', thunderwave: 'par', glare: 'par', stunspore: 'par', toxic: 'tox', poisonpowder: 'psn', poisongas: 'psn',
  toxicthread: 'psn', spore: 'slp', sleeppowder: 'slp', hypnosis: 'slp', sing: 'slp', lovelykiss: 'slp', grasswhistle: 'slp', darkvoid: 'slp',
};
/** Attacks that always inflict a condition after hitting. */
export const SECONDARY_STATUS: Readonly<Record<string, StatusId>> = { nuzzle: 'par', mortalspin: 'psn' };
export const POWDER_MOVES: ReadonlySet<string> = new Set(['spore', 'sleeppowder', 'stunspore', 'poisonpowder']);

export const STATUS_TYPE_IMMUNE: Readonly<Record<StatusId, readonly string[]>> = { brn: ['Fire'], par: ['Electric'], psn: ['Poison', 'Steel'], tox: ['Poison', 'Steel'], slp: [] };
export const STATUS_ABILITY_IMMUNE: Readonly<Record<StatusId, readonly string[]>> = {
  brn: ['waterveil', 'waterbubble', 'thermalexchange'], par: ['limber'], psn: ['immunity', 'pastelveil'], tox: ['immunity', 'pastelveil'],
  slp: ['insomnia', 'vitalspirit', 'sweetveil'],
};
/** Abilities that block every status condition. */
export const ALL_STATUS_IMMUNE: readonly string[] = ['comatose', 'purifyingsalt'];
/** Berries eaten as soon as their holder gets a matching condition. */
export const CURE_BERRIES: Readonly<Record<string, readonly StatusId[]>> = {
  lumberry: ['brn', 'par', 'psn', 'tox', 'slp'], cheriberry: ['par'], chestoberry: ['slp'], rawstberry: ['brn'], pechaberry: ['psn', 'tox'],
};

/** Moves after which the user switches out (if the move worked and someone is left on the bench). */
export interface PivotMove {
  /** Attacks only switch out if they hit something. */
  needsHit?: true;
  /** Baton Pass hands the stat stages to the incoming Pokémon. */
  passBoosts?: true;
}
export const PIVOT_MOVES: Readonly<Record<string, PivotMove>> = {
  uturn: { needsHit: true }, voltswitch: { needsHit: true }, flipturn: { needsHit: true },
  partingshot: {}, teleport: {}, chillyreception: {}, shedtail: {}, batonpass: { passBoosts: true },
};
