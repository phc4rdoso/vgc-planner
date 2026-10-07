import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNode, newPlan, newTeam, sheetOf } from '../src/domain/model.ts';
import { createEngine, rollsOf } from '../src/domain/simulation/engine.ts';
import { turnResultsGate } from '../src/domain/simulation/gate.ts';
import type { TurnResult } from '../src/domain/simulation/log.ts';
import { simulatePlan } from '../src/domain/simulation/plan.ts';
import { canMegaEvolve, fieldAfterReplacements, fieldEffects, nextActions, outcomeOf, syncTurnActions } from '../src/domain/simulation/state.ts';
import type { ActionKind, Sheet, Side, Team } from '../src/domain/types.ts';
import { makeStubCalc } from './helpers/stub-calc.ts';

const act = (side: Side, mon: string, kind: ActionKind, move: string, target = '') => ({ side, mon, kind, move, target });
const set = (name: string, ability: string, moves: string, extra = 'EVs: 32 HP / 32 Atk / 2 Spe\nAdamant Nature', item = '') =>
  `${name}${item ? ` @ ${item}` : ''}\nAbility: ${ability}\n${extra}\n${moves}`;

const MY_TEAM = [set('Rillaboom', 'Grassy Surge', '- Fake Out'), set('Garchomp', 'Rough Skin', '- Earthquake')].join('\n\n');
const OPP_TEAM = [set('Incineroar', 'Blaze', '- Flare Blitz'), set('Kingambit', 'Defiant', '- Protect')].join('\n\n');

/** A gameplan's first tab with the given leads, as the sheet the simulation runs on. */
function setup(myPaste = MY_TEAM, oppPaste = OPP_TEAM, leads = { me: ['Rillaboom', 'Garchomp'], opp: ['Incineroar', 'Kingambit'] }): { team: Team; plan: Sheet } {
  const team = newTeam('T', myPaste);
  const gameplan = newPlan('p', oppPaste);
  const plan = sheetOf(gameplan, gameplan.tabs[0]!);
  plan.selection.me.lead = leads.me; plan.selection.opp.lead = leads.opp;
  return { team, plan };
}
const run = (plan: Sheet, team: Team, champions = true): { results: Map<string, TurnResult>; calls: ReturnType<typeof makeStubCalc>['calls'] } => {
  const { lib, calls } = makeStubCalc({ champions });
  return { results: simulatePlan(createEngine(lib), team, plan), calls };
};
function ready(r: TurnResult | undefined): Extract<TurnResult, { status: 'ready' }> {
  assert.equal(r?.status, 'ready', JSON.stringify(r));
  return r as Extract<TurnResult, { status: 'ready' }>;
}

test('engine finds the Champions generation, or falls back to Gen 9', () => {
  assert.equal(createEngine(makeStubCalc().lib).native, true);
  assert.equal(createEngine(makeStubCalc({ champions: false }).lib).native, false);
});

test('turn results need an EVs line on every Pokémon of both teams', () => {
  const { team, plan } = setup();
  assert.equal(turnResultsGate(team, plan).enabled, true);
  plan.opponent.paste = 'Incineroar @ Sitrus Berry\n- Protect';
  const gate = turnResultsGate(team, plan);
  assert.equal(gate.enabled, false);
  assert.match(gate.reasons.join(), /Incineroar/);
});

test('moves resolve by priority then speed; Protect blocks, Fake Out flinches, spread hits the ally too', () => {
  const { team, plan } = setup();
  const n = newNode({ actions: [
    act('me', 'Rillaboom', 'move', 'Fake Out', 'Incineroar'), act('me', 'Garchomp', 'move', 'Earthquake', 'Both foes'),
    act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Rillaboom'), act('opp', 'Kingambit', 'move', 'Protect'),
  ] });
  plan.children.push(n);
  const { results, calls } = run(plan, team);
  const r = ready(results.get(n.id));
  assert.deepEqual(r.log.slice(0, 2).map((l) => `${l.mon}:${'move' in l ? l.move : l.type}`), ['Kingambit:Protect', 'Rillaboom:Fake Out']);
  const eq = r.log.find((l) => l.type === 'hit' && l.move === 'Earthquake');
  assert.equal(eq?.type === 'hit' && eq.results.length, 3);
  assert.ok(eq?.type === 'hit' && eq.results.find((x) => x.mon === 'Kingambit')?.protected);
  assert.ok(r.log.some((l) => l.type === 'skip' && l.mon === 'Incineroar' && l.why === 'flinched'));
  assert.ok(!r.log.some((l) => 'move' in l && l.move === 'Flare Blitz'));
  assert.ok(calls.filter((c) => c.move === 'Earthquake').every((c) => c.field.gameType === 'Doubles'));
});

test('an incomplete turn lists what is missing and blocks its follow-ups', () => {
  const { team, plan } = setup();
  const n = newNode({ actions: [act('me', 'Rillaboom', 'move', 'Fake Out', 'Incineroar')] });
  const child = newNode();
  n.children.push(child); plan.children.push(n);
  const { results } = run(plan, team);
  const r = results.get(n.id);
  assert.equal(r?.status, 'incomplete');
  assert.ok(r?.status === 'incomplete' && r.missing.some((m) => /Garchomp needs an action/.test(m)));
  assert.equal(results.get(child.id)?.status, 'blocked');
});

