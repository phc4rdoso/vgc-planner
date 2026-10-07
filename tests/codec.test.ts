import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DataError, EXPORT_FORMAT, LIMITS, buildExport, mergeImport, readExport, readLibrary, writeLibrary } from '../src/domain/codec.ts';
import type { ExportFile } from '../src/domain/codec.ts';
import { clonePlan, cloneTab, countNodes, newNode, newPlan, newTab, newTeam } from '../src/domain/model.ts';
import type { Library } from '../src/domain/types.ts';

function sampleLibrary(): Library {
  const team = newTeam('Rain', 'Rillaboom @ Leftovers\nEVs: 32 HP\n- Fake Out');
  const plan = newPlan('vs Sun', 'Incineroar\nEVs: 32 HP');
  plan.tabs[0]!.selection.me.lead = ['Rillaboom', null];
  const turn = newNode({ title: 'T1', actions: [{ side: 'me', mon: 'Rillaboom', kind: 'move', move: 'Fake Out', target: 'Incineroar' }] });
  turn.children.push(newNode({ condition: 'If Protect', note: 'hello' }));
  plan.tabs[0]!.children.push(turn);
  team.plans.push(plan);
  return { teams: [team] };
}

test('export then import round-trips teams, plans and turns with fresh ids', () => {
  const lib = sampleLibrary();
  const file = JSON.parse(JSON.stringify(buildExport(lib, { type: 'all' }))) as unknown;
  const target: Library = { teams: [] };
  const summary = mergeImport(target, readExport(file));
  assert.equal(summary.newTeams, 1);
  assert.equal(summary.plans, 1);
  const plan = target.teams[0]!.plans[0]!;
  assert.equal(countNodes(plan.tabs[0]!.children), 2);
  assert.equal(plan.tabs[0]!.children[0]!.children[0]!.condition, 'If Protect');
  assert.equal(plan.tabs[0]!.selection.me.lead[0], 'Rillaboom');
  assert.notEqual(plan.id, lib.teams[0]!.plans[0]!.id);
  assert.notEqual(plan.tabs[0]!.children[0]!.id, lib.teams[0]!.plans[0]!.tabs[0]!.children[0]!.id);
});

test('the Pokémon a pivot move switches to survives export, import and storage', () => {
  const lib = sampleLibrary();
  lib.teams[0]!.plans[0]!.tabs[0]!.children[0]!.actions[0] = { side: 'me', mon: 'Rillaboom', kind: 'move', move: 'U-turn', target: 'Incineroar', pivot: 'Garchomp' };
  const target: Library = { teams: [] };
  mergeImport(target, readExport(JSON.parse(JSON.stringify(buildExport(lib, { type: 'all' })))));
  assert.equal(target.teams[0]!.plans[0]!.tabs[0]!.children[0]!.actions[0]!.pivot, 'Garchomp');
  const stored = readLibrary(JSON.parse(JSON.stringify(writeLibrary(lib))));
  assert.equal(stored.teams[0]!.plans[0]!.tabs[0]!.children[0]!.actions[0]!.pivot, 'Garchomp');
  lib.teams[0]!.plans[0]!.tabs[0]!.children[0]!.actions[0] = { side: 'me', mon: 'Rillaboom', kind: 'move', move: 'Fake Out', target: 'Incineroar' };
  const plain = readLibrary(JSON.parse(JSON.stringify(writeLibrary(lib))));
  assert.ok(!('pivot' in plain.teams[0]!.plans[0]!.tabs[0]!.children[0]!.actions[0]!), 'no empty pivot field is added');
});

/** The sample gameplan plus a second tab with other leads and its own turn. */
function twoTabLibrary(): Library {
  const lib = sampleLibrary();
  const plan = lib.teams[0]!.plans[0]!;
  const tab = newTab('Trick Room mode');
  tab.selection.me.lead = ['Garchomp', 'Rillaboom'];
  tab.selection.opp.back = ['Incineroar', null];
  tab.children.push(newNode({ title: 'TR turn', actions: [{ side: 'me', mon: 'Garchomp', kind: 'move', move: 'Protect', target: '' }] }));
  plan.tabs.push(tab);
  return lib;
}

