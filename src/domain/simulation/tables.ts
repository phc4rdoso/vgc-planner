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
/** Moves that go through Protect and lift it (and Wide Guard / Quick Guard on that side) for the rest of the turn. */
export const BREAKS_PROTECT: ReadonlySet<string> = new Set(['feint', 'phantomforce', 'shadowforce', 'hyperspacefury', 'hyperspacehole']);
/** Moves that fail when the user used one of them successfully on its previous action. */
export const PROTECT_FAMILY: ReadonlySet<string> = new Set([...PROTECT_MOVES, 'wideguard', 'quickguard', 'endure']);

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

/*
 * Items and abilities with a trigger. Their damage effects (Life Orb's boost, resist berries, Knock Off's power,
 * Multiscale...) come from the calculator, which gets each Pokémon's current item and HP; these tables only say
 * when something happens and what it changes afterwards.
 */

/** Items that make the holder's own weather or terrain last 8 turns instead of 5. */
export const WEATHER_ROCKS: Readonly<Record<string, 'Sun' | 'Rain' | 'Sand' | 'Snow'>> = { heatrock: 'Sun', damprock: 'Rain', smoothrock: 'Sand', icyrock: 'Snow' };
export const TERRAIN_EXTENDER = 'terrainextender';

/** Seeds: eaten as soon as their terrain is up while the holder is on the field, raising one stat. */
export const TERRAIN_SEEDS: Readonly<Record<string, { terrain: 'Electric' | 'Grassy' | 'Psychic' | 'Misty'; stat: BoostKey }>> = {
  electricseed: { terrain: 'Electric', stat: 'def' }, grassyseed: { terrain: 'Grassy', stat: 'def' },
  psychicseed: { terrain: 'Psychic', stat: 'spd' }, mistyseed: { terrain: 'Misty', stat: 'spd' },
};

/** Berries eaten once the holder's HP falls to `at` of its maximum: they heal (a fraction, or a flat amount) or raise a stat. */
export interface HpBerry { at: number; heal?: number; flat?: number; boost?: BoostKey }
const pinch = (heal: number): HpBerry => ({ at: 1 / 4, heal });
export const HP_BERRIES: Readonly<Record<string, HpBerry>> = {
  sitrusberry: { at: 1 / 2, heal: 1 / 4 }, oranberry: { at: 1 / 2, flat: 10 },
  figyberry: pinch(1 / 3), wikiberry: pinch(1 / 3), magoberry: pinch(1 / 3), aguavberry: pinch(1 / 3), iapapaberry: pinch(1 / 3),
  liechiberry: { at: 1 / 4, boost: 'atk' }, ganlonberry: { at: 1 / 4, boost: 'def' }, petayaberry: { at: 1 / 4, boost: 'spa' },
  apicotberry: { at: 1 / 4, boost: 'spd' }, salacberry: { at: 1 / 4, boost: 'spe' },
};
/** Opposing abilities that stop berries from being eaten. */
export const UNNERVE: readonly string[] = ['unnerve', 'asoneglastrier', 'asonespectrier'];

/** Contact with the holder hurts the attacker by this fraction of the attacker's maximum HP. */
export const CONTACT_ABILITIES: Readonly<Record<string, number>> = { roughskin: 1 / 8, ironbarbs: 1 / 8 };
export const CONTACT_ITEMS: Readonly<Record<string, number>> = { rockyhelmet: 1 / 6 };
/** Protect variants that punish contact: damage (fraction of the attacker's max HP) or a condition. */
export const CONTACT_PROTECT: Readonly<Record<string, { damage?: number; status?: StatusId; drop?: BoostChange }>> = {
  spikyshield: { damage: 1 / 8 }, banefulbunker: { status: 'psn' }, burningbulwark: { status: 'brn' },
  kingsshield: { drop: { atk: -1 } }, silktrap: { drop: { spe: -1 } }, obstruct: { drop: { def: -2 } },
};

/** Entry abilities that raise the user's own stats (once per battle in Scarlet/Violet and Champions). */
export const ENTRY_BOOSTS: Readonly<Record<string, BoostChange>> = { intrepidsword: { atk: 1 }, dauntlessshield: { def: 1 } };

/** Sandstorm doesn't hurt these types, abilities or items. */
export const SAND_IMMUNE_TYPES: readonly string[] = ['Rock', 'Ground', 'Steel'];
export const SAND_IMMUNE: readonly string[] = ['sandveil', 'sandrush', 'sandforce', 'overcoat', 'safetygoggles'];

/** Moves that draw the opponents' single-target moves to the user this turn. Rage Powder is a powder move. */
export const REDIRECT_MOVES: Readonly<Record<string, { powder?: true }>> = { followme: {}, ragepowder: { powder: true } };
/** Abilities and moves that ignore redirection. */
export const IGNORES_REDIRECT: readonly string[] = ['stalwart', 'propellertail', 'snipeshot'];