test('a damaging move without a target asks for one', () => {
  const { team, plan } = setup();
  const n = newNode({ actions: [
    act('me', 'Rillaboom', 'move', 'Fake Out', ''), act('me', 'Garchomp', 'move', 'Protect'),
    act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Protect'),
  ] });
  plan.children.push(n);
  const r = run(plan, team).results.get(n.id);
  assert.ok(r?.status === 'incomplete' && /pick a target/.test(r.missing[0] ?? ''));
});

test('setup boosts persist across turns and feed later damage', () => {
  const { team, plan } = setup();
  const t1 = newNode({ actions: [
    act('me', 'Rillaboom', 'move', 'Swords Dance'), act('me', 'Garchomp', 'move', 'Protect'),
    act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Protect'),
  ] });
  const t2 = newNode({ actions: [
    act('me', 'Rillaboom', 'move', 'Fake Out', 'Incineroar'), act('me', 'Garchomp', 'move', 'Protect'),
    act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Protect'),
  ] });
  t1.children.push(t2); plan.children.push(t1);
  const { results } = run(plan, team);
  const r1 = ready(results.get(t1.id));
  const sd = r1.log.find((l) => l.type === 'boost' && l.move === 'Swords Dance');
  assert.deepEqual(sd?.type === 'boost' && sd.changes, [{ stat: 'atk', delta: 2 }]);
  const r2 = ready(results.get(t2.id));
  assert.deepEqual(r2.end.find((x) => x.name === 'Rillaboom')?.boosts, [{ stat: 'atk', delta: 2 }]);
});

