import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as calc from '@smogon/calc';
import { newNode, newPlan } from '../src/domain/model.ts';
import { applyRenames, describeUses, findPlanUses, planImpact, renameMonInPlans, renameMoveInPlans } from '../src/domain/plan-refs.ts';
import { parseShowdown } from '../src/domain/showdown.ts';
import type { CalcLib } from '../src/domain/simulation/calc-types.ts';
import { createEngine } from '../src/domain/simulation/engine.ts';
import { stoneMismatch, swapSpecies, teamIssues } from '../src/domain/team-check.ts';
import { addMon, blankMon, duplicateMon, moveMon, removeMon } from '../src/domain/team-edit.ts';
import type { Plan } from '../src/domain/types.ts';

const dex = createEngine(calc as unknown as CalcLib).dex();

const PASTE = `Incineroar @ Sitrus Berry
Ability: Intimidate
- Fake Out
- Flare Blitz

Charizard-Mega-Y @ Charizardite Y
Ability: Drought
- Heat Wave

Garchomp @ Choice Scarf
Ability: Rough Skin
- Earthquake
`;
const species = (paste: string): string[] => parseShowdown(paste).map((m) => m.species);

test('add, remove, duplicate and move team members', () => {
  assert.deepEqual(species(addMon(PASTE, blankMon('Whimsicott', 'Prankster'))), ['Incineroar', 'Charizard-Mega-Y', 'Garchomp', 'Whimsicott']);
  assert.equal(parseShowdown(addMon(PASTE, blankMon('Whimsicott', 'Prankster')))[3]?.level, 50);
  assert.deepEqual(species(removeMon(PASTE, 1)), ['Incineroar', 'Garchomp']);
  assert.deepEqual(species(duplicateMon(PASTE, 0)), ['Incineroar', 'Incineroar', 'Charizard-Mega-Y', 'Garchomp']);
  assert.deepEqual(species(moveMon(PASTE, 2, 0)), ['Garchomp', 'Incineroar', 'Charizard-Mega-Y']);
  assert.deepEqual(species(moveMon(PASTE, 0, 9)), ['Charizard-Mega-Y', 'Garchomp', 'Incineroar']);
  assert.equal(removeMon(PASTE, 7), PASTE);
});

test('swapping species keeps what still applies', () => {
  const [inc, zard] = parseShowdown(PASTE);
  swapSpecies(inc!, 'Rillaboom', dex);
  assert.equal(inc!.species, 'Rillaboom');
  assert.equal(inc!.item, 'Sitrus Berry');
  assert.equal(inc!.ability, 'Intimidate'); // not Incineroar's listed default (Blaze), so it stays
  assert.deepEqual(inc!.moves, ['Fake Out', 'Flare Blitz']);
  swapSpecies(zard!, 'Venusaur-Mega', dex);
  assert.equal(zard!.item, ''); // Charizardite Y is someone else's stone
  assert.equal(zard!.ability, 'Thick Fat'); // Drought was Charizard-Mega-Y's only ability
  assert.ok(!stoneMismatch(dex, 'Charizardite Y', 'Charizard'));
  assert.ok(stoneMismatch(dex, 'Charizardite Y', 'Garchomp'));
});

test('teamIssues flags unknown names, missing moves, Mega problems and duplicates', () => {
  const mons = parseShowdown(`Incineroar @ Sitrus Berry
- Flare Blits

Charizard-Mega-Y @ Leftovers
- Heat Wave

Venusaur-Mega @ Venusaurite
- Giga Drain

Absol-Mega @ Absolite
- Sucker Punch

Garchomp

Garchomp
- Earthquake
`);
  const issues = teamIssues(mons, dex).map((list) => list.map((i) => i.text));
  assert.deepEqual(issues[0], ['Unknown move: Flare Blits']);
  assert.ok(issues[1]!.includes('3 Megas on the team; Reg M-C allows 2'));
  assert.ok(issues[1]!.includes('Charizard-Mega-Y needs its Mega Stone'));
  assert.ok(issues[4]!.includes('No moves yet'));
  assert.ok(issues[4]!.some((t) => t.includes('on the team twice')));
  assert.deepEqual(teamIssues(mons, null)[0], []); // without the dex, names aren't checked
});

function planWith(): Plan {
  const plan = newPlan('vs Sun', 'Torkoal @ Charcoal\n- Eruption\n\nIncineroar\n- Fake Out');
  const tab = plan.tabs[0]!;
  tab.selection.me.lead = ['Garchomp', 'Incineroar'];
  const t1 = newNode({
    actions: [
      { side: 'me', mon: 'Garchomp', kind: 'move', move: 'Earthquake', target: 'Both foes', outcome: { targets: { Torkoal: { crit: true } } } },
      { side: 'opp', mon: 'Torkoal', kind: 'move', move: 'Eruption', target: 'Garchomp', outcome: { targets: { Garchomp: { hp: 40 } } } },
      // Mirror: the user's Fake Out aimed at "Incineroar" is read as the opponent's Incineroar.
      { side: 'me', mon: 'Incineroar', kind: 'move', move: 'Fake Out', target: 'Incineroar' },
    ],
    order: ['me:Garchomp', 'opp:Torkoal'],
    hpEnd: { 'me:Garchomp': 40 },
  });
  const t2 = newNode({ actions: [{ side: 'me', mon: 'Incineroar', kind: 'switch', move: '', target: 'Garchomp' }] });
  t1.children.push(t2);
  tab.children.push(t1);
  return plan;
}

