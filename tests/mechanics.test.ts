/**
 * Battle mechanics with a trigger: items, entry abilities, end-of-turn order, contact damage, redirection, Mega
 * Evolution timing. Damage numbers come from the stand-in calculator, so the tests check what happens and in which
 * order rather than exact amounts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNode, newPlan, newTeam, sheetOf } from '../src/domain/model.ts';
import { createEngine } from '../src/domain/simulation/engine.ts';
import type { HitResult, LogEntry, TurnResult } from '../src/domain/simulation/log.ts';
import { simulatePlan } from '../src/domain/simulation/plan.ts';
import type { ActionKind, FlowNode, Side, TurnAction } from '../src/domain/types.ts';
import type { CalcCall } from './helpers/stub-calc.ts';
import { makeStubCalc } from './helpers/stub-calc.ts';

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
