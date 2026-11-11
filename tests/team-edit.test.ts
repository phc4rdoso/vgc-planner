import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as calc from '@smogon/calc';
import { buildDex, closest, natureText, search } from '../src/domain/dex.ts';
import { createEngine } from '../src/domain/simulation/engine.ts';
import type { CalcLib } from '../src/domain/simulation/calc-types.ts';
import { formatSet, formatShowdown, parseShowdown } from '../src/domain/showdown.ts';
import { editMon, setField, setMove, setSpread, setStatPoints, spOf, spTotal } from '../src/domain/team-edit.ts';

const PASTE = `=== [gen9] Folder/Sun ===

Incineroar @ Sitrus Berry
Ability: Intimidate
Level: 50
EVs: 32 HP / 2 Atk / 12 Def / 18 SpD / 2 Spe
Careful Nature
- Fake Out
- Flare Blitz
- Parting Shot
- Knock Off

Rocky (Kommo-o) (F) @ Clear Amulet
Ability: Soundproof
Shiny: Yes
Tera Type: Fire
IVs: 0 Spe
- Clanging Scales

Rillaboom
EVs: 252 HP / 4 Atk / 252 SpD
- Fake Out
`;

test('formatting a parsed paste and parsing it again gives the same Pokémon', () => {
  const mons = parseShowdown(PASTE);
  assert.deepEqual(parseShowdown(formatShowdown(mons)), mons);
});

test('formatSet writes nickname, gender, item and the lines the parser kept', () => {
  const [, kommo] = parseShowdown(PASTE);
  assert.equal(formatSet(kommo!), 'Rocky (Kommo-o) (F) @ Clear Amulet\nAbility: Soundproof\nShiny: Yes\nTera Type: Fire\nIVs: 0 Spe\n- Clanging Scales');
});

test('editMon changes only the chosen Pokémon', () => {
  const out = editMon(PASTE, 0, (m) => setField(m, 'item', ' Leftovers '));
  const [inc, kommo] = parseShowdown(out);
  assert.equal(inc?.item, 'Leftovers');
  assert.deepEqual(kommo, parseShowdown(PASTE)[1]);
  assert.equal(editMon(PASTE, 9, (m) => setField(m, 'item', 'x')), PASTE);
});

test('setMove replaces a slot, fills an empty one and clears one', () => {
  const [inc, kommo] = parseShowdown(PASTE);
  setMove(inc!, 1, 'Darkest Lariat');
  assert.deepEqual(inc!.moves, ['Fake Out', 'Darkest Lariat', 'Parting Shot', 'Knock Off']);
  setMove(kommo!, 3, 'Protect');
  assert.deepEqual(kommo!.moves, ['Clanging Scales', 'Protect']);
  setMove(inc!, 0, '');
  assert.deepEqual(inc!.moves, ['Darkest Lariat', 'Parting Shot', 'Knock Off']);
});

test('Stat Points stay within 32 per stat and 66 in total', () => {
  const [inc] = parseShowdown(PASTE);
  assert.equal(spTotal(spOf(inc!)), 66);
  setStatPoints(inc!, 'spa', 10); // no room left
  assert.equal(spOf(inc!).spa, 0);
  setStatPoints(inc!, 'def', 0);
  setStatPoints(inc!, 'spa', 40); // 12 freed, capped there
  assert.equal(spOf(inc!).spa, 12);
  assert.equal(inc!.evs, '32 HP / 2 Atk / 12 SpA / 18 SpD / 2 Spe');
  setSpread(inc!, { hp: 2, atk: 32, spe: 32 });
  assert.equal(inc!.evs, '2 HP / 32 Atk / 32 Spe');
  setSpread(inc!, { hp: 32, atk: 32, spe: 32 });
  assert.equal(spTotal(spOf(inc!)), 66);
});

test('editing a Pokémon with real EVs writes them back as Stat Points', () => {
  const [, , rilla] = parseShowdown(PASTE);
  assert.deepEqual(spOf(rilla!), { hp: 32, atk: 1, def: 0, spa: 0, spd: 32, spe: 0 });
  setStatPoints(rilla!, 'atk', 0);
  assert.equal(rilla!.evs, '32 HP / 32 SpD');
});

const dex = createEngine(calc as unknown as CalcLib).dex();

test('the dex lists Champions species, moves, items and abilities', () => {
  const inc = dex.findSpecies('incineroar');
  assert.deepEqual(inc?.types, ['Fire', 'Dark']);
  assert.equal(inc?.base.atk, 115);
  assert.deepEqual(dex.findMove('Fake Out'), { name: 'Fake Out', type: 'Normal', category: 'Physical', bp: 40 });
  assert.ok(dex.findItem('Charizardite Y')?.megaStone);
  assert.ok(dex.findItem('Sitrus Berry')?.berry);
  assert.ok(dex.hasAbility('Intimidate'));
  assert.ok(!dex.moves.some((m) => m.name === '(No Move)'));
  assert.equal(dex.natures.length, 25);
});

test('search ranks exact and prefix matches first and ignores punctuation', () => {
  const names = (q: string): string[] => search(dex.moves, q, (m) => m.name, 5).map((m) => m.name);
  assert.equal(names('uturn')[0], 'U-turn');
  assert.equal(names('protect')[0], 'Protect');
  assert.ok(names('blitz').includes('Flare Blitz'));
  assert.equal(search(dex.moves, '', (m) => m.name, 3).length, 3);
});

test('closest suggests a fix for a typo, and nothing for a different word', () => {
  const moves = dex.moves.map((m) => m.name);
  assert.equal(closest(moves, 'Flare Blits'), 'Flare Blitz');
  assert.equal(closest(moves, 'qqqqqqqq'), '');
});

test('natureText', () => {
  assert.equal(natureText('Careful'), '+SpD −SpA');
  assert.equal(natureText('Serious'), 'neutral');
});

test('buildDex copes with a generation that has no data', () => {
  const empty = buildDex({});
  assert.equal(empty.species.length, 0);
  assert.equal(empty.findMove('Protect'), undefined);
});
