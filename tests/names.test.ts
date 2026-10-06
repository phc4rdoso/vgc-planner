import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BattleState } from '../src/domain/simulation/state.ts';
import { formOf, renamedForms, showNames } from '../src/ui/names.ts';

test('a Mega named in the paste is shown in base form until it Mega Evolves', () => {
  assert.equal(formOf(null, 'opp', 'Raichu-Mega-Y'), 'Raichu');
  assert.equal(formOf(null, 'me', 'Garchomp-Mega-Z'), 'Garchomp');
  assert.equal(formOf(null, 'me', 'Kingambit'), 'Kingambit');
  const st = { mons: { me: { 'Aerodactyl-Mega': { species: 'Aerodactyl-Mega' } }, opp: { 'Raichu-Mega-Y': { species: 'Raichu' } } } } as unknown as BattleState;
  assert.equal(formOf(st, 'me', 'Aerodactyl-Mega'), 'Aerodactyl-Mega', 'after Mega Evolving in the branch');
  const forms = renamedForms(st);
  assert.deepEqual([...forms], [['Raichu-Mega-Y', 'Raichu']]);
  assert.equal(showNames("Raichu-Mega-Y fainted: add an action for its replacement (Volcarona or Rillaboom)", forms), 'Raichu fainted: add an action for its replacement (Volcarona or Rillaboom)');
});
