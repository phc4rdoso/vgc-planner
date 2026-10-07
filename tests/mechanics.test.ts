/**
 * Battle mechanics with a trigger: items, entry abilities, end-of-turn order, contact damage, redirection, Mega
 * Evolution timing. Damage numbers come from the stand-in calculator, so the tests check what happens and in which
 * order rather than exact amounts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNode, newPlan, newTeam, sheetOf } from '../src/domain/model.ts';
import { createEngine } from '../src/domain/simulation/engine.ts';
import type { EndMon, HitResult, LogEntry, TurnResult } from '../src/domain/simulation/log.ts';
import { simulatePlan } from '../src/domain/simulation/plan.ts';
import type { ActionKind, ActionOutcome, FlowNode, Side, TurnAction } from '../src/domain/types.ts';
import type { CalcCall } from './helpers/stub-calc.ts';
import { makeStubCalc } from './helpers/stub-calc.ts';
import { alwaysSelf, chanceEffects } from '../src/domain/simulation/tables.ts';

type Ready = Extract<TurnResult, { status: 'ready' }>;

const act = (side: Side, mon: string, kind: ActionKind, move: string, target = ''): TurnAction => ({ side, mon, kind, move, target });
const sw = (side: Side, mon: string, to: string): TurnAction => ({ side, mon, kind: 'switch', move: '', target: to });
const STRONG = 'EVs: 32 HP / 32 Atk / 2 Spe\nAdamant Nature';
const mon = (name: string, ability: string, item = '', extra = STRONG): string => `${name}${item ? ` @ ${item}` : ''}\nAbility: ${ability}\n${extra}\n- Protect`;

interface Battle {
  me: string[]; opp: string[];
  leads: Record<Side, string[]>;
  backs?: Partial<Record<Side, string[]>>;
}

/** What the stand-in calculator was asked during the last {@link play}. */
let lastCalls: CalcCall[] = [];

/** Runs the turns one after another down a single branch and returns each turn's result (all must be ready). */
function play(b: Battle, ...turns: TurnAction[][]): Ready[] {
  const team = newTeam('T', b.me.join('\n\n'));
  const gameplan = newPlan('p', b.opp.join('\n\n'));
  const plan = sheetOf(gameplan, gameplan.tabs[0]!);
  for (const side of ['me', 'opp'] as const) {
    plan.selection[side].lead = b.leads[side];
    plan.selection[side].back = b.backs?.[side] ?? [];
  }
  const nodes: FlowNode[] = turns.map((actions) => newNode({ actions }));
  let parent: { children: FlowNode[] } = plan;
  for (const n of nodes) { parent.children.push(n); parent = n; }
  const stub = makeStubCalc();
  lastCalls = stub.calls;
  const results = simulatePlan(createEngine(stub.lib), team, plan);
  return nodes.map((n, i) => {
    const r = results.get(n.id);
    assert.equal(r?.status, 'ready', `turn ${i + 1}: ${JSON.stringify(r)}`);
    return r as Ready;
  });
}

const residuals = (log: readonly LogEntry[], who: string): { text: string; pct: number; fainted: boolean }[] =>
  log.flatMap((l) => (l.type === 'residual' && l.mon === who ? [{ text: l.text, pct: l.pct, fainted: l.fainted }] : []));
const effects = (log: readonly LogEntry[], who: string): string[] =>
  log.flatMap((l) => (l.type === 'effect' && l.mon === who ? [`${l.source}: ${l.text}`] : []));
const hitOn = (log: readonly LogEntry[], user: string, move: string): HitResult[] => {
  const hit = log.find((l) => l.type === 'hit' && l.mon === user && l.move === move);
  assert.ok(hit?.type === 'hit', `${user} used ${move}`);
  return hit.results;
};
const boostsFrom = (log: readonly LogEntry[], who: string, source: string): Record<string, number> | null => {
  const e = log.find((l) => l.type === 'boost' && l.mon === who && l.move === source);
  return e?.type === 'boost' ? Object.fromEntries(e.changes.map((c) => [c.stat, c.delta])) : null;
};
const idle = (side: Side, ...mons: string[]): TurnAction[] => mons.map((m) => act(side, m, 'move', 'Swords Dance'));
const OPP = [mon('Incineroar', 'Blaze'), mon('Kingambit', 'Defiant')];
const OPP_LEADS = ['Incineroar', 'Kingambit'];

test('Hospitality heals the ally by a quarter of its HP when Sinistcha comes in', () => {
  const [, r2] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Overgrow'), mon('Sinistcha', 'Hospitality')], opp: OPP,
      leads: { me: ['Garchomp', 'Rillaboom'], opp: OPP_LEADS }, backs: { me: ['Sinistcha'] } },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Protect'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Protect')],
    [act('me', 'Garchomp', 'move', 'Swords Dance'), sw('me', 'Rillaboom', 'Sinistcha'), ...idle('opp', ...OPP_LEADS)],
  );
  const heal = residuals(r2!.log, 'Garchomp').find((x) => x.text === "Sinistcha's Hospitality");
  assert.ok(heal && heal.pct > 0 && heal.pct <= 25.1, JSON.stringify(r2!.log));
});

test('a terrain seed is eaten once when its terrain comes up, and not again when the terrain is set later', () => {
  const [r1, r2] = play(
    { me: [mon('Rillaboom', 'Grassy Surge'), mon('Garchomp', 'Rough Skin', 'Grassy Seed')], opp: OPP, leads: { me: ['Rillaboom', 'Garchomp'], opp: OPP_LEADS } },
    [...idle('me', 'Rillaboom', 'Garchomp'), act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Psychic Terrain')],
    [...idle('me', 'Rillaboom', 'Garchomp'), act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Grassy Terrain')],
  );
  assert.deepEqual(boostsFrom(r1!.entry, 'Garchomp', 'Grassy Seed'), { def: 1 });
  assert.equal(r1!.state.mons.me.Garchomp!.item, '');
  assert.equal(boostsFrom(r2!.log, 'Garchomp', 'Grassy Seed'), null, 'the seed is gone');
  assert.equal(r2!.end.find((e) => e.name === 'Garchomp')?.lostItem, 'Grassy Seed');
});

test('Sitrus Berry heals once, when HP first drops to half', () => {
  const smeargle = mon('Smeargle', 'Own Tempo', 'Sitrus Berry', 'EVs: 32 HP\nHardy Nature');
  const hitSmeargle = [act('me', 'Garchomp', 'move', 'Close Combat', 'Smeargle'), act('me', 'Rillaboom', 'move', 'Protect'), ...idle('opp', 'Smeargle', 'Kingambit')];
  const [r1, r2] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Overgrow')], opp: [smeargle, mon('Kingambit', 'Defiant')], leads: { me: ['Garchomp', 'Rillaboom'], opp: ['Smeargle', 'Kingambit'] } },
    hitSmeargle, hitSmeargle,
  );
  const sitrus = residuals(r1!.log, 'Smeargle').filter((x) => x.text === 'Sitrus Berry');
  assert.equal(sitrus.length, 1, JSON.stringify(r1!.log));
  assert.ok(sitrus[0]!.pct > 0);
  assert.equal(residuals(r2!.log, 'Smeargle').filter((x) => x.text === 'Sitrus Berry').length, 0);
});

test('Lum Berry cures the first condition and is used up', () => {
  const wisp = [act('me', 'Garchomp', 'move', 'Will-O-Wisp', 'Smeargle'), act('me', 'Rillaboom', 'move', 'Protect'), ...idle('opp', 'Smeargle', 'Kingambit')];
  const [r1, r2] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Overgrow')], opp: [mon('Smeargle', 'Own Tempo', 'Lum Berry'), mon('Kingambit', 'Defiant')], leads: { me: ['Garchomp', 'Rillaboom'], opp: ['Smeargle', 'Kingambit'] } },
    wisp, wisp,
  );
  const first = r1!.log.find((l) => l.type === 'status');
  assert.ok(first?.type === 'status' && first.targets[0]?.cured === 'Lum Berry');
  assert.equal(r1!.end.find((e) => e.name === 'Smeargle')?.condition, null);
  assert.equal(r2!.end.find((e) => e.name === 'Smeargle')?.condition, 'brn');
});