/**
 * Abilities that absorb one move type (the calculator already treats the holder as immune): what they give
 * instead. `redirect` also draws single-target moves of that type, like Lightning Rod.
 */
export const ABSORB_ABILITIES: Readonly<Record<string, { type: string; boost?: BoostChange; heal?: number; redirect?: true }>> = {
  lightningrod: { type: 'Electric', boost: { spa: 1 }, redirect: true }, stormdrain: { type: 'Water', boost: { spa: 1 }, redirect: true },
  motordrive: { type: 'Electric', boost: { spe: 1 } }, sapsipper: { type: 'Grass', boost: { atk: 1 } }, wellbakedbody: { type: 'Fire', boost: { def: 2 } },
  voltabsorb: { type: 'Electric', heal: 1 / 4 }, waterabsorb: { type: 'Water', heal: 1 / 4 }, dryskin: { type: 'Water', heal: 1 / 4 }, eartheater: { type: 'Ground', heal: 1 / 4 },
};

/** Items that stop other Pokémon from lowering the holder's stats. */
export const STAT_DROP_ITEMS: readonly string[] = ['clearamulet'];
/** Abilities that keep the holder's item from being removed (Knock Off, Thief, Trick). */
export const STICKY_ABILITIES: readonly string[] = ['stickyhold'];
/** Attacks that take the target's item: knocked off, stolen by a user with no item, or burned (berries and gems). */
export const ITEM_REMOVAL: Readonly<Record<string, 'knock' | 'steal' | 'burn'>> = { knockoff: 'knock', thief: 'steal', covet: 'steal', incinerate: 'burn' };
/** Status moves that swap the user's and the target's items. */
export const ITEM_SWAP: ReadonlySet<string> = new Set(['trick', 'switcheroo']);

/**
 * Two-turn moves: the first action charges (with an optional stat boost, as Electro Shot and Meteor Beam give), the
 * next one attacks. `instantIn`: no charging needed in that weather. Power Herb skips the charge once. `semi`: the
 * user is out of reach while charging (Fly, Dig...).
 */
export interface ChargeMove { instantIn?: 'Sun' | 'Rain' | 'Sand' | 'Snow'; boost?: BoostChange; semi?: string; text?: string }
export const CHARGE_MOVES: Readonly<Record<string, ChargeMove>> = {
  solarbeam: { instantIn: 'Sun', text: 'absorbs light' }, solarblade: { instantIn: 'Sun', text: 'absorbs light' },
  electroshot: { instantIn: 'Rain', boost: { spa: 1 }, text: 'absorbs electricity' }, meteorbeam: { boost: { spa: 1 }, text: 'is overflowing with space power' },
  skullbash: { boost: { def: 1 }, text: 'tucks in its head' }, skyattack: { text: 'is glowing' }, razorwind: { text: 'whipped up a whirlwind' },
  freezeshock: { text: 'is cloaked in a freezing light' }, iceburn: { text: 'is cloaked in freezing air' },
  fly: { semi: 'flies up high' }, bounce: { semi: 'springs up' }, dig: { semi: 'burrows underground' }, dive: { semi: 'dives underwater' },
  phantomforce: { semi: 'vanishes' }, shadowforce: { semi: 'vanishes' },
};
/** Moves that still reach a Pokémon in the middle of a semi-invulnerable move, by that move. */
export const HITS_SEMI_INVULNERABLE: Readonly<Record<string, readonly string[]>> = {
  fly: ['thunder', 'hurricane', 'skyuppercut', 'smackdown', 'thousandarrows', 'gust', 'twister'],
  bounce: ['thunder', 'hurricane', 'skyuppercut', 'smackdown', 'thousandarrows', 'gust', 'twister'],
  dig: ['earthquake', 'magnitude', 'fissure'], dive: ['surf', 'whirlpool'],
};

/** Moves that only work on the user's first turn after coming in. */
export const FIRST_TURN_ONLY: ReadonlySet<string> = new Set(['fakeout', 'firstimpression', 'matblock']);
/**
 * Moves that need the target to be about to use a certain kind of move (and not to have moved yet):
 * an attack (Sucker Punch, Thunderclap) or a priority move (Upper Hand).
 */
export const NEEDS_TARGET_MOVE: Readonly<Record<string, 'attack' | 'priority'>> = { suckerpunch: 'attack', thunderclap: 'attack', upperhand: 'priority' };
/** Attacks that make the target flinch every time (only on the target's first turn for Fake Out, see FIRST_TURN_ONLY). */
export const ALWAYS_FLINCH: ReadonlySet<string> = new Set(['fakeout', 'upperhand']);

/** Attacks after which the user must spend its next action recharging (if the attack hit). */
export const RECHARGE_MOVES: ReadonlySet<string> = new Set([
  'hyperbeam', 'gigaimpact', 'blastburn', 'hydrocannon', 'frenzyplant', 'rockwrecker', 'roaroftime', 'prismaticlaser', 'eternabeam', 'meteorassault',
]);