test('findPlanUses counts turns per gameplan and describes them', () => {
  const plans = [planWith()];
  assert.deepEqual(findPlanUses(plans, { kind: 'mon', species: 'Garchomp' }), [{ plan: 'vs Sun', turns: 2 }]);
  assert.deepEqual(findPlanUses(plans, { kind: 'move', species: 'Garchomp', move: 'Earthquake' }), [{ plan: 'vs Sun', turns: 1 }]);
  assert.deepEqual(findPlanUses(plans, { kind: 'move', species: 'Garchomp', move: 'Protect' }), []);
  assert.equal(describeUses([{ plan: 'A', turns: 3 }, { plan: 'B', turns: 1 }, { plan: 'C', turns: 0 }]), '3 turns of “A”, 1 turn of “B” and the team picks of “C”');
});

test('renameMonInPlans renames the user\'s Pokémon everywhere and leaves the opponent alone', () => {
  const plans = [planWith()];
  renameMonInPlans(plans, 'Garchomp', 'Garchomp-Mega');
  const tab = plans[0]!.tabs[0]!;
  const [t1] = tab.children;
  assert.deepEqual(tab.selection.me.lead, ['Garchomp-Mega', 'Incineroar']);
  assert.equal(t1!.actions[0]!.mon, 'Garchomp-Mega');
  assert.equal(t1!.actions[1]!.target, 'Garchomp-Mega');
  assert.deepEqual(t1!.actions[1]!.outcome?.targets, { 'Garchomp-Mega': { hp: 40 } });
  assert.deepEqual(t1!.order, ['me:Garchomp-Mega', 'opp:Torkoal']);
  assert.deepEqual(t1!.hpEnd, { 'me:Garchomp-Mega': 40 });
  assert.equal(t1!.children[0]!.actions[0]!.target, 'Garchomp-Mega');

  renameMonInPlans(plans, 'Incineroar', 'Rillaboom');
  assert.equal(t1!.actions[2]!.mon, 'Rillaboom');
  assert.equal(t1!.actions[2]!.target, 'Incineroar'); // the opponent's Incineroar
});

test('planImpact finds renames and losses between two versions of the team', () => {
  const plans = [planWith()];
  const before = parseShowdown('Incineroar\n- Fake Out\n- Flare Blitz\n\nGarchomp\n- Earthquake\n- Protect');
  const parse = (s: string): ReturnType<typeof parseShowdown> => parseShowdown(s);

  // One species swapped (anywhere) and one move replaced: both renames.
  const swapped = planImpact(before, parse('Incineroar\n- Fake Out\n- Flare Blitz\n\nGarchomp-Mega\n- High Horsepower\n- Protect'), plans);
  assert.deepEqual(swapped.renames.map((r) => `${r.kind}:${r.from}->${r.to}`), ['mon:Garchomp->Garchomp-Mega', 'move:Earthquake->High Horsepower']);
  assert.equal(swapped.losses.length, 0);

  // A Pokémon taken out, and a move cleared: losses.
  const cut = planImpact(before, parse('Garchomp\n- Protect'), plans);
  assert.deepEqual(cut.losses.map((l) => `${l.kind}:${l.name}`), ['mon:Incineroar', 'move:Earthquake']);

  // Reordering or changing what no gameplan uses changes nothing.
  assert.deepEqual(planImpact(before, parse('Garchomp\n- Earthquake\n- Rock Slide\n\nIncineroar\n- Fake Out\n- Flare Blitz'), plans), { renames: [], losses: [] });

  // Renames go to the plans: the move under the old name first, then the Pokémon.
  applyRenames(plans, swapped.renames);
  const [t1] = plans[0]!.tabs[0]!.children;
  assert.equal(t1!.actions[0]!.mon, 'Garchomp-Mega');
  assert.equal(t1!.actions[0]!.move, 'High Horsepower');
});

test('renameMoveInPlans only touches that Pokémon\'s move', () => {
  const plans = [planWith()];
  renameMoveInPlans(plans, 'Garchomp', 'Earthquake', 'Stomping Tantrum');
  const [t1] = plans[0]!.tabs[0]!.children;
  assert.equal(t1!.actions[0]!.move, 'Stomping Tantrum');
  assert.equal(t1!.actions[1]!.move, 'Eruption');
});
