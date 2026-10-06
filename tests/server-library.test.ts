import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNode, newPlan } from '../src/domain/model.ts';
import type { ApiDeps } from '../server/src/app.ts';
import { handleApi } from '../server/src/app.ts';
import { QUOTA } from '../server/src/library.ts';
import { MemoryStore } from './helpers/memory-store.ts';

const APP = 'http://localhost:5173';

/** A server with the local test sign-in, and helpers to call it as a signed-in user. */
function setup() {
  const store = new MemoryStore();
  const deps: ApiDeps = { store, fetch, now: () => 1000, config: { appUrl: APP, providers: {}, devLogin: true } };
  const as = async (name: string) => {
    const res = await handleApi(new Request(`${APP}/api/auth/dev`, { method: 'POST', headers: { Origin: APP }, body: JSON.stringify({ name }) }), deps);
    const sid = res.headers.getSetCookie()[0]!.split(';')[0]!;
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { Origin: APP }) =>
      handleApi(new Request(`${APP}${path}`, { method, headers: { Cookie: sid, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), deps);
    return { call, library: async () => (await call('GET', '/api/library')).json() as Promise<{ teams: { id: string; name: string; version: number; plans: { id: string; name: string; version: number; tabs: { children: { title: string }[] }[] }[] }[] }> };
  };
  return { store, deps, as };
}

const planBody = (teamId: string, name: string, baseVersion = 0, position = 0) => {
  const plan = newPlan(name, 'Incineroar\nEVs: 32 HP');
  plan.tabs[0]!.children.push(newNode({ title: 'T1' }));
  return { baseVersion, position, teamId, name: plan.name, opponent: plan.opponent, tabs: plan.tabs };
};

test('the library needs a session; teams and gameplans round-trip in order with versions', async () => {
  const s = setup();
  assert.equal((await handleApi(new Request(`${APP}/api/library`), s.deps)).status, 401);
  const ash = await s.as('Ash');
  assert.deepEqual(await ash.library(), { teams: [] });

  assert.deepEqual(await (await ash.call('PUT', '/api/teams/t-2', { baseVersion: 0, position: 1, name: 'Second', paste: '' })).json(), { version: 1 });
  await ash.call('PUT', '/api/teams/t-1', { baseVersion: 0, position: 0, name: 'Rain', paste: 'Pelipper' });
  assert.equal((await ash.call('PUT', '/api/plans/p-1', planBody('t-1', 'vs Sun'))).status, 200);

  const lib = await ash.library();
  assert.deepEqual(lib.teams.map((t) => t.name), ['Rain', 'Second'], 'ordered by position');
  assert.equal(lib.teams[0]!.plans[0]!.name, 'vs Sun');
  assert.equal(lib.teams[0]!.plans[0]!.tabs[0]!.children[0]!.title, 'T1');
  assert.equal(lib.teams[0]!.plans[0]!.version, 1);
});

test('a write based on an old version is refused with the current version', async () => {
  const s = setup();
  const ash = await s.as('Ash');
  await ash.call('PUT', '/api/teams/t-1', { baseVersion: 0, position: 0, name: 'Rain', paste: '' });
  assert.equal((await ash.call('PUT', '/api/teams/t-1', { baseVersion: 1, position: 0, name: 'Rain 2', paste: '' })).status, 200);
  const stale = await ash.call('PUT', '/api/teams/t-1', { baseVersion: 1, position: 0, name: 'Rain 3', paste: '' });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'conflict', version: 2 });
  const again = await ash.call('PUT', '/api/teams/t-1', { baseVersion: 0, position: 0, name: 'Dup', paste: '' });
  assert.equal(again.status, 409, 'creating an id that already exists is a conflict too');
  const orphan = await ash.call('PUT', '/api/plans/p-1', planBody('nope', 'x'));
  assert.deepEqual(await orphan.json(), { error: 'team not found' });
});

test('uploads are validated, size-capped and need the app’s Origin', async () => {
  const s = setup();
  const ash = await s.as('Ash');
  assert.equal((await ash.call('PUT', '/api/teams/t-1', { baseVersion: 0, position: 0, name: 5 })).status, 400);
  assert.equal((await ash.call('PUT', '/api/teams/bad%20id', { baseVersion: 0, position: 0, name: 'x' })).status, 400);
  assert.equal((await ash.call('PUT', '/api/teams/t-1', { baseVersion: -1, position: 0, name: 'x' })).status, 400);
  assert.equal((await ash.call('PUT', '/api/teams/t-1', '{not json')).status, 400);
  const big = { baseVersion: 0, position: 0, name: 'x', paste: 'x'.repeat(QUOTA.bodyBytes) };
  assert.equal((await ash.call('PUT', '/api/teams/t-1', big)).status, 413);
  assert.equal((await ash.call('PUT', '/api/teams/t-1', { baseVersion: 0, position: 0, name: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(s.store.teams.length, 0);

  for (let i = 0; i < QUOTA.teams; i++) s.store.teams.push({ userId: 'u1', id: `q${i}`, position: i, data: '{}', version: 1 });
  const full = await ash.call('PUT', '/api/teams/one-more', { baseVersion: 0, position: 0, name: 'x', paste: '' });
  assert.equal(full.status, 413);
  assert.match(((await full.json()) as { error: string }).error, /up to 200 teams/);
});

test('accounts are isolated, even when they use the same ids; deleting a team deletes its gameplans', async () => {
  const s = setup();
  const ash = await s.as('Ash');
  const misty = await s.as('Misty');
  await ash.call('PUT', '/api/teams/t-1', { baseVersion: 0, position: 0, name: 'Ash team', paste: '' });
  await ash.call('PUT', '/api/plans/p-1', planBody('t-1', 'Ash plan'));

  assert.deepEqual(await misty.library(), { teams: [] }, 'cannot see another account');
  assert.equal((await misty.call('PUT', '/api/teams/t-1', { baseVersion: 0, position: 0, name: 'Misty team', paste: '' })).status, 200, 'same id, own row');
  await misty.call('DELETE', '/api/teams/t-1');
  assert.equal((await ash.library()).teams[0]?.name, 'Ash team', 'deleting your own t-1 never touches someone else’s');

  await ash.call('DELETE', '/api/teams/t-1');
  assert.deepEqual(await ash.library(), { teams: [] });
  assert.equal(s.store.plans.length, 0, 'its gameplans went with it');
});