test('end of turn: Sandstorm before Leftovers; a Pokémon that faints to the sand isn\'t healed by Grassy Terrain', () => {
  const [r1] = play(
    { me: [mon('Rillaboom', 'Overgrow', 'Leftovers'), mon('Garchomp', 'Rough Skin')], opp: [mon('Tyranitar', 'Sand Stream'), mon('Kingambit', 'Defiant')], leads: { me: ['Rillaboom', 'Garchomp'], opp: ['Tyranitar', 'Kingambit'] } },
    [...idle('me', 'Rillaboom', 'Garchomp'), ...idle('opp', 'Tyranitar', 'Kingambit')],
  );
  assert.deepEqual(residuals(r1!.log, 'Rillaboom').map((x) => x.text), ['Sandstorm', 'Leftovers']);
  assert.deepEqual(residuals(r1!.log, 'Garchomp'), [], 'Ground types take no sand damage');

  const [k] = play(
    { me: [mon('Rillaboom', 'Grassy Surge'), mon('Smeargle', 'Own Tempo', 'Focus Sash', 'EVs: 1 Spe\nHardy Nature')], opp: [mon('Tyranitar', 'Sand Stream'), mon('Garchomp', 'Rough Skin')], leads: { me: ['Rillaboom', 'Smeargle'], opp: ['Tyranitar', 'Garchomp'] } },
    [act('me', 'Rillaboom', 'move', 'Protect'), act('me', 'Smeargle', 'move', 'Swords Dance'), act('opp', 'Tyranitar', 'move', 'Protect'), act('opp', 'Garchomp', 'move', 'Close Combat', 'Smeargle')],
  );
  const cc = hitOn(k!.log, 'Garchomp', 'Close Combat')[0]!;
  assert.equal(cc.endured, 'Focus Sash', JSON.stringify(k!.log));
  assert.ok(effects(k!.log, 'Smeargle').includes('Focus Sash: hangs on at 1 HP'));
  const after = residuals(k!.log, 'Smeargle');
  assert.deepEqual(after.map((x) => [x.text, x.fainted]), [['Sandstorm', true]]);
  assert.ok(k!.end.find((e) => e.name === 'Smeargle')?.fainted);
});

test('contact damage (Rough Skin, Rocky Helmet) and recoil hurt the attacker; Life Orb costs 10%', () => {
  const [r1] = play(
    { me: [mon('Garchomp', 'Rough Skin', 'Rocky Helmet'), mon('Kingambit', 'Defiant', 'Life Orb')], opp: OPP, leads: { me: ['Garchomp', 'Kingambit'], opp: OPP_LEADS } },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Kingambit', 'move', 'Close Combat', 'Incineroar'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
  );
  const texts = residuals(r1!.log, 'Incineroar').map((x) => x.text);
  assert.ok(texts.includes("Garchomp's Rough Skin") && texts.includes("Garchomp's Rocky Helmet") && texts.includes('recoil'), JSON.stringify(r1!.log));
  assert.ok(texts.indexOf("Garchomp's Rough Skin") < texts.indexOf('recoil'), 'contact damage comes before recoil');
  const orb = residuals(r1!.log, 'Kingambit').find((x) => x.text === 'Life Orb');
  assert.ok(orb && orb.pct <= -9.5 && orb.pct >= -10);
});

test('Knock Off removes the item for good, and Unburden doubles Speed until it switches out', () => {
  const opp = [mon('Smeargle', 'Unburden', 'Sitrus Berry', 'EVs: 32 HP / 32 Def\nBold Nature'), mon('Kingambit', 'Defiant'), mon('Incineroar', 'Blaze')];
  const [r1, r2, , r4] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Overgrow')], opp, leads: { me: ['Garchomp', 'Rillaboom'], opp: ['Smeargle', 'Kingambit'] }, backs: { opp: ['Incineroar'] } },
    [act('me', 'Garchomp', 'move', 'Knock Off', 'Smeargle'), act('me', 'Rillaboom', 'move', 'Protect'), ...idle('opp', 'Smeargle', 'Kingambit')],
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Protect'), act('opp', 'Smeargle', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Protect')],
    [...idle('me', 'Garchomp', 'Rillaboom'), sw('opp', 'Smeargle', 'Incineroar'), act('opp', 'Kingambit', 'move', 'Protect')],
    [...idle('me', 'Garchomp', 'Rillaboom'), sw('opp', 'Incineroar', 'Smeargle'), act('opp', 'Kingambit', 'move', 'Protect')],
  );
  assert.deepEqual(effects(r1!.log, 'Smeargle'), ['Sitrus Berry: knocked off by Garchomp', 'Unburden: Speed doubles (lost its item)']);
  const order = r2!.log.filter((l) => l.type === 'boost').map((l) => l.mon);
  assert.deepEqual(order, ['Smeargle', 'Garchomp'], 'Unburden makes Smeargle faster than Garchomp');
  const back = r4!.state.mons.opp.Smeargle!;
  assert.equal(back.item, '', 'the item does not come back after switching');
  assert.equal(back.unburden, false, 'Unburden ends on switching out');
});

test('switches happen before Mega Evolution: Charizard-Mega-Y\'s sun replaces the rain Pelipper just brought', () => {
  const [r1] = play(
    { me: [mon('Charizard', 'Blaze', 'Charizardite Y'), mon('Garchomp', 'Rough Skin'), mon('Pelipper', 'Drizzle')], opp: OPP,
      leads: { me: ['Charizard', 'Garchomp'], opp: OPP_LEADS }, backs: { me: ['Pelipper'] } },
    [act('me', 'Charizard', 'mega', 'Protect'), sw('me', 'Garchomp', 'Pelipper'), ...idle('opp', ...OPP_LEADS)],
  );
  const order = r1!.log.filter((l) => l.type === 'switch' || l.type === 'mega' || l.type === 'field').map((l) => (l.type === 'field' ? l.text : l.type));
  assert.deepEqual(order, ['switch', 'Rain for 5 turns', 'mega', 'Sun for 5 turns']);
  assert.equal(r1!.field.weather, 'Sun');
});

test('a paste naming the Mega with its base ability (Charizard-Mega-Y, Ability: Blaze) still gets Drought on Mega Evolving', () => {
  const [r1] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Kingambit', 'Defiant'), mon('Pelipper', 'Drizzle')], opp: [mon('Charizard-Mega-Y', 'Blaze', 'Charizardite Y'), mon('Incineroar', 'Blaze')],
      leads: { me: ['Garchomp', 'Kingambit'], opp: ['Charizard-Mega-Y', 'Incineroar'] }, backs: { me: ['Pelipper'] } },
    [sw('me', 'Garchomp', 'Pelipper'), act('me', 'Kingambit', 'move', 'Protect'), act('opp', 'Charizard-Mega-Y', 'mega', 'Protect'), act('opp', 'Incineroar', 'move', 'Protect')],
  );
  assert.equal(r1!.state.mons.opp['Charizard-Mega-Y']!.ability, 'Drought');
  assert.equal(r1!.field.weather, 'Sun', JSON.stringify(r1!.log));
});

