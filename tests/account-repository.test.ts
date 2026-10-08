import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNode, newPlan, newTeam } from '../src/domain/model.ts';
import type { Library } from '../src/domain/types.ts';
import { AccountRepository } from '../src/infra/account-repository.ts';
import { MemoryPrefs } from '../src/infra/prefs.ts';
import { MemoryRepository, RepositoryError } from '../src/infra/repository.ts';
import { AppStore } from '../src/state/store.ts';
import type { ApiDeps } from '../server/src/app.ts';
import { handleApi } from '../server/src/app.ts';
import { MemoryStore } from './helpers/memory-store.ts';

const APP = 'http://localhost:5173';

/** The real API (in memory) behind a fetch that plays the browser: same origin, session cookie, request log. */
async function server() {
  const store = new MemoryStore();
  const deps: ApiDeps = { store, fetch, now: () => 1000, config: { appUrl: APP, providers: {}, devLogin: true } };
  const login = await handleApi(new Request(`${APP}/api/auth/dev`, { method: 'POST', headers: { Origin: APP }, body: '{"name":"Ash"}' }), deps);
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const requests: string[] = [];
  let offline = false;
  const browserFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (offline) throw new TypeError('Failed to fetch');
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    const headers = new Headers(init?.headers);
    headers.set('Cookie', cookie);
    if (init?.method && init.method !== 'GET') headers.set('Origin', APP);
    return handleApi(new Request(`${APP}${String(input)}`, { ...init, headers }), deps);
  }) as typeof fetch;
  return { store, requests, device: () => new AccountRepository(browserFetch), setOffline: (v: boolean) => { offline = v; } };
}

function sampleLibrary(): Library {
  const team = newTeam('Rain', 'Pelipper\nEVs: 32 HP');
  const plan = newPlan('vs Sun', 'Torkoal\nEVs: 32 HP');
  plan.tabs[0]!.selection.me.lead = ['Pelipper', null];
  plan.tabs[0]!.children.push(newNode({ title: 'T1', children: [newNode({ tags: ['If Protect'] })] }));
  team.plans.push(plan, newPlan('vs Room'));
  return { teams: [team, newTeam('Sand')] };
}

test('everything saved to the account comes back on the next sign-in, ids and all', async () => {
  const s = await server();
  const lib = sampleLibrary();
  await s.device().save(lib);
  assert.deepEqual(await s.device().load(), lib);
});

test('only what changed is sent, and deletions follow', async () => {
  const s = await server();
  const repo = s.device();
  const lib = sampleLibrary();
  await repo.load();
  await repo.save(lib);
  assert.equal(s.requests.filter((r) => r.startsWith('PUT')).length, 4, 'two teams and two gameplans');

  s.requests.length = 0;
  await repo.save(lib);
  assert.deepEqual([...s.requests], [], 'nothing changed, nothing sent');

  lib.teams[0]!.plans[0]!.tabs[0]!.children[0]!.title = 'Turn one';
  await repo.save(lib);
  assert.deepEqual(s.requests, [`PUT /api/plans/${lib.teams[0]!.plans[0]!.id}`]);

  s.requests.length = 0;
  const removed = lib.teams.pop()!;
  lib.teams[0]!.plans.pop();
  await repo.save(lib);
  assert.equal(s.requests.length, 2);
  assert.ok(s.requests.includes(`DELETE /api/teams/${removed.id}`));
  assert.equal(s.store.teams.length, 1);
  assert.equal(s.store.plans.length, 1);
});

test('two devices editing the same gameplan: the second save is refused instead of overwriting', async () => {
  const s = await server();
  await s.device().save(sampleLibrary());
  const phone = s.device(); const laptop = s.device();
  const onPhone = await phone.load(); const onLaptop = await laptop.load();
  onPhone.teams[0]!.plans[0]!.name = 'vs Sun (phone)';
  await phone.save(onPhone);
  onLaptop.teams[0]!.plans[0]!.name = 'vs Sun (laptop)';
  await assert.rejects(laptop.save(onLaptop), (e: unknown) => e instanceof RepositoryError && /changed on another device or tab\. Reload/.test(e.message));
  assert.equal((await s.device().load()).teams[0]!.plans[0]!.name, 'vs Sun (phone)', 'the phone’s edit is kept');
});

test('a failed save is retried with the next one; nothing is marked saved until the server confirms', async () => {
  const s = await server();
  const repo = s.device();
  const lib = sampleLibrary();
  await repo.load();
  s.setOffline(true);
  await assert.rejects(repo.save(lib), /Couldn't reach the server/);
  s.setOffline(false);
  await repo.save(lib);
  assert.deepEqual(await s.device().load(), lib);
});

test('signing in switches the store to the account library, keeping the open gameplan when it exists there', async () => {
  const s = await server();
  const lib = sampleLibrary();
  await s.device().save(lib);
  const store = new AppStore(new MemoryRepository({ teams: [newTeam('Only on this device')] }), new MemoryPrefs());
  await store.init();
  Object.assign(store.ui, { teamId: lib.teams[0]!.id, planId: lib.teams[0]!.plans[0]!.id });
  await store.useRepository(s.device());
  assert.deepEqual(store.library.teams.map((t) => t.name), ['Rain', 'Sand']);
  assert.equal(store.plan?.name, 'vs Sun', 'the same gameplan is still open');

  store.library.teams[0]!.name = 'Rain offense';
  store.persist();
  assert.equal(store.saveState, 'pending');
  await store.flush();
  assert.equal(store.saveState, 'saved');
  assert.equal((await s.device().load()).teams[0]!.name, 'Rain offense');
});
