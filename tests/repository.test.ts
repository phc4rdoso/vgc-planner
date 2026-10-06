import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newPlan, newTeam } from '../src/domain/model.ts';
import { LocalStoragePrefs } from '../src/infra/prefs.ts';
import { LocalStorageRepository, MemoryRepository, RepositoryError } from '../src/infra/repository.ts';
import type { StorageLike } from '../src/infra/repository.ts';
import { AppStore } from '../src/state/store.ts';

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  failWrites = false;
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { if (this.failWrites) throw new Error('quota'); this.data.set(k, v); }
}

test('saves and loads the library', async () => {
  const storage = new FakeStorage();
  const repo = new LocalStorageRepository(storage, 'lib');
  const team = newTeam('A', 'Rillaboom'); team.plans.push(newPlan('p'));
  await repo.save({ teams: [team] });
  const loaded = await repo.load();
  assert.equal(loaded.teams[0]?.plans[0]?.name, 'p');
});

test('an empty storage gives an empty library', async () => {
  assert.deepEqual(await new LocalStorageRepository(new FakeStorage(), 'lib').load(), { teams: [] });
});

test('migrates data from the legacy key without losing it', async () => {
  const storage = new FakeStorage();
  const team = newTeam('Old', 'Rillaboom');
  storage.setItem('legacy', JSON.stringify({ teams: [team], ui: { teamId: team.id, zoom: 0.8, open: { [team.id]: true } } }));
  const repo = new LocalStorageRepository(storage, 'lib', 'legacy');
  assert.equal((await repo.load()).teams[0]?.name, 'Old');
  const prefs = new LocalStoragePrefs(storage, 'prefs', 'legacy').load();
  assert.equal(prefs.teamId, team.id);
  assert.equal(prefs.zoom, 0.8);
  assert.equal(prefs.open[team.id], true);
});

test('unreadable data is backed up, never overwritten silently', async () => {
  const storage = new FakeStorage();
  storage.setItem('lib', '{not json');
  await assert.rejects(new LocalStorageRepository(storage, 'lib').load(), RepositoryError);
  assert.ok([...storage.data.keys()].some((k) => k.startsWith('lib:unreadable-')));
});

test('a full or blocked storage reports a clear error on save', async () => {
  const storage = new FakeStorage();
  storage.failWrites = true;
  await assert.rejects(new LocalStorageRepository(storage, 'lib').save({ teams: [] }), /storage is full/);
});

test('store restores the last open plan from preferences and reports save errors', async () => {
  const storage = new FakeStorage();
  const repo = new LocalStorageRepository(storage, 'lib');
  const prefs = new LocalStoragePrefs(storage, 'prefs');
  const team = newTeam('A', ''); const plan = newPlan('p'); team.plans.push(plan);
  await repo.save({ teams: [team] });
  prefs.save({ teamId: team.id, planId: plan.id, tabId: null, open: {}, zoom: 5, navCollapsed: true });
  const store = new AppStore(repo, prefs);
  await store.init();
  assert.equal(store.plan?.id, plan.id);
  assert.equal(store.ui.zoom, 1.6, 'zoom is clamped to the allowed range');
  assert.equal(store.ui.navCollapsed, true, 'the collapsed sidebar is remembered');

  const errors: string[] = [];
  store.onError = (m) => errors.push(m);
  storage.failWrites = true;
  await store.flush();
  assert.equal(errors.length, 1);
});

test('MemoryRepository isolates stored data from later mutation', async () => {
  const repo = new MemoryRepository();
  const lib = { teams: [newTeam('A')] };
  await repo.save(lib);
  lib.teams[0]!.name = 'changed';
  assert.equal((await repo.load()).teams[0]?.name, 'A');
});