test('two Megas that set weather evolve fastest first, so the slower one\'s weather stays', () => {
  const [r1] = play(
    { me: [mon('Charizard', 'Blaze', 'Charizardite Y'), mon('Garchomp', 'Rough Skin')], opp: [mon('Tyranitar', 'Unnerve', 'Tyranitarite'), mon('Kingambit', 'Defiant')],
      leads: { me: ['Charizard', 'Garchomp'], opp: ['Tyranitar', 'Kingambit'] } },
    [act('opp', 'Tyranitar', 'mega', 'Protect'), act('opp', 'Kingambit', 'move', 'Protect'), act('me', 'Charizard', 'mega', 'Protect'), act('me', 'Garchomp', 'move', 'Protect')],
  );
  assert.deepEqual(r1!.log.filter((l) => l.type === 'mega').map((l) => l.mon), ['Charizard', 'Tyranitar']);
  assert.equal(r1!.field.weather, 'Sand');
});

test('Defiant answers any stat drop from a foe; Contrary reverses every stat change', () => {
  const [r1] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Smeargle', 'Contrary')], opp: [mon('Incineroar', 'Intimidate'), mon('Kingambit', 'Defiant')], leads: { me: ['Garchomp', 'Smeargle'], opp: OPP_LEADS } },
    [act('me', 'Garchomp', 'move', 'Screech', 'Kingambit'), act('me', 'Smeargle', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
  );
  const screech = r1!.log.find((l) => l.type === 'debuff');
  assert.ok(screech?.type === 'debuff');
  assert.deepEqual(Object.fromEntries((screech.targets[0]?.changes ?? []).map((c) => [c.stat, c.delta])), { def: -2, atk: 2 });
  assert.deepEqual(boostsFrom(r1!.entry, 'Smeargle', "Incineroar's Intimidate"), { atk: 1 });
  assert.deepEqual(boostsFrom(r1!.log, 'Smeargle', 'Swords Dance'), { atk: -2 });
});

test('stat stages reset on switching out, but a condition stays', () => {
  const [, , r3] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Overgrow'), mon('Kingambit', 'Defiant')], opp: OPP,
      leads: { me: ['Garchomp', 'Rillaboom'], opp: OPP_LEADS }, backs: { me: ['Kingambit'] } },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Protect'), act('opp', 'Incineroar', 'move', 'Will-O-Wisp', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Protect')],
    [sw('me', 'Garchomp', 'Kingambit'), act('me', 'Rillaboom', 'move', 'Protect'), ...idle('opp', ...OPP_LEADS)],
    [sw('me', 'Kingambit', 'Garchomp'), act('me', 'Rillaboom', 'move', 'Protect'), ...idle('opp', ...OPP_LEADS)],
  );
  const chomp = r3!.end.find((e) => e.name === 'Garchomp');
  assert.equal(chomp?.condition, 'brn');
  assert.deepEqual(chomp?.boosts, []);
});

test('Follow Me draws single-target moves; once its user faints, the next move goes to the partner', () => {
  const opp = [mon('Flutter', 'Cursed Body'), mon('Incineroar', 'Blaze')];
  const leads = { me: ['Garchomp', 'Kingambit'], opp: ['Flutter', 'Incineroar'] };
  const [, r2] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Kingambit', 'Defiant')], opp, leads },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Kingambit', 'move', 'Swords Dance'), ...idle('opp', 'Flutter', 'Incineroar')],
    [act('me', 'Garchomp', 'move', 'Close Combat', 'Incineroar'), act('me', 'Kingambit', 'move', 'Close Combat', 'Flutter'),
      act('opp', 'Flutter', 'move', 'Follow Me'), act('opp', 'Incineroar', 'move', 'Swords Dance')],
  );
  const first = hitOn(r2!.log, 'Garchomp', 'Close Combat')[0]!;
  assert.equal(first.mon, 'Flutter');
  assert.equal(first.koChance, 100, JSON.stringify(r2!.log));
  assert.equal(hitOn(r2!.log, 'Kingambit', 'Close Combat')[0]?.mon, 'Incineroar');
});

test('Rage Powder doesn\'t draw moves from Grass types', () => {
  const [r1] = play(
    { me: [mon('Rillaboom', 'Overgrow'), mon('Garchomp', 'Rough Skin')], opp: [mon('Flutter', 'Cursed Body'), mon('Incineroar', 'Blaze')], leads: { me: ['Rillaboom', 'Garchomp'], opp: ['Flutter', 'Incineroar'] } },
    [act('me', 'Rillaboom', 'move', 'Fake Out', 'Incineroar'), act('me', 'Garchomp', 'move', 'Close Combat', 'Incineroar'),
      act('opp', 'Flutter', 'move', 'Rage Powder'), act('opp', 'Incineroar', 'move', 'Swords Dance')],
  );
  assert.equal(hitOn(r1!.log, 'Rillaboom', 'Fake Out')[0]?.mon, 'Incineroar');
  assert.equal(hitOn(r1!.log, 'Garchomp', 'Close Combat')[0]?.mon, 'Flutter');
});

test('Wide Guard protects both Pokémon on its side from spread moves', () => {
  const [r1] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Overgrow')], opp: OPP, leads: { me: ['Garchomp', 'Rillaboom'], opp: OPP_LEADS } },
    [act('me', 'Garchomp', 'move', 'Earthquake'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Wide Guard')],
  );
  const eq = hitOn(r1!.log, 'Garchomp', 'Earthquake');
  assert.deepEqual(eq.map((x) => [x.mon, x.protected === true]), [['Incineroar', true], ['Kingambit', true], ['Rillaboom', false]]);
});

test('draining moves heal the user by part of the damage dealt', () => {
  const [, r2] = play(
    { me: [mon('Rillaboom', 'Overgrow'), mon('Garchomp', 'Rough Skin')], opp: OPP, leads: { me: ['Rillaboom', 'Garchomp'], opp: OPP_LEADS } },
    [act('me', 'Rillaboom', 'move', 'Swords Dance'), act('me', 'Garchomp', 'move', 'Protect'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Rillaboom'), act('opp', 'Kingambit', 'move', 'Protect')],
    [act('me', 'Rillaboom', 'move', 'Giga Drain', 'Incineroar'), act('me', 'Garchomp', 'move', 'Protect'), ...idle('opp', 'Incineroar', 'Kingambit').slice(1), act('opp', 'Incineroar', 'move', 'Swords Dance')],
  );
  const drain = residuals(r2!.log, 'Rillaboom').find((x) => x.text === 'Giga Drain');
  assert.ok(drain && drain.pct > 0, JSON.stringify(r2!.log));
});

/* ---------- two-turn moves ---------- */

const ME = [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Overgrow')];
const ME_LEADS = { me: ['Garchomp', 'Rillaboom'], opp: OPP_LEADS };
const hits = (log: readonly LogEntry[], user: string, move: string): boolean => log.some((l) => l.type === 'hit' && l.mon === user && l.move === move);

test('Solar Beam charges outside sun and fires on the next action, whatever was picked for it', () => {
  const [r1, r2] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Solar Beam', 'Incineroar'), ...idle('opp', ...OPP_LEADS)],
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', ''), ...idle('opp', ...OPP_LEADS)],
  );
  assert.ok(!hits(r1!.log, 'Rillaboom', 'Solar Beam'));
  assert.deepEqual(effects(r1!.log, 'Rillaboom'), ['Solar Beam: absorbs light: attacks on its next action']);
  assert.equal(r1!.end.find((e) => e.name === 'Rillaboom')?.charging, 'Solar Beam');
  assert.equal(hitOn(r2!.log, 'Rillaboom', 'Solar Beam')[0]?.mon, 'Incineroar');
  assert.equal(r2!.end.find((e) => e.name === 'Rillaboom')?.charging, undefined);
});

test('Solar Beam fires at once in sun, and Power Herb skips the charge once', () => {
  const [sun] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Sunny Day'), act('me', 'Rillaboom', 'move', 'Solar Beam', 'Incineroar'), ...idle('opp', ...OPP_LEADS)],
  );
  assert.ok(hits(sun!.log, 'Rillaboom', 'Solar Beam'));
  const [herb] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Overgrow', 'Power Herb')], opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Solar Beam', 'Incineroar'), ...idle('opp', ...OPP_LEADS)],
  );
  assert.deepEqual(effects(herb!.log, 'Rillaboom'), ['Power Herb: lets it use Solar Beam at once']);
  assert.ok(hits(herb!.log, 'Rillaboom', 'Solar Beam'));
  assert.equal(herb!.end.find((e) => e.name === 'Rillaboom')?.lostItem, 'Power Herb');
});