test('knocked-out Pokémon are greyed in the snapshot and need no action next turn', () => {
  const weak = 'Flutter\nAbility: x\nEVs: 0 HP\n- Protect\n\nGarchomp\nAbility: Rough Skin\nEVs: 32 Atk\nAdamant Nature\n- Earthquake';
  const strong = set('Kingambit', 'Defiant', '- Flare Blitz', 'EVs: 32 HP / 32 Atk\nAdamant Nature') + '\n\n' + set('Incineroar', 'Blaze', '- Protect', 'EVs: 32 Atk');
  const { team, plan } = setup(weak, strong, { me: ['Flutter', 'Garchomp'], opp: ['Kingambit', 'Incineroar'] });
  const t1 = newNode({ actions: [
    act('me', 'Flutter', 'move', 'Swords Dance'), act('me', 'Garchomp', 'move', 'Earthquake', 'Both foes'),
    act('opp', 'Kingambit', 'move', 'Close Combat', 'Flutter'), act('opp', 'Incineroar', 'move', 'Protect'),
  ] });
  const t2 = newNode({ actions: [act('me', 'Garchomp', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Protect'), act('opp', 'Incineroar', 'move', 'Protect')] });
  t1.children.push(t2); plan.children.push(t1);
  const { results } = run(plan, team);
  const r1 = ready(results.get(t1.id));
  const flutter = r1.end.find((e) => e.name === 'Flutter');
  assert.equal(flutter?.fainted, true);
  assert.equal(flutter?.pct, 0);
  const hit = r1.log.find((l) => l.type === 'hit' && l.move === 'Close Combat');
  assert.equal(hit?.type === 'hit' && hit.results[0]?.koChance, 100);
  assert.ok(hit?.type === 'hit' && hit.self?.some((c) => c.stat === 'def' && c.delta === -1), 'Close Combat lowers the user\'s Defense');
  ready(results.get(t2.id));
});

test('Intimidate on entry, Mega Evolution, Helping Hand and Tailwind', () => {
  const mine = [set('Aerodactyl', 'Pressure', '- Earthquake', 'EVs: 32 Atk\nAdamant Nature', 'Aerodactylite'), set('Garchomp', 'Rough Skin', '- Earthquake', 'EVs: 32 Atk\nAdamant Nature')].join('\n\n');
  const opp = [set('Incineroar', 'Intimidate', '- Flare Blitz', 'EVs: 32 Atk'), set('Kingambit', 'Defiant', '- Protect', 'EVs: 32 Atk')].join('\n\n');
  const { team, plan } = setup(mine, opp, { me: ['Aerodactyl', 'Garchomp'], opp: ['Incineroar', 'Kingambit'] });
  const n = newNode({ actions: [
    act('me', 'Aerodactyl', 'mega', 'Flare Blitz', 'Kingambit'), act('me', 'Garchomp', 'move', 'Helping Hand'),
    act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Tailwind'),
  ] });
  plan.children.push(n);
  const { results, calls } = run(plan, team);
  const r = ready(results.get(n.id));
  assert.equal(r.entry.length, 2);
  assert.ok(r.entry.every((e) => e.type === 'boost' && e.changes[0]?.delta === -1));
  const mega = r.log.find((l) => l.type === 'mega');
  assert.equal(mega?.type === 'mega' && mega.species, 'Aerodactyl-Mega');
  const aero = r.end.find((e) => e.name === 'Aerodactyl');
  assert.equal(aero?.species, 'Aerodactyl-Mega');
  assert.ok(aero?.boosts.some((b) => b.stat === 'atk' && b.delta === -1));
  const call = calls.find((c) => c.move === 'Flare Blitz');
  assert.equal(call?.attacker, 'Aerodactyl-Mega');
  assert.equal(call?.attackerBoostAtk, -1);
  assert.equal(call?.field.attackerSide.isHelpingHand, true);
  assert.equal(r.state.field.tailwind.opp, 3, 'Tailwind lasts 4 turns and has ticked once');
});

test('Trick Room reverses speed order but not priority', () => {
  const { team, plan } = setup();
  const t1 = newNode({ actions: [
    act('me', 'Rillaboom', 'move', 'Protect'), act('me', 'Garchomp', 'move', 'Protect'),
    act('opp', 'Incineroar', 'move', 'Trick Room'), act('opp', 'Kingambit', 'move', 'Protect'),
  ] });
  const t2 = newNode({ actions: [
    act('me', 'Rillaboom', 'move', 'Protect'), act('me', 'Garchomp', 'move', 'Protect'),
    act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Protect'),
  ] });
  t1.children.push(t2); plan.children.push(t1);
  const { results } = run(plan, team);
  assert.equal(ready(results.get(t1.id)).state.field.trick, 4);
  const order = ready(results.get(t2.id)).log.map((l) => l.mon);
  assert.equal(order[0], 'Kingambit', 'slowest Protect first under Trick Room');
  assert.equal(order[order.length - 1], 'Garchomp', 'fastest last');
});

test('simulating does not mutate the plan', () => {
  const { team, plan } = setup();
  plan.children.push(newNode({ actions: [act('me', 'Rillaboom', 'move', 'Swords Dance')] }));
  const before = JSON.stringify(plan);
  run(plan, team);
  assert.equal(JSON.stringify(plan), before);
});

test('rollsOf normalises numbers, rolls and multi-hit lists', () => {
  assert.deepEqual(rollsOf(5), [5]);
  assert.deepEqual(rollsOf([1, 2]), [1, 2]);
  assert.deepEqual(rollsOf([[1, 2], [3, 4]]), [4, 6]);
  assert.deepEqual(rollsOf(undefined), [0]);
});

/** All four actions for the default leads (Rillaboom, Garchomp vs Incineroar, Kingambit). */
const turn = (ril: string, chomp: string, inci: string, gambit: string, targets: Partial<Record<'ril' | 'chomp' | 'inci' | 'gambit', string>> = {}) => newNode({ actions: [
  act('me', 'Rillaboom', 'move', ril, targets.ril), act('me', 'Garchomp', 'move', chomp, targets.chomp),
  act('opp', 'Incineroar', 'move', inci, targets.inci), act('opp', 'Kingambit', 'move', gambit, targets.gambit),
] });

test('a burn carries down the branch: it halves physical damage and chips 1/16 every turn', () => {
  // No Grassy Surge: Grassy Terrain's healing would make up for the burn's chip damage.
  const { team, plan } = setup(MY_TEAM.replace('Grassy Surge', 'Overgrow'));
  const t1 = turn('Protect', 'Swords Dance', 'Will-O-Wisp', 'Protect', { inci: 'Garchomp' });
  const t2 = turn('Protect', 'Close Combat', 'Swords Dance', 'Protect', { chomp: 'Incineroar' });
  t1.children.push(t2); plan.children.push(t1);
  const { results, calls } = run(plan, team);
  const r1 = ready(results.get(t1.id));
  const wisp = r1.log.find((l) => l.type === 'status');
  assert.deepEqual(wisp?.type === 'status' && wisp.targets.map((t) => [t.mon, t.status]), [['Garchomp', 'brn']]);
  const burn1 = r1.log.find((l) => l.type === 'residual');
  assert.ok(burn1?.type === 'residual' && burn1.mon === 'Garchomp' && burn1.pct < 0);
  const chomp1 = r1.end.find((e) => e.name === 'Garchomp');
  assert.equal(chomp1?.condition, 'brn');

  const r2 = ready(results.get(t2.id));
  assert.equal(calls.find((c) => c.move === 'Close Combat')?.attackerStatus, 'brn', 'the calculator is told about the burn');
  const chomp2 = r2.end.find((e) => e.name === 'Garchomp');
  assert.equal(chomp2?.condition, 'brn');
  assert.ok((chomp2?.pct ?? 100) < (chomp1?.pct ?? 0), 'burn damage accumulates from the parent turn');
});

test('conditions respect type immunities, powder immunity and cure berries', () => {
  const { team, plan } = setup();
  const n = turn('Will-O-Wisp', 'Toxic', 'Thunder Wave', 'Spore', { ril: 'Incineroar', chomp: 'Kingambit', inci: 'Garchomp', gambit: 'Rillaboom' });
  plan.children.push(n);
  const r = ready(run(plan, team).results.get(n.id));
  const blocked = Object.fromEntries(r.log.flatMap((l) => (l.type === 'status' ? l.targets.map((t) => [t.mon, t.blocked]) : [])));
  assert.deepEqual(blocked, { Incineroar: 'Fire type', Kingambit: 'Steel type', Garchomp: 'Ground type', Rillaboom: 'immune to powder' });
  assert.ok(r.end.every((e) => e.condition === null));

  const lum = MY_TEAM.replace('Garchomp\n', 'Garchomp @ Lum Berry\n');
  const s = setup(lum);
  const t1 = turn('Protect', 'Swords Dance', 'Will-O-Wisp', 'Protect', { inci: 'Garchomp' });
  const t2 = turn('Protect', 'Swords Dance', 'Will-O-Wisp', 'Protect', { inci: 'Garchomp' });
  t1.children.push(t2); s.plan.children.push(t1);
  const res = run(s.plan, s.team).results;
  const first = ready(res.get(t1.id)).log.find((l) => l.type === 'status');
  assert.ok(first?.type === 'status' && first.targets[0]?.cured === 'Lum Berry');
  assert.equal(ready(res.get(t1.id)).end.find((e) => e.name === 'Garchomp')?.condition, null);
  assert.equal(ready(res.get(t2.id)).end.find((e) => e.name === 'Garchomp')?.condition, 'brn', 'the berry was used up in the parent turn');
});

test('sleep skips the next action, then the Pokémon wakes up', () => {
  const { team, plan } = setup();
  const t1 = turn('Protect', 'Swords Dance', 'Protect', 'Spore', { gambit: 'Garchomp' });
  const t2 = turn('Protect', 'Swords Dance', 'Protect', 'Protect');
  const t3 = turn('Protect', 'Swords Dance', 'Protect', 'Protect');
  t1.children.push(t2); t2.children.push(t3); plan.children.push(t1);
  const { results } = run(plan, team);
  assert.equal(ready(results.get(t1.id)).end.find((e) => e.name === 'Garchomp')?.condition, 'slp');
  const r2 = ready(results.get(t2.id));
  assert.ok(r2.log.some((l) => l.type === 'skip' && l.mon === 'Garchomp' && /asleep/.test(l.why)));
  const r3 = ready(results.get(t3.id));
  assert.ok(r3.log.some((l) => l.type === 'cure' && l.mon === 'Garchomp'));
  const chomp = r3.end.find((e) => e.name === 'Garchomp');
  assert.equal(chomp?.condition, null);
  assert.deepEqual(chomp?.boosts, [{ stat: 'atk', delta: 4 }], 'boosted on turns 1 and 3, asleep on turn 2');
});

test('paralysis halves Speed in later turns', () => {
  const { team, plan } = setup();
  const t1 = turn('Swords Dance', 'Swords Dance', 'Thunder Wave', 'Swords Dance', { inci: 'Rillaboom' });
  const t2 = turn('Swords Dance', 'Swords Dance', 'Swords Dance', 'Swords Dance');
  t1.children.push(t2); plan.children.push(t1);
  const { results } = run(plan, team);
  const order = (id: string): string[] => ready(results.get(id)).log.filter((l) => l.type === 'boost').map((l) => l.mon);
  const before = order(t1.id);
  assert.ok(before.indexOf('Rillaboom') < before.indexOf('Kingambit'));
  const after = order(t2.id);
  assert.ok(after.indexOf('Rillaboom') > after.indexOf('Kingambit'), 'paralyzed Rillaboom is now slower than Kingambit');
});

test('field effects in play are reported per turn and inherited by follow-up turns', () => {
  const { team, plan } = setup();
  const t1 = turn('Protect', 'Protect', 'Trick Room', 'Tailwind');
  const t2 = newNode();
  t1.children.push(t2); plan.children.push(t1);
  const { results } = run(plan, team);
  const during = fieldEffects(ready(results.get(t1.id)).field);
  assert.deepEqual(during, [
    { label: 'Grassy Terrain', side: null, left: 4 },
    { label: 'Trick Room', side: null, left: 4 },
    { label: 'Tailwind', side: 'opp', left: 3 },
  ]);
  const next = results.get(t2.id);
  assert.equal(next?.status, 'incomplete');
  assert.deepEqual(next?.status === 'incomplete' && fieldEffects(next.field).map((f) => `${f.label}:${f.left}`), ['Grassy Terrain:3', 'Trick Room:3', 'Tailwind:2']);
});

/** The Pokémon that acted, in order (switches, boosts, hits...), ignoring entry effects. */
const actors = (r: Extract<TurnResult, { status: 'ready' }>): string[] => r.log.filter((l) => (l.type !== 'field' || l.move !== '') && l.type !== 'residual').map((l) => l.mon);
/** Why `move` didn't affect its first target (the block reason), from an attack, stat-lowering or status move. */
const whyBlocked = (r: Extract<TurnResult, { status: 'ready' }>, move: string): string | undefined => {
  for (const l of r.log) {
    if (l.type === 'hit' && l.move === move) return l.results[0]?.blockedBy;
    if ((l.type === 'debuff' || l.type === 'status') && l.move === move) return l.targets[0]?.blocked;
  }
  throw new Error(`${move} not in log`);
};

test('Grassy Glide has +1 priority in Grassy Terrain, and only there', () => {
  const mine = (ability: string) => [set('Rillaboom', ability, '- Protect'), set('Kingambit', 'Defiant', '- Grassy Glide')].join('\n\n');
  const opp = [set('Garchomp', 'Rough Skin', '- Swords Dance'), set('Incineroar', 'Blaze', '- Swords Dance')].join('\n\n');
  const order = (ability: string): string[] => {
    const { team, plan } = setup(mine(ability), opp, { me: ['Rillaboom', 'Kingambit'], opp: ['Garchomp', 'Incineroar'] });
    const n = newNode({ actions: [
      act('me', 'Rillaboom', 'move', 'Protect'), act('me', 'Kingambit', 'move', 'Grassy Glide', 'Incineroar'),
      act('opp', 'Garchomp', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'),
    ] });
    plan.children.push(n);
    return actors(ready(run(plan, team).results.get(n.id)));
  };
  assert.deepEqual(order('Grassy Surge'), ['Rillaboom', 'Kingambit', 'Garchomp', 'Incineroar']);
  assert.deepEqual(order('Overgrow'), ['Rillaboom', 'Garchomp', 'Incineroar', 'Kingambit'], 'slowest without the terrain');
});

test('Gale Wings gives Flying moves +1 priority only at full HP', () => {
  const opp = [set('Kingambit', 'Gale Wings', '- Brave Bird'), set('Incineroar', 'Blaze', '- Protect')].join('\n\n');
  const { team, plan } = setup(MY_TEAM, opp);
  const t1 = turn('Swords Dance', 'Swords Dance', 'Swords Dance', 'Brave Bird', { gambit: 'Garchomp' });
  const t2 = turn('Swords Dance', 'Earthquake', 'Protect', 'Brave Bird', { chomp: 'Both foes', gambit: 'Garchomp' });
  const t3 = turn('Swords Dance', 'Swords Dance', 'Swords Dance', 'Brave Bird', { gambit: 'Garchomp' });
  t1.children.push(t2); t2.children.push(t3); plan.children.push(t1);
  const { results } = run(plan, team);
  assert.equal(actors(ready(results.get(t1.id)))[0], 'Kingambit', 'full HP: moves first despite being slowest');
  const r3 = ready(results.get(t3.id));
  assert.equal(actors(r3).at(-1), 'Kingambit', 'hurt by Earthquake on turn 2: back to normal speed order');
});

test('priority moves fail into Psychic Terrain, priority-blocking abilities and Quick Guard (including Prankster moves)', () => {
  // Psychic Terrain set on turn 1 stops a priority attack on a grounded target on turn 2 (Fake Out would fail anyway after turn 1).
  const s = setup();
  const t1 = turn('Protect', 'Protect', 'Psychic Terrain', 'Protect');
  const t2 = turn('Aqua Jet', 'Swords Dance', 'Swords Dance', 'Swords Dance', { ril: 'Incineroar' });
  t1.children.push(t2); s.plan.children.push(t1);
  const r2 = ready(run(s.plan, s.team).results.get(t2.id));
  assert.equal(whyBlocked(r2, 'Aqua Jet'), 'Psychic Terrain');
  assert.ok(!r2.log.some((l) => l.type === 'skip' && l.why === 'flinched'), 'the blocked move does nothing');

  // Armor Tail on Incineroar protects its partner too.
  const tail = setup(MY_TEAM, OPP_TEAM.replace('Ability: Blaze', 'Ability: Armor Tail'));
  const n = turn('Fake Out', 'Protect', 'Swords Dance', 'Swords Dance', { ril: 'Kingambit' });
  tail.plan.children.push(n);
  assert.equal(whyBlocked(ready(run(tail.plan, tail.team).results.get(n.id)), 'Fake Out'), "Incineroar's Armor Tail");

  // Quick Guard stops a Prankster-boosted Screech.
  const qg = setup(MY_TEAM.replace('Ability: Rough Skin', 'Ability: Prankster'));
  const q = turn('Protect', 'Screech', 'Swords Dance', 'Quick Guard', { chomp: 'Incineroar' });
  qg.plan.children.push(q);
  const rq = ready(run(qg.plan, qg.team).results.get(q.id));
  assert.equal(whyBlocked(rq, 'Screech'), 'Quick Guard');
});

test('Electric Terrain prevents sleep and Misty Terrain prevents every condition for grounded Pokémon', () => {
  const electric = setup(MY_TEAM.replace('Grassy Surge', 'Electric Surge'));
  const n = turn('Protect', 'Swords Dance', 'Protect', 'Spore', { gambit: 'Garchomp' });
  electric.plan.children.push(n);
  assert.equal(whyBlocked(ready(run(electric.plan, electric.team).results.get(n.id)), 'Spore'), 'Electric Terrain');

  const misty = setup(MY_TEAM.replace('Grassy Surge', 'Misty Surge'));
  const m = turn('Protect', 'Swords Dance', 'Will-O-Wisp', 'Protect', { inci: 'Garchomp' });
  misty.plan.children.push(m);
  assert.equal(whyBlocked(ready(run(misty.plan, misty.team).results.get(m.id)), 'Will-O-Wisp'), 'Misty Terrain');
});

const WITH_BENCH =[MY_TEAM, set('Aerodactyl', 'Pressure', '- Rock Slide'), set('Flutter', 'x', '- Protect', 'EVs: 0 HP')].join('\n\n');

test('a pivot move switches to the chosen Pokémon only if it hits, and asks for one when missing', () => {
  const { team, plan } = setup(WITH_BENCH);
  plan.selection.me.back = ['Aerodactyl', 'Flutter'];
  const n = turn('U-turn', 'Protect', 'Swords Dance', 'Swords Dance', { ril: 'Incineroar' });
  plan.children.push(n);
  const missing = run(plan, team).results.get(n.id);
  assert.ok(missing?.status === 'incomplete' && /Rillaboom: choose who comes in after U-turn/.test(missing.missing[0] ?? ''), JSON.stringify(missing));

  n.actions[0]!.pivot = 'Aerodactyl';
  const r = ready(run(plan, team).results.get(n.id));
  const hit = r.log.findIndex((l) => l.type === 'hit' && l.move === 'U-turn');
  const sw = r.log.findIndex((l) => l.type === 'switch' && l.mon === 'Rillaboom' && l.in === 'Aerodactyl');
  assert.ok(hit >= 0 && sw === hit + 1, 'switches straight after the hit');
  assert.deepEqual(r.state.active.me, ['Aerodactyl', 'Garchomp']);

  n.actions[0]!.pivot = 'Garchomp';
  const onField = run(plan, team).results.get(n.id);
  assert.ok(onField?.status === 'incomplete' && /can.t come in/.test(onField.missing[0] ?? ''), 'the ally on the field is not an option');

  const blocked = turn('U-turn', 'Protect', 'Protect', 'Swords Dance', { ril: 'Incineroar' });
  blocked.actions[0]!.pivot = 'Aerodactyl';
  plan.children = [blocked];
  const rb = ready(run(plan, team).results.get(blocked.id));
  assert.ok(!rb.log.some((l) => l.type === 'switch'), 'no switch when the move is blocked');
  assert.deepEqual(rb.state.active.me, ['Rillaboom', 'Garchomp']);
});

test('a move aimed at a Pokémon that pivoted out hits the one that took its place', () => {
  const { team, plan } = setup(WITH_BENCH);
  plan.selection.me.back = ['Aerodactyl', 'Flutter'];
  const n = turn('U-turn', 'Protect', 'Flare Blitz', 'Swords Dance', { ril: 'Incineroar', inci: 'Rillaboom' });
  n.actions[0]!.pivot = 'Aerodactyl';
  plan.children.push(n);
  const r = ready(run(plan, team).results.get(n.id));
  const blitz = r.log.find((l) => l.type === 'hit' && l.move === 'Flare Blitz');
  assert.deepEqual(blitz?.type === 'hit' && blitz.results.map((x) => x.mon), ['Aerodactyl']);
});

test('a fainted Pokémon is replaced by the benched Pokémon given an action in the next turn', () => {
  const mine = [set('Flutter', 'x', '- Protect', 'EVs: 0 HP'), set('Garchomp', 'Rough Skin', '- Earthquake'), set('Rillaboom', 'Grassy Surge', '- Fake Out'), set('Aerodactyl', 'Pressure', '- Rock Slide')].join('\n\n');
  const opp = [set('Kingambit', 'Defiant', '- Close Combat'), set('Incineroar', 'Blaze', '- Protect')].join('\n\n');
  const { team, plan } = setup(mine, opp, { me: ['Flutter', 'Garchomp'], opp: ['Kingambit', 'Incineroar'] });
  plan.selection.me.back = ['Rillaboom', 'Aerodactyl'];
  const t1 = newNode({ actions: [
    act('me', 'Flutter', 'move', 'Swords Dance'), act('me', 'Garchomp', 'move', 'Protect'),
    act('opp', 'Kingambit', 'move', 'Close Combat', 'Flutter'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Flutter'),
  ] });
  const t2 = newNode({ actions: [act('me', 'Garchomp', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Protect'), act('opp', 'Incineroar', 'move', 'Protect')] });
  t1.children.push(t2); plan.children.push(t1);
  let results = run(plan, team).results;
  const r1 = ready(results.get(t1.id));
  assert.equal(r1.outcome, null);
  assert.deepEqual(nextActions(r1.state).filter((a) => a.side === 'me').map((a) => `${a.mon || '(choose)'}:${a.kind}`), ['Garchomp:move', '(choose):move'],
    'the fainted slot gets an action with no Pokémon picked yet');
  const r2 = results.get(t2.id);
  assert.ok(r2?.status === 'incomplete' && r2.missing.includes('Flutter fainted: add an action for its replacement (Rillaboom or Aerodactyl)'), JSON.stringify(r2));

  t2.actions.unshift(act('me', 'Rillaboom', 'move', 'Swords Dance'));
  results = run(plan, team).results;
  const done = ready(results.get(t2.id));
  assert.ok(done.log[0]?.type === 'switch' && done.log[0].replace === true && done.log[0].mon === 'Flutter' && done.log[0].in === 'Rillaboom');
  assert.ok(done.log.some((l) => l.type === 'boost' && l.mon === 'Rillaboom'), 'the replacement acts this turn');
  assert.deepEqual(done.state.active.me, ['Rillaboom', 'Garchomp'], 'it takes the fainted Pokémon’s slot');

  t2.actions[0] = act('me', 'Flutter', 'move', 'Swords Dance');
  const again = results = run(plan, team).results;
  assert.ok(again.get(t2.id)?.status === 'incomplete', 'a fainted Pokémon cannot act');
});

test('with nobody left to come in, a side with one Pokémon standing only needs that one action', () => {
  // Rillaboom is in the paste but no backs were picked, so nobody can replace Flutter.
  const mine = [set('Flutter', 'x', '- Protect', 'EVs: 0 HP'), set('Garchomp', 'Rough Skin', '- Earthquake'), set('Rillaboom', 'Grassy Surge', '- Fake Out')].join('\n\n');
  const { team, plan } = setup(mine, OPP_TEAM, { me: ['Flutter', 'Garchomp'], opp: ['Incineroar', 'Kingambit'] });
  const t1 = newNode({ actions: [
    act('me', 'Flutter', 'move', 'Swords Dance'), act('me', 'Garchomp', 'move', 'Earthquake', 'Both foes'),
    act('opp', 'Kingambit', 'move', 'Close Combat', 'Flutter'), act('opp', 'Incineroar', 'move', 'Protect'),
  ] });
  const t2 = newNode({ actions: [act('me', 'Garchomp', 'move', 'Protect'), act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Protect')] });
  t1.children.push(t2); plan.children.push(t1);
  const results = run(plan, team).results;
  const r1 = ready(results.get(t1.id));
  assert.ok(r1.end.find((e) => e.side === 'me' && e.name === 'Flutter')?.fainted);
  assert.deepEqual(nextActions(r1.state).map((a) => `${a.side}:${a.mon}`), ['me:Garchomp', 'opp:Incineroar', 'opp:Kingambit'], 'no replacement asked from Pokémon that were not brought');
  ready(results.get(t2.id));
  assert.equal(r1.outcome, null, 'a side that picked no backs is not out after losing its leads');
});

test('only the Pokémon picked as leads or backs can act or come in', () => {
  const { team, plan } = setup(WITH_BENCH);
  plan.selection.me.back = ['Aerodactyl', null];
  const n = turn('U-turn', 'Protect', 'Swords Dance', 'Swords Dance', { ril: 'Incineroar' });
  n.actions[0]!.pivot = 'Flutter';
  plan.children.push(n);
  const r = run(plan, team).results.get(n.id);
  assert.ok(r?.status === 'incomplete' && /can.t come in/.test(r.missing.join()), JSON.stringify(r));
  n.actions[0]!.pivot = 'Aerodactyl';
  n.actions.push(act('me', 'Flutter', 'move', 'Protect'));
  const extra = run(plan, team).results.get(n.id);
  assert.ok(extra?.status === 'incomplete' && extra.missing.some((m) => /Flutter wasn.t brought/.test(m)));
});

test('the battle is won or lost once one side has no Pokémon left, and nothing follows it', () => {
  const strong = [set('Kingambit', 'Defiant', '- Close Combat'), set('Garchomp', 'Rough Skin', '- Earthquake')].join('\n\n');
  const weak = set('Flutter', 'x', '- Protect', 'EVs: 0 HP');
  const ko = (mine: string, opp: string, leads: { me: string[]; opp: string[] }, actions: ReturnType<typeof act>[]) => {
    const { team, plan } = setup(mine, opp, leads);
    const n = newNode({ actions });
    const after = newNode();
    n.children.push(after); plan.children.push(n);
    const results = run(plan, team).results;
    return { r: ready(results.get(n.id)), after: results.get(after.id) };
  };
  const win = ko(strong, weak, { me: ['Kingambit', 'Garchomp'], opp: ['Flutter'] },
    [act('me', 'Kingambit', 'move', 'Close Combat', 'Flutter'), act('me', 'Garchomp', 'move', 'Close Combat', 'Flutter'), act('opp', 'Flutter', 'move', 'Swords Dance')]);
  assert.equal(win.r.outcome, 'win');
  assert.deepEqual(win.after, { status: 'blocked', over: true });

  const loss = ko(weak, strong, { me: ['Flutter'], opp: ['Kingambit', 'Garchomp'] },
    [act('me', 'Flutter', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Close Combat', 'Flutter'), act('opp', 'Garchomp', 'move', 'Close Combat', 'Flutter')]);
  assert.equal(loss.r.outcome, 'loss');
});

test('with four Pokémon brought, knocking out only the two leads is not a win yet', () => {
  const { team, plan } = setup(MY_TEAM, [OPP_TEAM, set('Flutter', 'x', '- Protect', 'EVs: 0 HP'), set('Aerodactyl', 'Pressure', '- Rock Slide')].join('\n\n'));
  plan.selection.opp.back = ['Flutter', 'Aerodactyl'];
  const n = turn('Protect', 'Protect', 'Protect', 'Protect');
  plan.children.push(n);
  const r = ready(run(plan, team).results.get(n.id));
  for (const name of ['Incineroar', 'Kingambit']) r.state.mons.opp[name]!.fainted = true;
  assert.equal(outcomeOf(r.state), null);
  assert.equal(r.state.party.opp.length, 4);
  for (const name of ['Flutter', 'Aerodactyl']) r.state.mons.opp[name]!.fainted = true;
  assert.equal(outcomeOf(r.state), 'win');
});

test('self stat drops: Make It Rain (-2 SpA in Champions) and Draco Meteor lower the user, even through Clear Body', () => {
  const { team, plan } = setup(MY_TEAM.replace('Ability: Rough Skin', 'Ability: Clear Body'));
  const n = turn('Protect', 'Make It Rain', 'Swords Dance', 'Swords Dance', { chomp: 'Both foes' });
  const t2 = turn('Protect', 'Draco Meteor', 'Swords Dance', 'Swords Dance', { chomp: 'Incineroar' });
  n.children.push(t2); plan.children.push(n);
  const { results } = run(plan, team);
  const rain = ready(results.get(n.id)).log.find((l) => l.type === 'hit' && l.move === 'Make It Rain');
  assert.deepEqual(rain?.type === 'hit' && rain.self, [{ stat: 'spa', delta: -2 }]);
  assert.deepEqual(ready(results.get(t2.id)).end.find((e) => e.name === 'Garchomp')?.boosts, [{ stat: 'spa', delta: -4 }], 'carried down and stacked');
});

const MEGA_TEAM = [set('Aerodactyl-Mega', 'Tough Claws', '- Rock Slide', 'EVs: 32 Atk\nAdamant Nature', 'Aerodactylite'), set('Garchomp', 'Rough Skin', '- Earthquake', 'EVs: 32 Atk\nAdamant Nature', 'Garchompite')].join('\n\n');

test('a Pokémon pasted as its Mega starts in base form, with the base ability, until it Mega Evolves', () => {
  const { team, plan } = setup(MEGA_TEAM, OPP_TEAM, { me: ['Aerodactyl-Mega', 'Garchomp'], opp: ['Incineroar', 'Kingambit'] });
  const t1 = newNode({ actions: [act('me', 'Aerodactyl-Mega', 'move', 'Flare Blitz', 'Kingambit'), act('me', 'Garchomp', 'move', 'Protect'), act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Swords Dance')] });
  const t2 = newNode({ actions: [act('me', 'Aerodactyl-Mega', 'mega', 'Flare Blitz', 'Kingambit'), act('me', 'Garchomp', 'move', 'Protect'), act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Swords Dance')] });
  t1.children.push(t2); plan.children.push(t1);
  const { results, calls } = run(plan, team);
  const blitz = calls.filter((c) => c.move === 'Flare Blitz');
  assert.deepEqual(blitz.map((c) => `${c.attacker}/${c.attackerAbility}`), ['Aerodactyl/Pressure', 'Aerodactyl-Mega/Tough Claws']);
  const r1 = ready(results.get(t1.id));
  assert.equal(r1.end.find((e) => e.name === 'Aerodactyl-Mega')?.species, 'Aerodactyl', 'shown in base form');
  assert.equal(ready(results.get(t2.id)).state.mons.me['Aerodactyl-Mega']?.ability, 'Tough Claws');
});

test('only a Pokémon holding its Mega Stone can Mega Evolve, and only one per side in a branch', () => {
  const { team, plan } = setup(MEGA_TEAM.replace(' @ Garchompite', ''), OPP_TEAM, { me: ['Aerodactyl-Mega', 'Garchomp'], opp: ['Incineroar', 'Kingambit'] });
  const noStone = newNode({ actions: [act('me', 'Aerodactyl-Mega', 'move', 'Protect'), act('me', 'Garchomp', 'mega', 'Protect'), act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Protect')] });
  plan.children.push(noStone);
  const r = run(plan, team).results.get(noStone.id);
  assert.ok(r?.status === 'incomplete' && /isn.t holding its Mega Stone/.test(r.missing[0] ?? ''));

  const two = setup(MEGA_TEAM, OPP_TEAM, { me: ['Aerodactyl-Mega', 'Garchomp'], opp: ['Incineroar', 'Kingambit'] });
  const t1 = newNode({ actions: [act('me', 'Aerodactyl-Mega', 'mega', 'Protect'), act('me', 'Garchomp', 'move', 'Protect'), act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Protect')] });
  const t2 = newNode({ actions: [act('me', 'Aerodactyl-Mega', 'move', 'Protect'), act('me', 'Garchomp', 'mega', 'Protect'), act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Protect')] });
  t1.children.push(t2); two.plan.children.push(t1);
  const res = run(two.plan, two.team).results;
  const r1 = ready(res.get(t1.id));
  assert.equal(canMegaEvolve(r1.state, 'me', 'Garchomp'), false, 'the side already used its Mega');
  const r2 = res.get(t2.id);
  assert.ok(r2?.status === 'incomplete' && /Aerodactyl-Mega already did/.test(r2.missing[0] ?? ''), JSON.stringify(r2));
});

test('turn actions follow the field: one per Pokémon on it, a blank per refillable slot, nothing for the bench', () => {
  const { team, plan } = setup(WITH_BENCH);
  plan.selection.me.back = ['Aerodactyl', 'Flutter'];
  const n = turn('Protect', 'Protect', 'Protect', 'Protect');
  plan.children.push(n);
  const st = structuredClone(ready(run(plan, team).results.get(n.id)).state);
  st.mons.me.Rillaboom!.fainted = true;
  const garchomp = act('me', 'Garchomp', 'move', 'Earthquake', 'Both foes');
  const synced = syncTurnActions(st, [garchomp, act('me', 'Flutter', 'move', 'Protect'), act('me', 'Aerodactyl', 'move', 'Protect')]);
  const mine = synced.filter((a) => a.side === 'me');
  assert.equal(mine[0], garchomp, 'what was entered is kept');
  assert.deepEqual(mine.map((a) => a.mon), ['Garchomp', 'Flutter'], 'one replacement slot, filled by the first benched pick');
  assert.deepEqual(synced.filter((a) => a.side === 'opp').map((a) => a.mon), ['Incineroar', 'Kingambit'], 'missing actions are added');
  assert.deepEqual(fieldAfterReplacements(st, synced).me, ['Flutter', 'Garchomp'], 'Flutter takes Rillaboom\u2019s place and can be targeted');
});
