/** The two teams of tests/fixtures/replays/champions-1.json, as Showdown pastes (open team sheets, generic spreads). */
const mon = (head: string, ability: string, nature: string, moves: string): string =>
  `${head}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 Atk / 2 Spe\n${nature} Nature\n${moves.split(', ').map((m) => `- ${m}`).join('\n')}`;
export const ALICE = [
  mon('Garchomp @ Garchompite Z', 'Rough Skin', 'Modest', 'Draco Meteor, Flamethrower, Power Gem, Protect'),
  mon('Whimsicott @ Focus Sash', 'Prankster', 'Timid', 'Moonblast, Tailwind, Encore, Protect'),
  mon('Sneasler @ White Herb', 'Unburden', 'Adamant', 'Close Combat, Dire Claw, Fake Out, Protect'),
  mon('Floette-Eternal @ Floettite', 'Flower Veil', 'Modest', 'Moonblast, Dazzling Gleam, Calm Mind, Protect'),
  mon('Basculegion @ Life Orb', 'Adaptability', 'Adamant', 'Wave Crash, Last Respects, Aqua Jet, Protect'),
  mon('Kingambit @ Chople Berry', 'Defiant', 'Adamant', 'Kowtow Cleave, Sucker Punch, Iron Head, Protect'),
].join('\n\n');
export const BOB = [
  mon('Armarouge @ Focus Sash', 'Weak Armor', 'Modest', 'Expanding Force, Armor Cannon, Aura Sphere, Protect'),
  mon('Indeedee-F @ Colbur Berry', 'Psychic Surge', 'Bold', 'Psychic, Follow Me, Helping Hand, Protect'),
  mon('Salamence @ Salamencite', 'Intimidate', 'Timid', 'Hyper Voice, Draco Meteor, Tailwind, Protect'),
  mon('Sneasler @ White Herb', 'Unburden', 'Adamant', 'Close Combat, Dire Claw, Feint, Fake Out'),
  mon('Excadrill @ Life Orb', 'Sand Rush', 'Adamant', 'High Horsepower, Earthquake, Iron Head, Protect'),
  mon('Tyranitar @ Tyranitarite', 'Sand Stream', 'Adamant', 'Rock Slide, Knock Off, Low Kick, Protect'),
].join('\n\n');