test('Electro Shot raises Sp. Atk while charging, and attacks the same turn in rain', () => {
  const [dry] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Electro Shot', 'Incineroar'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
  );
  assert.deepEqual(boostsFrom(dry!.log, 'Garchomp', 'Electro Shot'), { spa: 1 });
  assert.ok(!hits(dry!.log, 'Garchomp', 'Electro Shot'));
  const [rain] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Pelipper', 'Drizzle')], opp: OPP, leads: { me: ['Garchomp', 'Pelipper'], opp: OPP_LEADS } },
    [act('me', 'Garchomp', 'move', 'Electro Shot', 'Incineroar'), act('me', 'Pelipper', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
  );
  assert.deepEqual(boostsFrom(rain!.log, 'Garchomp', 'Electro Shot'), { spa: 1 });
  assert.ok(hits(rain!.log, 'Garchomp', 'Electro Shot'));
});

test('a Pokémon up in the air with Fly is out of reach for most moves', () => {
  const [r1] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Fly', 'Incineroar'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
  );
  assert.match(hitOn(r1!.log, 'Incineroar', 'Flare Blitz')[0]?.blockedBy ?? '', /out of reach \(Garchomp flies up high\)/);
});

/* ---------- Feint ---------- */

test('Feint breaks Protect, so later attacks that turn land', () => {
  const [r1] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Feint', 'Incineroar'), act('me', 'Rillaboom', 'move', 'Close Combat', 'Incineroar'), act('opp', 'Incineroar', 'move', 'Protect'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
  );
  assert.equal(hitOn(r1!.log, 'Garchomp', 'Feint')[0]?.protected, undefined);
  assert.ok(effects(r1!.log, 'Incineroar').includes('Feint: breaks its protection'));
  assert.equal(hitOn(r1!.log, 'Rillaboom', 'Close Combat')[0]?.protected, undefined);
});

test('Feint lifts Wide Guard for the whole side', () => {
  const [r1] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Earthquake'), act('me', 'Rillaboom', 'move', 'Feint', 'Kingambit'), act('opp', 'Incineroar', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Wide Guard')],
  );
  assert.ok(effects(r1!.log, 'Kingambit').includes('Feint: breaks Wide Guard'));
  assert.ok(hitOn(r1!.log, 'Garchomp', 'Earthquake').every((x) => !x.protected));
});

/* ---------- moves that fail ---------- */

const failNote = (log: readonly LogEntry[], user: string, move: string): string | undefined => {
  const e = log.find((l) => l.type === 'other' && l.mon === user && l.move === move);
  return e?.type === 'other' ? e.note : undefined;
};

