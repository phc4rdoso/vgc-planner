import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMega, parseShowdown, teamWarnings } from '../src/domain/showdown.ts';

const PASTE = `Rillaboom @ Assault Vest
Ability: Grassy Surge
Level: 50
EVs: 252 HP / 4 Atk
Adamant Nature
- Fake Out
- Grassy Glide
- Wood Hammer
- U-turn

Aerodactyl-Mega @ Aerodactylite
Ability: Tough Claws
- Rock Slide
- Protect

Rocky (Kommo-o) (F) @ Clear Amulet
Ability: Soundproof
Tera Type: Fire
- Clanging Scales

Floette-Mega
- Moonblast
`;

test('parses species, item, ability, level, EVs, nature and moves', () => {
  const [rillaboom] = parseShowdown(PASTE);
  assert.equal(rillaboom?.species, 'Rillaboom');
  assert.equal(rillaboom?.item, 'Assault Vest');
  assert.equal(rillaboom?.ability, 'Grassy Surge');
  assert.equal(rillaboom?.level, 50);
  assert.equal(rillaboom?.evs, '252 HP / 4 Atk');
  assert.equal(rillaboom?.nature, 'Adamant');
  assert.deepEqual(rillaboom?.moves, ['Fake Out', 'Grassy Glide', 'Wood Hammer', 'U-turn']);
});

test('handles nicknames, gender, unknown lines and missing items', () => {
  const mons = parseShowdown(PASTE);
  assert.equal(mons.length, 4);
  assert.equal(mons[2]?.nickname, 'Rocky');
  assert.equal(mons[2]?.species, 'Kommo-o');
  assert.equal(mons[2]?.gender, 'F');
  assert.deepEqual(mons[2]?.extra, ['Tera Type: Fire']);
  assert.equal(mons[3]?.item, '');
});

test('ignores format headers, CRLF line endings and empty input', () => {
  assert.equal(parseShowdown('').length, 0);
  assert.equal(parseShowdown(null).length, 0);
  assert.equal(parseShowdown('=== [gen9vgc] Team ===\r\n\r\nRillaboom @ Leftovers').length, 1);
});

test('isMega recognises Mega forms only', () => {
  assert.ok(isMega('Aerodactyl-Mega'));
  assert.ok(isMega('Charizard-Mega-Y'));
  assert.ok(isMega('Absol-Mega-Z'));
  assert.ok(!isMega('Rillaboom'));
  assert.ok(!isMega(''));
});

test('teamWarnings flags too many megas and oversized teams', () => {
  assert.equal(teamWarnings(parseShowdown('A-Mega\n\nB-Mega\n\nC-Mega')).length, 1);
  assert.equal(teamWarnings(parseShowdown('A\n\nB\n\nC\n\nD\n\nE\n\nF\n\nG')).length, 1);
  assert.equal(teamWarnings(parseShowdown('A-Mega\n\nB')).length, 0);
});
