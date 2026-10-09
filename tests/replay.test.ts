/**
 * Replay import against a real Champions VGC replay (tests/fixtures/replays, player names anonymised), with the real
 * damage calculator: every imported turn must simulate, and knock-outs must happen where the replay has them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as calc from '@smogon/calc';
import { newPlan, newTeam, sheetOf } from '../src/domain/model.ts';
import { parseReplayLog, ReplayError } from '../src/domain/replay.ts';
import { alwaysEffect, buildReplayBranch, placeReplayBranch } from '../src/domain/replay-import.ts';
import { parseShowdown } from '../src/domain/showdown.ts';
import type { CalcLib } from '../src/domain/simulation/calc-types.ts';
import { createEngine } from '../src/domain/simulation/engine.ts';
import type { TurnResult } from '../src/domain/simulation/log.ts';
import { simulatePlan } from '../src/domain/simulation/plan.ts';
import type { FlowNode } from '../src/domain/types.ts';
import { ALICE, BOB } from './fixtures/replays/champions-1-teams.ts';
import { fetchReplayLog, parseReplayLink } from '../src/infra/replay.ts';

const { log } = JSON.parse(readFileSync('tests/fixtures/replays/champions-1.json', 'utf8')) as { log: string };
const URL = 'https://replay.pokemonshowdown.com/gen9championsvgc2026regmc-0000000000';
const engine = createEngine(calc as unknown as CalcLib);

const ctx = (team = ALICE, opponent = BOB) => ({ team: parseShowdown(team), opponent: parseShowdown(opponent), moveInfo: (n: string) => engine.moveInfo(n) });
const parsed = () => parseReplayLog(log, { always: alwaysEffect((n) => engine.moveInfo(n)) });

test('the replay becomes leads, backs and one turn per replay turn, from the right side', () => {
  const branch = buildReplayBranch(parsed(), ctx(), URL);
  assert.equal(branch.me, 'p1');
  assert.deepEqual(branch.selection.me, { lead: ['Basculegion', 'Kingambit'], back: ['Whimsicott', 'Garchomp'] });
  assert.deepEqual(branch.selection.opp, { lead: ['Sneasler', 'Armarouge'], back: ['Indeedee-F', 'Salamence'] });
  assert.equal(branch.turns.length, 7);
  const t1 = branch.turns[0]!;
  assert.equal(t1.source?.replay, URL);
  assert.ok(t1.actions.some((a) => a.side === 'opp' && a.mon === 'Sneasler' && a.kind === 'switch' && a.target === 'Indeedee-F'));
  assert.deepEqual(t1.actions.find((a) => a.mon === 'Basculegion')?.outcome?.targets, { 'Indeedee-F': { hp: 0 } });
  const t4 = branch.turns[3]!;
  assert.equal(t4.actions.find((a) => a.mon === 'Garchomp')?.kind, 'mega');
  assert.equal(t4.actions.find((a) => a.side === 'opp' && a.mon === 'Salamence')?.target, 'Both foes');
  // Guaranteed drops (Draco Meteor, Armor Cannon) are left to the simulation, not recorded as chance.
  assert.equal(branch.turns[4]!.actions.find((a) => a.mon === 'Garchomp')?.outcome?.self, undefined);
  // The same team on both sides played the other way round is still found (you as player 2).
  assert.equal(buildReplayBranch(parsed(), ctx(BOB, ALICE), URL).me, 'p2');
});

test('the imported branch simulates turn by turn, with knock-outs where the replay has them', () => {
  const team = newTeam('Alice', ALICE);
  const plan = newPlan('vs Bob', BOB);
  const branch = buildReplayBranch(parsed(), ctx(), URL);
  const placed = placeReplayBranch(plan, branch, false);
  assert.equal(placed.created, true);
  assert.equal(placed.added, 7);
  const sheet = sheetOf(plan, placed.tab);
  const results = simulatePlan(engine, team, sheet);
  let node: FlowNode | undefined = sheet.children[0];
  let n = 1;
  while (node) {
    const r = results.get(node.id) as TurnResult;
    assert.equal(r?.status, 'ready', `turn ${n}: ${JSON.stringify(r)}`);
    if (r.status !== 'ready') break;
    const pins: [string, number][] = Object.entries(node.hpEnd ?? {});
    for (const [k, pct] of pins) {
      const [side, name] = k.split(':') as ['me' | 'opp', string];
      const end: { fainted: boolean } | undefined = r.state.mons[side][name];
      assert.equal(end?.fainted, pct <= 0, `turn ${n}: ${k} should ${pct <= 0 ? '' : 'not '}have fainted`);
    }
    const next: FlowNode | undefined = node.children[0];
    node = next;
    n++;
  }
  assert.equal(n - 1, 7);
  const last = results.get(sheet.children[0]!.children[0]!.children[0]!.children[0]!.children[0]!.children[0]!.children[0]!.id) as TurnResult;
  assert.ok(last.status === 'ready' && last.outcome === 'win');
});

test('importing the same replay again reuses its turns; forcing a new tab makes another one', () => {
  const plan = newPlan('vs Bob', BOB);
  placeReplayBranch(plan, buildReplayBranch(parsed(), ctx(), URL), false);
  const again = placeReplayBranch(plan, buildReplayBranch(parsed(), ctx(), URL), false);
  assert.equal(again.created, false);
  assert.equal(again.merged, 7);
  assert.equal(again.added, 0);
  const forced = placeReplayBranch(plan, buildReplayBranch(parsed(), ctx(), URL), true);
  assert.equal(forced.created, true);
  assert.equal(plan.tabs.length, 3);
  assert.deepEqual(plan.tabs.map((t) => t.name), ['Plan 1', 'Replay: Alice vs Bob', 'Replay: Alice vs Bob (2)']);
});

test('a team that differs from the paste is refused with the exact differences', () => {
  const changed = ALICE.replace('Encore', 'Helping Hand').replace('Garchomp @ Garchompite Z', 'Garchomp @ Choice Scarf');
  assert.throws(() => buildReplayBranch(parsed(), ctx(changed), URL), (e: unknown) => {
    assert.ok(e instanceof ReplayError);
    assert.match(e.message, /Garchomp: item GarchompiteZ in the replay, Choice Scarf in the paste/);
    assert.match(e.message, /Whimsicott: moves differ \(Encore only in the replay; Helping Hand only in the paste\)/);
    return true;
  });
  assert.throws(() => buildReplayBranch(parsed(), ctx(ALICE, ALICE), URL), ReplayError);
});

test('replay links are recognised in their usual forms, and nothing else is', async () => {
  const id = 'gen9championsvgc2026regmc-2694443394-j94ltjnoif4b9ob93959hxey8wbbqb1pw';
  for (const text of [`https://replay.pokemonshowdown.com/${id}`, `replay.pokemonshowdown.com/${id}.json`, ` https://replay.pokemonshowdown.com/${id}?p2 `, `https://replay.pokemonshowdown.com/${id}.log`]) {
    assert.equal(parseReplayLink(text)?.json, `https://replay.pokemonshowdown.com/${id}.json`, text);
  }
  for (const text of ['', 'https://pokepast.es/59ed8cd86a5f2223', 'https://replay.pokemonshowdown.com/', 'https://replay.pokemonshowdown.com.evil.example/gen9vgc-1', 'javascript:alert(1)']) {
    assert.equal(parseReplayLink(text), null, text);
  }
  const link = parseReplayLink(`https://replay.pokemonshowdown.com/${id}`)!;
  const respond = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status });
  assert.equal(await fetchReplayLog(link, respond(200, { log: '|gametype|doubles' })), '|gametype|doubles');
  await assert.rejects(fetchReplayLog(link, respond(404, {})), /no replay at that link/);
  await assert.rejects(fetchReplayLog(link, (async () => { throw new TypeError('offline'); }) as typeof fetch), /Couldn’t reach Pokémon Showdown/);
});

test('an imported replay is named as a branch (not a tag) where it starts: its first turn not already in the plan', () => {
  const plan = newPlan('vs Bob', BOB);
  const first = placeReplayBranch(plan, buildReplayBranch(parsed(), ctx(), URL), false);
  const start = first.tab.children[0]!;
  assert.deepEqual(start.line, { name: 'Replay: Alice vs Bob' });
  assert.deepEqual(start.tags, []);
  // A second import of a game that only differs from turn 4 on: the new branch hangs off turn 3 and carries the name.
  const again = buildReplayBranch(parsed(), ctx(), URL);
  again.turns[3]!.actions = again.turns[3]!.actions.map((a) => ({ ...a, move: a.kind === 'switch' ? a.move : 'Protect' }));
  const placed = placeReplayBranch(plan, again, false);
  assert.equal(placed.merged, 3);
  let node = placed.tab.children[0]!;
  for (let k = 0; k < 2; k++) node = node.children[0]!;
  const fork = node.children;
  assert.equal(fork.length, 2);
  assert.deepEqual(fork[1]!.line, { name: 'Replay: Alice vs Bob' });
  assert.equal(fork[0]!.line, undefined, 'turns from the first import keep what they had');
});

test('a Mega that switches out and back in is still the same Pokémon, not another back', () => {
  const log = [
    '|gametype|doubles', '|player|p1|A||', '|player|p2|B||', '|gen|9',
    '|poke|p1|Garchomp, L50|', '|poke|p1|Whimsicott, L50|', '|poke|p1|Sneasler, L50|', '|poke|p1|Kingambit, L50|',
    '|poke|p2|Incineroar, L50|', '|poke|p2|Rillaboom, L50|', '|poke|p2|Gholdengo, L50|', '|poke|p2|Volcarona, L50|',
    '|start',
    '|switch|p1a: Garchomp|Garchomp, L50|100/100', '|switch|p1b: Whimsicott|Whimsicott, L50|100/100',
    '|switch|p2a: Incineroar|Incineroar, L50|100/100', '|switch|p2b: Rillaboom|Rillaboom, L50|100/100',
    '|turn|1',
    '|detailschange|p1a: Garchomp|Garchomp-Mega-Z, L50', '|-mega|p1a: Garchomp|Garchomp|Garchompite Z',
    '|move|p1a: Garchomp|Protect|p1a: Garchomp',
    '|turn|2',
    '|switch|p1a: Sneasler|Sneasler, L50|100/100',
    '|turn|3',
    '|switch|p1a: Garchomp|Garchomp-Mega-Z, L50|100/100',
    '|turn|4',
    '|switch|p1a: Kingambit|Kingambit, L50|100/100',
    '|turn|5',
    '|win|A',
  ].join('\n');
  const parsed = parseReplayLog(log);
  assert.deepEqual(parsed.backs.p1, ['Sneasler', 'Kingambit']);
});