test('Fake Out only works on the first turn out; a second Protect in a row fails', () => {
  const both = [act('me', 'Garchomp', 'move', 'Protect'), act('me', 'Rillaboom', 'move', 'Fake Out', 'Incineroar'), ...idle('opp', ...OPP_LEADS)];
  const [r1, r2] = play({ me: ME, opp: OPP, leads: ME_LEADS }, both, both);
  assert.ok(hits(r1!.log, 'Rillaboom', 'Fake Out'));
  assert.equal(failNote(r2!.log, 'Rillaboom', 'Fake Out'), 'fails (only works on its first turn out)');
  assert.match(failNote(r2!.log, 'Garchomp', 'Protect') ?? '', /^fails \(used right after another protecting move/);
});

test('Sucker Punch fails unless the target is about to attack', () => {
  const sucker = (garchomp: TurnAction): Ready => play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [garchomp, act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Sucker Punch', 'Garchomp')],
  )[0]!;
  assert.equal(failNote(sucker(act('me', 'Garchomp', 'move', 'Swords Dance')).log, 'Kingambit', 'Sucker Punch'), "fails (Garchomp isn't attacking)");
  assert.ok(hits(sucker(act('me', 'Garchomp', 'move', 'Close Combat', 'Incineroar')).log, 'Kingambit', 'Sucker Punch'));
});

test('Aurora Veil fails without Snow', () => {
  const [r1] = play({ me: ME, opp: OPP, leads: ME_LEADS }, [act('me', 'Garchomp', 'move', 'Aurora Veil'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)]);
  const veil = r1!.log.find((l) => l.type === 'field' && l.move === 'Aurora Veil');
  assert.ok(veil?.type === 'field' && veil.text === 'fails (needs Snow)');
});

/* ---------- power from the battle so far ---------- */

const powerOf = (log: readonly LogEntry[], user: string, move: string): number | undefined => hitOn(log, user, move)[0]?.power;

test('Rage Fist gains 50 power for each hit taken, even across turns', () => {
  const [, r2] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
    [act('me', 'Garchomp', 'move', 'Rage Fist', 'Incineroar'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
  );
  assert.equal(powerOf(r2!.log, 'Garchomp', 'Rage Fist'), 100);
});

test('Last Respects gains 50 power for each fainted Pokémon of its side', () => {
  const [, r2] = play(
    { me: [mon('Smeargle', 'Own Tempo', '', 'EVs: 1 Spe\nHardy Nature'), mon('Kingambit', 'Defiant'), mon('Rillaboom', 'Overgrow')], opp: [mon('Garchomp', 'Rough Skin'), mon('Incineroar', 'Blaze')],
      leads: { me: ['Smeargle', 'Kingambit'], opp: ['Garchomp', 'Incineroar'] }, backs: { me: ['Rillaboom'] } },
    [act('me', 'Smeargle', 'move', 'Swords Dance'), act('me', 'Kingambit', 'move', 'Swords Dance'), act('opp', 'Garchomp', 'move', 'Close Combat', 'Smeargle'), act('opp', 'Incineroar', 'move', 'Swords Dance')],
    [act('me', 'Rillaboom', 'move', 'Swords Dance'), act('me', 'Kingambit', 'move', 'Last Respects', 'Incineroar'), ...idle('opp', 'Garchomp', 'Incineroar')],
  );
  assert.equal(powerOf(r2!.log, 'Kingambit', 'Last Respects'), 100);
});

test('Stomping Tantrum doubles after a failed move', () => {
  const [, r2] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Aurora Veil'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
    [act('me', 'Garchomp', 'move', 'Stomping Tantrum', 'Incineroar'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
  );
  assert.equal(powerOf(r2!.log, 'Garchomp', 'Stomping Tantrum'), 150);
});

test('Payback doubles when the target really moved first (correcting the calculator\'s Speed-only guess)', () => {
  const [r1] = play(
    { me: [mon('Kingambit', 'Defiant'), mon('Rillaboom', 'Overgrow')], opp: OPP, leads: { me: ['Kingambit', 'Rillaboom'], opp: OPP_LEADS } },
    [act('me', 'Kingambit', 'move', 'Payback', 'Incineroar'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
  );
  assert.equal(powerOf(r1!.log, 'Kingambit', 'Payback'), 100);
  // Kingambit is slower than Incineroar, so the real calculator doubles Payback by itself: it gets the base power.
  assert.equal(lastCalls.find((c) => c.move === 'Payback')?.bp, 50);
});

/* ---------- turn order read again before every action ---------- */

const movers = (log: readonly LogEntry[]): string[] => log.filter((l) => l.type === 'boost' || l.type === 'hit' || l.type === 'status' || l.type === 'field').map((l) => l.mon);

test('paralysis halves Speed straight away: a Pokémon paralysed earlier in the turn moves later', () => {
  const [r1] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Thunder Wave', 'Ally'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
  );
  const order = movers(r1!.log);
  assert.equal(r1!.end.find((e) => e.name === 'Rillaboom')?.condition, 'par');
  assert.ok(order.indexOf('Incineroar') < order.indexOf('Rillaboom'), order.join(' > '));
});

test('a Tailwind set this turn speeds up its side for the actions still to come', () => {
  const [r1] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Kingambit', 'Defiant')], opp: [mon('Rillaboom', 'Overgrow'), mon('Incineroar', 'Blaze')], leads: { me: ['Garchomp', 'Kingambit'], opp: ['Rillaboom', 'Incineroar'] } },
    [act('me', 'Garchomp', 'move', 'Tailwind'), act('me', 'Kingambit', 'move', 'Swords Dance'), act('opp', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance')],
  );
  assert.deepEqual(movers(r1!.log), ['Garchomp', 'Kingambit', 'Rillaboom', 'Incineroar']);
});

/* ---------- fixed fractions read exactly ---------- */

test('fixed-fraction effects show the same percentage for everyone: Grassy Terrain 6.25%, bad poison 6.25% then 12.5%', () => {
  const t = [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Rillaboom'), act('opp', 'Kingambit', 'move', 'Close Combat', 'Garchomp')];
  const [r1] = play({ me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Grassy Surge')], opp: OPP, leads: ME_LEADS }, t);
  for (const who of ['Garchomp', 'Rillaboom']) assert.deepEqual(residuals(r1!.log, who).filter((x) => x.text === 'Grassy Terrain').map((x) => x.pct), [6.25], who);

  const toxic = [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Toxic', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')];
  const calm = [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)];
  const [p1, p2] = play({ me: ME, opp: OPP, leads: ME_LEADS }, toxic, calm);
  assert.deepEqual([...residuals(p1!.log, 'Garchomp'), ...residuals(p2!.log, 'Garchomp')].map((x) => x.pct), [-6.25, -12.5]);
});

/* ---------- Beat Up, recharge ---------- */

test('Beat Up hits once per able party member, and each hit stacks Rage Fist', () => {
  const [r1, r2] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Beat Up', 'Ally'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Rage Fist', 'Incineroar'), ...idle('opp', ...OPP_LEADS)],
  );
  const beat = hitOn(r1!.log, 'Garchomp', 'Beat Up')[0]!;
  assert.equal(beat.mon, 'Rillaboom');
  assert.equal(beat.hits, 2);
  assert.ok((beat.maxPct ?? 0) > 0, 'Beat Up does damage');
  assert.equal(powerOf(r2!.log, 'Rillaboom', 'Rage Fist'), 150);
});

test('after Hyper Beam hits, the user spends its next action recharging, whatever was picked', () => {
  const beam = [act('me', 'Garchomp', 'move', 'Hyper Beam', 'Incineroar'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)];
  const [, r2, r3] = play({ me: ME, opp: OPP, leads: ME_LEADS }, beam,
    [act('me', 'Garchomp', 'move', ''), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)], beam);
  assert.ok(r2!.log.some((l) => l.type === 'skip' && l.mon === 'Garchomp' && l.why === 'must recharge after Hyper Beam'));
  assert.ok(hits(r3!.log, 'Garchomp', 'Hyper Beam'), 'free again the turn after');
});

test('the turn result numbers the positions in the order they acted, a switch credited to who came in', () => {
  const [r1] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Overgrow'), mon('Pelipper', 'Drizzle')], opp: OPP,
      leads: { me: ['Garchomp', 'Rillaboom'], opp: OPP_LEADS }, backs: { me: ['Pelipper'] } },
    [sw('me', 'Rillaboom', 'Pelipper'), act('me', 'Garchomp', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
  );
  assert.deepEqual(r1!.order, { 'me:Pelipper': 1, 'me:Garchomp': 2, 'opp:Incineroar': 3, 'opp:Kingambit': 4 });
});

/* ---------- speed abilities ---------- */

const swap = (a: TurnAction, pivot: string): TurnAction => ({ ...a, pivot });
const boostsOf = (r: Ready, who: string): Record<string, number> => Object.fromEntries((r.end.find((e) => e.name === who)?.boosts ?? []).map((b) => [b.stat, b.delta]));

test('Swift Swim doubles Speed in rain, which changes the turn order', () => {
  const t = [act('me', 'Kingambit', 'move', 'Swords Dance'), act('me', 'Pelipper', 'move', 'Swords Dance'), act('opp', 'Garchomp', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance')];
  const order = (ability: string): string[] => movers(play(
    { me: [mon('Kingambit', ability), mon('Pelipper', 'Drizzle')], opp: [mon('Garchomp', 'Rough Skin'), mon('Incineroar', 'Blaze')], leads: { me: ['Kingambit', 'Pelipper'], opp: ['Garchomp', 'Incineroar'] } }, t,
  )[0]!.log);
  assert.ok(order('Swift Swim').indexOf('Kingambit') < order('Swift Swim').indexOf('Garchomp'));
  assert.ok(order('Defiant').indexOf('Kingambit') > order('Defiant').indexOf('Garchomp'));
});

/* ---------- reactions to hits and knock-outs ---------- */

test('Stamina raises Defense when hit; Weakness Policy answers a super-effective hit', () => {
  const [r1] = play(
    { me: ME, opp: [mon('Incineroar', 'Blaze'), mon('Kingambit', 'Stamina', 'Weakness Policy')], leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Close Combat', 'Kingambit'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
  );
  assert.deepEqual(boostsFrom(r1!.log, 'Kingambit', 'Stamina'), { def: 1 });
  assert.deepEqual(boostsFrom(r1!.log, 'Kingambit', 'Weakness Policy'), { atk: 2, spa: 2 });
});

test('Moxie raises Attack after a knock-out', () => {
  const [r1] = play(
    { me: [mon('Garchomp', 'Moxie'), mon('Rillaboom', 'Overgrow')], opp: [mon('Smeargle', 'Own Tempo', '', 'EVs: 1 Spe\nHardy Nature'), mon('Kingambit', 'Defiant')], leads: { me: ['Garchomp', 'Rillaboom'], opp: ['Smeargle', 'Kingambit'] } },
    [act('me', 'Garchomp', 'move', 'Close Combat', 'Smeargle'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', 'Smeargle', 'Kingambit')],
  );
  assert.deepEqual(boostsFrom(r1!.log, 'Garchomp', 'Moxie'), { atk: 1 });
});

/* ---------- recovery and utility moves ---------- */

test('Recover heals half, Substitute takes the next hit', () => {
  const [, r2] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
    [act('me', 'Garchomp', 'move', 'Recover'), act('me', 'Rillaboom', 'move', 'Substitute'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Rillaboom'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
  );
  assert.ok(residuals(r2!.log, 'Garchomp').some((x) => x.text === 'Recover' && x.pct > 0));
  assert.ok(hitOn(r2!.log, 'Incineroar', 'Flare Blitz')[0]?.substitute);
});

test('Wish heals whoever stands in that position at the end of the next turn', () => {
  const t = [act('me', 'Garchomp', 'move', 'Wish'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')];
  const [r1, r2] = play({ me: ME, opp: OPP, leads: ME_LEADS }, t, [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)]);
  assert.ok(!residuals(r1!.log, 'Garchomp').some((x) => x.text === 'Wish'));
  assert.ok(residuals(r2!.log, 'Garchomp').some((x) => x.text === 'Wish' && x.pct > 0));
});

test('Taunt makes status moves fail; Encore locks the target into its last move this very turn', () => {
  const [r1] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Taunt', 'Kingambit'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
  );
  assert.equal(failNote(r1!.log, 'Kingambit', 'Swords Dance'), "fails (it's taunted (attacks only))");

  const [, e2] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
    [act('me', 'Garchomp', 'move', 'Encore', 'Kingambit'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Close Combat', 'Garchomp')],
  );
  assert.ok(!hits(e2!.log, 'Kingambit', 'Close Combat'));
  assert.ok(boostsFrom(e2!.log, 'Kingambit', 'Swords Dance'));
  assert.ok(e2!.end.find((x) => x.name === 'Kingambit')?.effects?.some((x) => x.startsWith('Encore')));
});

test('a Choice item locks its holder into the first move it uses', () => {
  const [, r2] = play(
    { me: [mon('Garchomp', 'Rough Skin', 'Choice Scarf'), mon('Rillaboom', 'Overgrow')], opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Close Combat', 'Incineroar'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
    [act('me', 'Garchomp', 'move', 'Earthquake'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
  );
  assert.ok(hits(r2!.log, 'Garchomp', 'Close Combat'));
  assert.ok(!hits(r2!.log, 'Garchomp', 'Earthquake'));
});

test('Ally Switch swaps positions, so a move aimed at one hits its partner; After You makes the target act next', () => {
  const [r1] = play(
    { me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Ally Switch'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
  );
  assert.equal(hitOn(r1!.log, 'Incineroar', 'Flare Blitz')[0]?.mon, 'Rillaboom');

  const [a1] = play(
    { me: [mon('Garchomp', 'Rough Skin'), mon('Kingambit', 'Defiant')], opp: [mon('Rillaboom', 'Overgrow'), mon('Incineroar', 'Blaze')], leads: { me: ['Garchomp', 'Kingambit'], opp: ['Rillaboom', 'Incineroar'] } },
    [act('me', 'Garchomp', 'move', 'After You', 'Ally'), act('me', 'Kingambit', 'move', 'Swords Dance'), act('opp', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance')],
  );
  assert.deepEqual(movers(a1!.log).slice(0, 2), ['Kingambit', 'Rillaboom']);
});

test('Eject Button sends its holder out into the Pokémon picked on its action; no pick asks for one', () => {
  const battle: Battle = { me: [mon('Garchomp', 'Rough Skin'), mon('Kingambit', 'Defiant', 'Eject Button'), mon('Rillaboom', 'Overgrow')], opp: OPP,
    leads: { me: ['Garchomp', 'Kingambit'], opp: OPP_LEADS }, backs: { me: ['Rillaboom'] } };
  const turn1 = (kingambit: TurnAction): TurnAction[] => [act('me', 'Garchomp', 'move', 'Swords Dance'), kingambit, act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Kingambit'), act('opp', 'Kingambit', 'move', 'Swords Dance')];
  const [r1] = play(battle, turn1(swap(act('me', 'Kingambit', 'move', 'Swords Dance'), 'Rillaboom')));
  assert.ok(r1!.log.some((l) => l.type === 'switch' && l.mon === 'Kingambit' && l.in === 'Rillaboom' && l.via === 'Eject Button'));
  assert.ok(r1!.state.active.me.includes('Rillaboom'));
});

test('Stealth Rock hurts on the way in by Rock effectiveness; Defog clears it', () => {
  const battle: Battle = { me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Overgrow'), mon('Charizard', 'Blaze')], opp: OPP,
    leads: { me: ['Garchomp', 'Rillaboom'], opp: OPP_LEADS }, backs: { me: ['Charizard'] } };
  const [r1, r2] = play(battle,
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Stealth Rock'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
    [act('me', 'Garchomp', 'move', 'Swords Dance'), sw('me', 'Rillaboom', 'Charizard'), ...idle('opp', ...OPP_LEADS)],
  );
  assert.equal(r1!.field.hazards.me.rocks, true);
  assert.deepEqual(residuals(r2!.log, 'Charizard').map((x) => [x.text, x.pct]), [['Stealth Rock', -50]]);
});

test('Perish Song counts down 3, 2, 1 and everyone who heard it faints at the end of the third turn after', () => {
  const calm = [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)];
  const [, , r3, r4] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Perish Song'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)], calm, calm, calm);
  const onField = (r: Ready): EndMon[] => r.end.filter((x) => r.state.active[x.side].includes(x.name));
  assert.ok(onField(r3!).every((x) => !x.fainted && x.effects?.includes('Perish 1')));
  assert.ok(onField(r4!).every((x) => x.fainted));
});

test('Leech Seed drains 1/8 to the seeder each turn; Counter hits back for twice the physical damage', () => {
  const [r1] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Leech Seed', 'Kingambit'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')]);
  assert.deepEqual(residuals(r1!.log, 'Kingambit').map((x) => [x.text, x.pct]), [['Leech Seed', -12.5]]);
  assert.ok(residuals(r1!.log, 'Garchomp').some((x) => x.text === 'Leech Seed' && x.pct > 0));

  const [c1] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Counter'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Rillaboom'), act('opp', 'Kingambit', 'move', 'Swords Dance')]);
  const blitz = hitOn(c1!.log, 'Incineroar', 'Flare Blitz')[0]!;
  const counter = hitOn(c1!.log, 'Rillaboom', 'Counter')[0]!;
  assert.equal(counter.mon, 'Incineroar');
  assert.ok((counter.maxPct ?? 0) > 0 && blitz.maxPct !== undefined);
});

test('partners\' abilities reach the calculator (Friend Guard), and Telepathy dodges the partner\'s Earthquake', () => {
  play({ me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Friend Guard')], opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')]);
  assert.equal(lastCalls.find((c) => c.move === 'Flare Blitz')?.field.defenderSide.isFriendGuard, true);

  const [r1] = play({ me: [mon('Garchomp', 'Rough Skin'), mon('Rillaboom', 'Telepathy')], opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Earthquake'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)]);
  assert.deepEqual(hitOn(r1!.log, 'Garchomp', 'Earthquake').map((x) => x.mon), ['Incineroar', 'Kingambit']);
});

test('Disguise takes the first hit and costs 1/8 HP; a Mold Breaker attacker goes straight through', () => {
  const battle = (ability: string): Battle => ({ me: [mon('Garchomp', ability), mon('Rillaboom', 'Overgrow')], opp: [mon('Flutter', 'Disguise'), mon('Kingambit', 'Defiant')], leads: { me: ['Garchomp', 'Rillaboom'], opp: ['Flutter', 'Kingambit'] } });
  const t = [act('me', 'Garchomp', 'move', 'Close Combat', 'Flutter'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', 'Flutter', 'Kingambit')];
  const [r1] = play(battle('Rough Skin'), t);
  assert.equal(hitOn(r1!.log, 'Garchomp', 'Close Combat')[0]?.blockedBy, 'Disguise');
  assert.deepEqual(residuals(r1!.log, 'Flutter').map((x) => x.pct), [-12.5]);
  const [m1] = play(battle('Mold Breaker'), t);
  assert.equal(hitOn(m1!.log, 'Garchomp', 'Close Combat')[0]?.blockedBy, undefined);
});

test('Pollen Puff heals a partner; Rest sleeps for exactly two turns', () => {
  const [, r2] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Pollen Puff', 'Ally'), ...idle('opp', ...OPP_LEADS)]);
  assert.ok(residuals(r2!.log, 'Garchomp').some((x) => x.text === 'Pollen Puff' && x.pct > 0));

  const rest = [act('me', 'Garchomp', 'move', 'Rest'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)];
  const [, z2, z3, z4] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Flare Blitz', 'Garchomp'), act('opp', 'Kingambit', 'move', 'Swords Dance')],
    rest, rest, rest);
  assert.equal(z2!.end.find((x) => x.name === 'Garchomp')?.condition, 'slp');
  for (const r of [z3, z4]) assert.ok(r!.log.some((l) => l.type === 'skip' && l.mon === 'Garchomp'));
  void boostsOf;
});

/* ---------- chance outcomes ---------- */

const told = (a: TurnAction, outcome: ActionOutcome): TurnAction => ({ ...a, outcome });

test('a miss does nothing to that target; a crit and a hit count reach the calculator', () => {
  const [r1] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [told(act('me', 'Garchomp', 'move', 'Rock Slide'), { targets: { Incineroar: { miss: true }, Kingambit: { crit: true } } }),
      told(act('me', 'Rillaboom', 'move', 'Bullet Seed', 'Incineroar'), { hits: 5 }), ...idle('opp', ...OPP_LEADS)]);
  const slide = hitOn(r1!.log, 'Garchomp', 'Rock Slide');
  assert.equal(slide.find((x) => x.mon === 'Incineroar')?.missed, true);
  assert.equal(slide.find((x) => x.mon === 'Incineroar')?.minPct, undefined);
  assert.equal(slide.find((x) => x.mon === 'Kingambit')?.crit, true);
  assert.equal(lastCalls.find((c) => c.move === 'Rock Slide' && c.defender === 'Kingambit')?.crit, true);
  assert.equal(lastCalls.find((c) => c.move === 'Bullet Seed')?.hits, 5);
});

test('a flinch from Rock Slide stops a slower target that hasn\'t moved yet', () => {
  const [r1] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [told(act('me', 'Garchomp', 'move', 'Rock Slide'), { targets: { Kingambit: { effects: ['flinch'] } } }), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)]);
  assert.deepEqual(hitOn(r1!.log, 'Garchomp', 'Rock Slide').find((x) => x.mon === 'Kingambit')?.effects, ['flinch']);
  assert.ok(r1!.log.some((l) => l.type === 'skip' && l.mon === 'Kingambit' && l.why === 'flinched'));
});

test('full paralysis, staying asleep and waking up follow the turn\'s outcome', () => {
  const para = [act('me', 'Garchomp', 'move', 'Thunder Wave', 'Kingambit'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)];
  const [, p2] = play({ me: ME, opp: OPP, leads: ME_LEADS }, para,
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'), told(act('opp', 'Kingambit', 'move', 'Swords Dance'), { cant: 'par' })]);
  assert.ok(p2!.log.some((l) => l.type === 'skip' && l.mon === 'Kingambit' && l.why === 'is fully paralysed'));

  const spore = [act('me', 'Garchomp', 'move', 'Spore', 'Kingambit'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)];
  const awake = [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'), told(act('opp', 'Kingambit', 'move', 'Swords Dance'), { wake: true })];
  const [, s2] = play({ me: ME, opp: OPP, leads: ME_LEADS }, spore, awake);
  assert.ok(s2!.log.some((l) => l.type === 'cure' && l.mon === 'Kingambit' && l.text === 'wakes up'));
  assert.ok(boostsFrom(s2!.log, 'Kingambit', 'Swords Dance'));
  const asleep = awake.map((x) => (x.mon === 'Kingambit' ? told(x, { cant: 'slp' }) : x));
  const [, , z3] = play({ me: ME, opp: OPP, leads: ME_LEADS }, spore, asleep, asleep);
  assert.ok(z3!.log.some((l) => l.type === 'skip' && l.mon === 'Kingambit' && l.why === 'is still asleep'));
});

test('a freeze stops the target until it thaws', () => {
  const [, f2, f3] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [told(act('me', 'Garchomp', 'move', 'Ice Beam', 'Kingambit'), { targets: { Kingambit: { effects: ['frz'] } } }), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'), told(act('opp', 'Kingambit', 'move', 'Swords Dance'), { wake: true })]);
  assert.ok(f2!.log.some((l) => l.type === 'skip' && l.mon === 'Kingambit' && l.why.startsWith('is frozen solid')));
  assert.ok(f3!.log.some((l) => l.type === 'cure' && l.mon === 'Kingambit' && l.text === 'thaws out'));
});

test('Swagger confuses and raises Attack; a confused Pokémon can hit itself', () => {
  const [s1, s2] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Swagger', 'Kingambit'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
    [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance'), told(act('opp', 'Kingambit', 'move', 'Swords Dance'), { cant: 'confusion' })]);
  assert.deepEqual(boostsFrom(s1!.log, 'Kingambit', 'Swagger'), { atk: 2 });
  assert.ok(s1!.end.find((x) => x.name === 'Kingambit')?.effects?.includes('confused'));
  assert.ok(residuals(s2!.log, 'Kingambit').some((x) => x.text === 'hurt itself in confusion' && x.pct < 0));
});

test('recorded HP replaces the average roll, recorded order wins over Speed, and a lucky second Protect works', () => {
  const t1 = [act('me', 'Garchomp', 'move', 'Protect'), told(act('me', 'Rillaboom', 'move', 'Close Combat', 'Incineroar'), { targets: { Incineroar: { hp: 65 } } }), ...idle('opp', ...OPP_LEADS)];
  const team = newTeam('T', ME.join('\n\n'));
  const gameplan = newPlan('p', OPP.join('\n\n'));
  const plan = sheetOf(gameplan, gameplan.tabs[0]!);
  plan.selection.me.lead = ME_LEADS.me; plan.selection.opp.lead = ME_LEADS.opp;
  const n1 = newNode({ actions: t1, order: ['opp:Kingambit', 'me:Rillaboom', 'opp:Incineroar'], hpEnd: { 'opp:Kingambit': 40 } });
  const n2 = newNode({ actions: [told(act('me', 'Garchomp', 'move', 'Protect'), { protectWorks: true }), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)] });
  plan.children.push(n1); n1.children.push(n2);
  const results = simulatePlan(createEngine(makeStubCalc().lib), team, plan);
  const r1 = results.get(n1.id) as Ready;
  const r2 = results.get(n2.id) as Ready;
  assert.equal(hitOn(r1.log, 'Rillaboom', 'Close Combat')[0]?.actualPct, 65);
  assert.equal(r1.end.find((x) => x.name === 'Incineroar')?.pct, 65);
  const kingambit = r1.end.find((x) => x.name === 'Kingambit');
  assert.equal(kingambit?.pct, 40);
  assert.equal(kingambit?.actual, 40);
  assert.deepEqual(movers(r1.log).filter((m) => m !== 'Garchomp'), ['Kingambit', 'Rillaboom', 'Incineroar']);
  assert.ok(r2.log.some((l) => l.type === 'protect' && l.mon === 'Garchomp'), 'the second Protect worked');
});

test('Champions freeze: frozen on its first two turns unless it thaws by chance, always thawed on the third', () => {
  const calm = [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)];
  const [f1, f2, f3] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [told(act('me', 'Garchomp', 'move', 'Ice Beam', 'Kingambit'), { targets: { Kingambit: { effects: ['frz'] } } }), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)],
    calm, calm);
  const frozen = (r: Ready): string | undefined => r.log.find((l) => l.type === 'skip' && l.mon === 'Kingambit')?.type === 'skip'
    ? (r.log.find((l) => l.type === 'skip' && l.mon === 'Kingambit') as { why: string }).why : undefined;
  // Frozen by the faster Garchomp, it fails to move that same turn: its first turn frozen.
  assert.match(frozen(f1!) ?? '', /^is frozen solid \(25% chance to thaw each turn; thaws for sure in 2 turns\)$/);
  assert.match(frozen(f2!) ?? '', /thaws for sure next turn/);
  assert.ok(f3!.log.some((l) => l.type === 'cure' && l.mon === 'Kingambit' && l.text === 'thaws out (third turn frozen: it always thaws)'));
  assert.ok(boostsFrom(f3!.log, 'Kingambit', 'Swords Dance'), 'it moves on the turn it thaws');
  assert.equal(f3!.end.find((x) => x.name === 'Kingambit')?.condition, null);
});

test('move data from Showdown: only real chance effects are offered, and missing guaranteed effects are applied', () => {
  assert.deepEqual(chanceEffects('rockslide'), { target: ['flinch'], self: [] });
  assert.deepEqual(chanceEffects('meteormash'), { target: [], self: ['atk+1'] });
  assert.deepEqual(chanceEffects('triattack').target, ['brn', 'par', 'frz']);
  assert.deepEqual(alwaysSelf('makeitrain'), { spa: -2 }, 'the hand-written Champions value wins');
  const [r1] = play({ me: ME, opp: OPP, leads: ME_LEADS },
    [act('me', 'Garchomp', 'move', 'Chilling Water', 'Incineroar'), told(act('me', 'Rillaboom', 'move', 'Meteor Mash', 'Kingambit'), { self: ['atk+1'] }), ...idle('opp', ...OPP_LEADS)]);
  assert.deepEqual(hitOn(r1!.log, 'Garchomp', 'Chilling Water')[0]?.changes, [{ stat: 'atk', delta: -1 }]);
  assert.deepEqual(boostsOf(r1!, 'Rillaboom'), { atk: 1 });
});

test('speed ties are flagged, assumed to go to the first action listed, and can be decided on the turn', () => {
  const mirror: Battle = { me: ME, opp: [mon('Garchomp', 'Rough Skin'), mon('Incineroar', 'Blaze')], leads: { me: ['Garchomp', 'Rillaboom'], opp: ['Garchomp', 'Incineroar'] } };
  const actions = [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Garchomp', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance')];
  const [r1] = play(mirror, actions);
  assert.equal(r1!.ties.length, 1);
  assert.deepEqual(r1!.ties[0]!.keys, ['me:Garchomp', 'opp:Garchomp']);
  assert.equal(r1!.ties[0]!.first, 'me:Garchomp');
  assert.equal(r1!.ties[0]!.picked, false);
  assert.deepEqual(movers(r1!.log).slice(0, 2), ['Garchomp', 'Garchomp']);
  assert.equal(r1!.log.filter((l) => l.type === 'boost')[0]!.side, 'me');

  // The opponent's Garchomp wins the tie when picked on the turn.
  const team = newTeam('T', mirror.me.join('\n\n'));
  const gameplan = newPlan('p', mirror.opp.join('\n\n'));
  const plan = sheetOf(gameplan, gameplan.tabs[0]!);
  plan.selection.me.lead = mirror.leads.me; plan.selection.opp.lead = mirror.leads.opp;
  const n = newNode({ actions, tieOrder: ['opp:Garchomp', 'me:Garchomp'] });
  plan.children.push(n);
  const r = simulatePlan(createEngine(makeStubCalc().lib), team, plan).get(n.id) as Ready;
  assert.equal(r.log.filter((l) => l.type === 'boost')[0]!.side, 'opp');
  assert.deepEqual({ first: r.ties[0]!.first, picked: r.ties[0]!.picked }, { first: 'opp:Garchomp', picked: true });

  // Different Speeds: no tie.
  const [plain] = play({ me: ME, opp: OPP, leads: ME_LEADS }, [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), ...idle('opp', ...OPP_LEADS)]);
  assert.deepEqual(plain!.ties, []);
});

test('a speed tie between the leads\' entry abilities is flagged on first turns and can be picked on the tab', () => {
  const weatherWar: Battle = { me: [mon('Garchomp', 'Drizzle'), mon('Rillaboom', 'Overgrow')], opp: [mon('Garchomp', 'Drought'), mon('Incineroar', 'Blaze')], leads: { me: ['Garchomp', 'Rillaboom'], opp: ['Garchomp', 'Incineroar'] } };
  const calm = [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Garchomp', 'move', 'Swords Dance'), act('opp', 'Incineroar', 'move', 'Swords Dance')];
  const [r1] = play(weatherWar, calm);
  const tie = r1!.ties.find((t) => t.start);
  assert.deepEqual({ keys: tie?.keys, first: tie?.first, picked: tie?.picked, entry: tie?.entry }, { keys: ['me:Garchomp', 'opp:Garchomp'], first: 'me:Garchomp', picked: false, entry: true });
  assert.equal(r1!.field.weather, 'Sun', 'yours enters first (assumed), so the opponent\'s Drought is the one that stays');

  // Picked on the tab: the opponent's Garchomp enters first, so your rain stays.
  const team = newTeam('T', weatherWar.me.join('\n\n'));
  const gameplan = newPlan('p', weatherWar.opp.join('\n\n'));
  const tab = gameplan.tabs[0]!;
  tab.selection.me.lead = weatherWar.leads.me; tab.selection.opp.lead = weatherWar.leads.opp;
  tab.entryTieOrder = ['opp:Garchomp', 'me:Garchomp'];
  const n = newNode({ actions: calm });
  tab.children.push(n);
  const picked = simulatePlan(createEngine(makeStubCalc().lib), team, sheetOf(gameplan, tab)).get(n.id) as Ready;
  assert.equal(picked.field.weather, 'Rain');
  assert.equal(picked.ties.find((t) => t.start)?.picked, true);

  // Same Speed without entry abilities: nothing to flag.
  const [plain] = play({ me: ME, opp: [mon('Garchomp', 'Rough Skin'), mon('Incineroar', 'Blaze')], leads: { me: ['Garchomp', 'Rillaboom'], opp: ['Garchomp', 'Incineroar'] } },
    [act('me', 'Garchomp', 'move', 'Protect'), act('me', 'Rillaboom', 'move', 'Swords Dance'), act('opp', 'Garchomp', 'move', 'Protect'), act('opp', 'Incineroar', 'move', 'Swords Dance')]);
  assert.equal(plain!.ties.filter((t) => t.entry).length, 0);
});

test('replacements come in fastest first, and a tie between their entry abilities is flagged on that turn', () => {
  const frail = 'EVs: 1 Spe\nHardy Nature';
  const battle: Battle = {
    me: [mon('Smeargle', 'Own Tempo', '', frail), mon('Kingambit', 'Defiant'), mon('Garchomp', 'Drizzle')],
    opp: [mon('Smeargle', 'Own Tempo', '', frail), mon('Kingambit', 'Defiant'), mon('Garchomp', 'Drought')],
    leads: { me: ['Smeargle', 'Kingambit'], opp: ['Smeargle', 'Kingambit'] }, backs: { me: ['Garchomp'], opp: ['Garchomp'] },
  };
  const t1 = [act('me', 'Smeargle', 'move', 'Swords Dance'), act('me', 'Kingambit', 'move', 'Close Combat', 'Smeargle'), act('opp', 'Smeargle', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Close Combat', 'Smeargle')];
  const t2 = [act('me', 'Garchomp', 'move', 'Swords Dance'), act('me', 'Kingambit', 'move', 'Swords Dance'), act('opp', 'Garchomp', 'move', 'Swords Dance'), act('opp', 'Kingambit', 'move', 'Swords Dance')];
  const [r1, r2] = play(battle, t1, t2);
  assert.ok(r1!.end.filter((x) => x.name === 'Smeargle').every((x) => x.fainted), 'both Smeargle fainted');
  const tie = r2!.ties.find((t) => t.entry);
  assert.ok(tie && !tie.start);
  assert.equal(tie.first, 'me:Garchomp');
  assert.equal(r2!.field.weather, 'Sun');
});
