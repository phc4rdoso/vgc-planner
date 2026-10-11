/**
 * Species the real calculator names differently from a team paste: Megas whose base form isn't the name without
 * "-Mega" (Floette-Mega comes from Floette-Eternal), and Aegislash, which the calculator only has by form.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as calc from '@smogon/calc';
import { newNode, newPlan, newTeam, sheetOf } from '../src/domain/model.ts';
import { baseSpecies } from '../src/domain/showdown.ts';
import type { CalcLib } from '../src/domain/simulation/calc-types.ts';
import { createEngine } from '../src/domain/simulation/engine.ts';
import type { LogEntry, TurnResult } from '../src/domain/simulation/log.ts';
import { simulatePlan } from '../src/domain/simulation/plan.ts';
import type { Side, TurnAction } from '../src/domain/types.ts';

type Ready = Extract<TurnResult, { status: 'ready' }>;
const engine = createEngine(calc as unknown as CalcLib);
const act = (side: Side, mon: string, move: string, target = '', kind: TurnAction['kind'] = 'move'): TurnAction => ({ side, mon, kind, move, target });

/** Plays turns down one branch with the real calculator; every turn must simulate. */
function play(me: string, opp: string, leads: Record<Side, string[]>, ...turns: TurnAction[][]): Ready[] {
  const team = newTeam('T', me);
  const gameplan = newPlan('p', opp);
  const plan = sheetOf(gameplan, gameplan.tabs[0]!);
  plan.selection.me.lead = leads.me;
  plan.selection.opp.lead = leads.opp;
  const nodes = turns.map((actions) => newNode({ actions }));
  let parent: { children: typeof nodes } = plan;
  for (const n of nodes) { parent.children.push(n); parent = n; }
  const results = simulatePlan(engine, team, plan);
  return nodes.map((n, i) => {
    const r = results.get(n.id);
    assert.equal(r?.status, 'ready', `turn ${i + 1}: ${JSON.stringify(r)}`);
    return r as Ready;
  });
}

const FLOETTE = 'Floette-Mega @ Floettite\nAbility: Fairy Aura\nEVs: 11 HP / 8 Def / 25 SpA / 22 Spe\nTimid Nature\n- Dazzling Gleam\n- Moonblast\n- Protect';
const KINGAMBIT = 'Kingambit @ Chople Berry\nAbility: Defiant\nEVs: 31 HP / 32 Atk\nAdamant Nature\n- Kowtow Cleave\n- Protect';
const FOES = 'Golisopod-Mega @ Golisopite\nAbility: Emergency Exit\nEVs: 32 HP / 32 Atk\nAdamant Nature\n- Leech Life\n- Protect\n\n'
  + 'Farigiraf @ Sitrus Berry\nAbility: Armor Tail\nEVs: 31 HP / 20 Def / 15 SpD\nBold Nature\n- Psychic\n- Trick Room';

test('a Mega whose base form is another form: the paste\'s Floette-Mega starts as Floette-Eternal', () => {
  assert.equal(baseSpecies('Floette-Mega'), 'Floette-Eternal');
  assert.equal(baseSpecies('Meowstic-M-Mega'), 'Meowstic');
  assert.equal(baseSpecies('Meowstic-F-Mega'), 'Meowstic-F');
  assert.equal(baseSpecies('Charizard-Mega-Y'), 'Charizard', 'the usual Megas are unchanged');
  for (const form of ['Floette-Eternal', 'Meowstic', 'Meowstic-F']) assert.ok(engine.baseStats(form), `${form} is in the calculator`);

  const [r1, r2] = play(`${FLOETTE}\n\n${KINGAMBIT}`, FOES, { me: ['Floette-Mega', 'Kingambit'], opp: ['Golisopod-Mega', 'Farigiraf'] },
    [act('me', 'Floette-Mega', 'Protect'), act('me', 'Kingambit', 'Protect'), act('opp', 'Golisopod-Mega', 'Protect'), act('opp', 'Farigiraf', 'Psychic', 'Kingambit')],
    [act('me', 'Floette-Mega', 'Moonblast', 'Golisopod-Mega', 'mega'), act('me', 'Kingambit', 'Kowtow Cleave', 'Farigiraf'), act('opp', 'Golisopod-Mega', 'Leech Life', 'Kingambit'), act('opp', 'Farigiraf', 'Psychic', 'Kingambit')],
  );
  assert.equal(r1!.state.mons.me['Floette-Mega']!.species, 'Floette-Eternal');
  assert.equal(r2!.state.mons.me['Floette-Mega']!.species, 'Floette-Mega', 'Mega Evolves with Floettite');
});

test('Meowsticite: Meowstic becomes Meowstic-M-Mega, and a female Meowstic its own Mega', () => {
  assert.equal(engine.megaOf('Meowstic', 'Meowsticite'), 'Meowstic-M-Mega');
  assert.equal(engine.megaOf('Meowstic-F', 'Meowsticite'), 'Meowstic-F-Mega');
  assert.equal(engine.megaOf('Floette-Eternal', 'Floettite'), 'Floette-Mega');
  assert.equal(engine.megaOf('Garchomp', 'Floettite'), null, 'a stone for someone else does nothing');
});

test('Aegislash starts in Shield Forme, turns to Blade to attack and back to Shield with King\'s Shield', () => {
  const aegislash = 'Aegislash @ Leftovers\nAbility: Stance Change\nEVs: 32 HP / 32 Atk\nAdamant Nature\n- Shadow Sneak\n- Iron Head\n- King\'s Shield';
  const forms = (log: readonly LogEntry[]): string[] => log.flatMap((l) => (l.type === 'effect' && l.mon === 'Aegislash' ? [l.text] : []));
  const [r1, r2] = play(`${aegislash}\n\n${KINGAMBIT}`, FOES, { me: ['Aegislash', 'Kingambit'], opp: ['Golisopod-Mega', 'Farigiraf'] },
    [act('me', 'Aegislash', 'Iron Head', 'Farigiraf'), act('me', 'Kingambit', 'Protect'), act('opp', 'Golisopod-Mega', 'Protect'), act('opp', 'Farigiraf', 'Psychic', 'Aegislash')],
    [act('me', 'Aegislash', 'King\'s Shield'), act('me', 'Kingambit', 'Protect'), act('opp', 'Golisopod-Mega', 'Protect'), act('opp', 'Farigiraf', 'Psychic', 'Kingambit')],
  );
  assert.deepEqual(forms(r1!.log), ['changes to Blade Forme']);
  assert.equal(r1!.state.mons.me.Aegislash!.species, 'Aegislash-Blade');
  assert.deepEqual(forms(r2!.log), ['changes to Shield Forme']);
  assert.equal(r2!.state.mons.me.Aegislash!.species, 'Aegislash-Shield');
});