test('export and import keep every tab of a gameplan: names, leads/backs and turns', () => {
  const lib = twoTabLibrary();
  const file = JSON.parse(JSON.stringify(buildExport(lib, { type: 'plan', teamId: lib.teams[0]!.id, planId: lib.teams[0]!.plans[0]!.id }))) as ExportFile;
  assert.equal(file.version, 2);
  assert.deepEqual(file.teams[0]!.plans[0]!.tabs.map((t) => t.name), ['Plan 1', 'Trick Room mode']);
  const target: Library = { teams: [] };
  mergeImport(target, readExport(file));
  const tabs = target.teams[0]!.plans[0]!.tabs;
  assert.deepEqual(tabs.map((t) => t.name), ['Plan 1', 'Trick Room mode']);
  assert.deepEqual(tabs[1]!.selection.me.lead, ['Garchomp', 'Rillaboom']);
  assert.deepEqual(tabs[1]!.selection.opp.back, ['Incineroar', null]);
  assert.equal(tabs[1]!.children[0]!.title, 'TR turn');
  assert.equal(countNodes(tabs[0]!.children), 2);
  assert.notEqual(tabs[1]!.id, lib.teams[0]!.plans[0]!.tabs[1]!.id, 'imports get fresh ids');
});

test('stored data keeps tab ids; data saved before tabs becomes one tab with the same turns', () => {
  const lib = twoTabLibrary();
  const back = readLibrary(JSON.parse(JSON.stringify(writeLibrary(lib))));
  assert.deepEqual(back.teams[0]!.plans[0]!.tabs.map((t) => t.id), lib.teams[0]!.plans[0]!.tabs.map((t) => t.id));

  const plan = sampleLibrary().teams[0]!.plans[0]!;
  const { tabs, ...rest } = plan;
  const legacy = { schemaVersion: 1, teams: [{ id: 't', name: 'Rain', paste: '', plans: [{ ...rest, selection: tabs[0]!.selection, children: tabs[0]!.children }] }] };
  const upgraded = readLibrary(JSON.parse(JSON.stringify(legacy))).teams[0]!.plans[0]!;
  assert.equal(upgraded.tabs.length, 1);
  assert.equal(upgraded.tabs[0]!.name, 'Plan 1');
  assert.equal(upgraded.tabs[0]!.children[0]!.id, tabs[0]!.children[0]!.id, 'turn ids survive, so the open turn stays open');
  assert.deepEqual(upgraded.tabs[0]!.selection.me.lead, ['Rillaboom', null]);
});

test('version 1 export files (one selection and flow per gameplan) import as one tab', () => {
  const v1 = {
    format: EXPORT_FORMAT, version: 1, teams: [{ name: 'Rain', paste: '', plans: [{
      name: 'vs Sun', opponent: { name: '', paste: '' },
      selection: { me: { lead: ['Rillaboom', null], back: [null, null] }, opp: { lead: [null, null], back: [null, null] } },
      flow: [{ title: 'T1', actions: [], children: [{ title: 'T2' }] }],
    }] }],
  };
  const tabs = readExport(v1).teams[0]!.plans[0]!.tabs;
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0]!.children[0]!.children[0]!.title, 'T2');
  assert.deepEqual(tabs[0]!.selection.me.lead, ['Rillaboom', null]);
});

test('duplicating a gameplan or a tab copies everything with fresh ids', () => {
  const plan = twoTabLibrary().teams[0]!.plans[0]!;
  const copy = clonePlan(plan);
  assert.equal(copy.tabs.length, 2);
  assert.ok(copy.tabs.every((t, i) => t.id !== plan.tabs[i]!.id && t.name === plan.tabs[i]!.name));
  assert.notEqual(copy.tabs[1]!.children[0]!.id, plan.tabs[1]!.children[0]!.id);
  const tab = cloneTab(plan.tabs[1]!, 'Copy');
  assert.equal(tab.name, 'Copy');
  assert.deepEqual(tab.selection, plan.tabs[1]!.selection);
  tab.selection.me.lead[0] = null;
  assert.equal(plan.tabs[1]!.selection.me.lead[0], 'Garchomp', 'the copy is independent');
});

