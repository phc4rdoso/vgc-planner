import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calcStats, readSpread, spreadText, statPoints } from '../src/domain/stats.ts';

test('readSpread understands Showdown labels and ignores junk', () => {
  assert.deepEqual(readSpread('32 HP / 2 Def / 32 Spe'), { hp: 32, atk: 0, def: 2, spa: 0, spd: 0, spe: 32 });
  assert.deepEqual(readSpread('4 SpA / 4 SpD / nonsense'), { hp: 0, atk: 0, def: 0, spa: 4, spd: 4, spe: 0 });
});

test('values within 32 per stat and 66 total are Stat Points', () => {
  const r = statPoints({ evs: '32 HP / 2 Def / 32 Spe' });
  assert.equal(r?.converted, false);
  assert.equal(r?.sp.def, 2);
});

test('larger numbers are converted from real EVs (4 for the first point, 8 for each after)', () => {
  const r = statPoints({ evs: '252 Atk / 4 Def / 252 Spe' });
  assert.equal(r?.converted, true);
  assert.deepEqual([r?.sp.atk, r?.sp.def, r?.sp.spe], [32, 1, 32]);
  assert.equal(statPoints({ evs: '12 HP / 252 Atk' })?.sp.hp, 2);
});

test('no EVs line means no reading', () => {
  assert.equal(statPoints({ evs: '' }), null);
  assert.equal(statPoints(null), null);
});

test('Champions stat formula (verified against known values)', () => {
  const garchomp = { hp: 108, atk: 130, def: 95, spa: 80, spd: 85, spe: 102 };
  const sp = { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 };
  assert.deepEqual(calcStats(garchomp, sp, 'Adamant'), { hp: 185, atk: 200, def: 115, spa: 90, spd: 105, spe: 154 });
  // neutral nature keeps raw values, +Spe nature multiplies after adding points
  assert.equal(calcStats(garchomp, sp, 'Serious').atk, 182);
  assert.equal(calcStats(garchomp, sp, 'Jolly').spe, 169);
});

test('spreadText lists non-zero stats', () => {
  assert.equal(spreadText({ hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 }), '2 HP / 32 Atk / 32 Spe');
  assert.equal(spreadText({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }), 'none');
});