test('importing a plan into an existing team (same name) adds to that folder', () => {
  const lib = sampleLibrary();
  const file = buildExport(lib, { type: 'plan', teamId: lib.teams[0]!.id, planId: lib.teams[0]!.plans[0]!.id });
  assert.equal(file.teams[0]!.plans.length, 1);
  const summary = mergeImport(lib, readExport(JSON.parse(JSON.stringify(file))));
  assert.equal(summary.newTeams, 0);
  assert.equal(lib.teams.length, 1);
  assert.equal(lib.teams[0]!.plans.length, 2);
  assert.equal(summary.focus?.teamId, lib.teams[0]!.id);
});

test('rejects unrecognised or malformed files with a readable message', () => {
  assert.throws(() => readExport(null), DataError);
  assert.throws(() => readExport({}), /Unrecognized file/);
  assert.throws(() => readExport({ format: EXPORT_FORMAT }), /Missing "teams"/);
  assert.throws(() => readExport({ format: EXPORT_FORMAT, teams: [{ name: 5 }] }), /teams\[0\]\.name must be text/);
  assert.throws(() => readExport({ format: EXPORT_FORMAT, version: 99, teams: [] }), /newer version/);
});

test('warns, but still imports, when the regulation differs', () => {
  const parsed = readExport({ format: EXPORT_FORMAT, regulation: 'ZZ', teams: [] });
  assert.match(parsed.regulationWarning ?? '', /ZZ/);
});

test('enforces size limits against hostile input', () => {
  let deep: Record<string, unknown> = { title: 'leaf' };
  for (let i = 0; i < LIMITS.depth + 5; i++) deep = { title: 'n', children: [deep] };
  const file = { format: EXPORT_FORMAT, teams: [{ name: 't', plans: [{ name: 'p', flow: [deep] }] }] };
  assert.throws(() => readExport(file), /nested too deeply/);
  const big = { format: EXPORT_FORMAT, teams: [{ name: 't', paste: 'x'.repeat(LIMITS.textLength + 1), plans: [] }] };
  assert.throws(() => readExport(big), /too long/);
});

test('stored library keeps ids and rejects data from a newer schema', () => {
  const lib = sampleLibrary();
  const back = readLibrary(JSON.parse(JSON.stringify(writeLibrary(lib))));
  assert.equal(back.teams[0]!.id, lib.teams[0]!.id);
  assert.equal(back.teams[0]!.plans[0]!.tabs[0]!.children[0]!.id, lib.teams[0]!.plans[0]!.tabs[0]!.children[0]!.id);
  assert.throws(() => readLibrary({ schemaVersion: 999, teams: [] }), /newer version/);
});

test('reads data saved by the earlier single-file version ({ teams, ui })', () => {
  const legacy = { teams: sampleLibrary().teams, ui: { teamId: 'x', zoom: 1 } };
  assert.equal(readLibrary(JSON.parse(JSON.stringify(legacy))).teams.length, 1);
});

test('chance results survive export and import, combined stat changes included; junk is dropped', () => {
  const lib = { teams: [{ name: 'T', paste: '', plans: [{ name: 'p', opponent: { name: '', paste: '' }, tabs: [{ name: 'Plan 1', selection: {}, flow: [{
    title: '', condition: '', note: '', children: [], order: ['me:A', 'opp:B'], hpEnd: { 'opp:B': 42.5 }, source: { replay: 'https://replay.pokemonshowdown.com/x-1' },
    actions: [{ side: 'me', mon: 'A', kind: 'move', move: 'Ancient Power', target: 'B', outcome: {
      cant: 'par', wake: 'yes', hits: 99, self: ['atk+1,def+1,spa+1,spd+1,spe+1', 'evil'], targets: { B: { miss: true, crit: 1, effects: ['flinch', 'spd-1', '<script>'], hp: 140 } },
    } }],
  }] }] }] }] };
  const parsed = readExport({ format: 'vgc-gameplan-planner', version: 2, ...lib });
  const node = parsed.teams[0]!.plans[0]!.tabs[0]!.children[0]!;
  assert.deepEqual(node.actions[0]!.outcome, { cant: 'par', self: ['atk+1,def+1,spa+1,spd+1,spe+1'], targets: { B: { miss: true, effects: ['flinch', 'spd-1'], hp: 100 } } });
  assert.deepEqual(node.order, ['me:A', 'opp:B']);
  assert.deepEqual(node.hpEnd, { 'opp:B': 42.5 });
  assert.equal(node.source?.replay, 'https://replay.pokemonshowdown.com/x-1');
});
