import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeImport } from '../src/domain/codec.ts';
import { newNode, newPlan } from '../src/domain/model.ts';
import { readSharedPlan } from '../src/domain/share.ts';
import type { Library } from '../src/domain/types.ts';
import type { ApiDeps } from '../server/src/app.ts';
import { handleApi } from '../server/src/app.ts';
import { MemoryStore } from './helpers/memory-store.ts';

const APP = 'http://localhost:5173';

function setup() {
  const store = new MemoryStore();
  const deps: ApiDeps = { store, fetch, now: () => 1000, config: { appUrl: APP, providers: {}, devLogin: true } };
  const anon = (path: string) => handleApi(new Request(`${APP}${path}`), deps);
  const as = async (name: string) => {
    const res = await handleApi(new Request(`${APP}/api/auth/dev`, { method: 'POST', headers: { Origin: APP }, body: JSON.stringify({ name }) }), deps);
    const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
    return (method: string, path: string, body?: unknown, origin: string | null = APP) => handleApi(new Request(`${APP}${path}`, {
      method, headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    }), deps);
  };
  return { store, anon, as };
}

/** Ash's team "Rain" with the gameplan "vs Sun" (two tabs, one turn), stored in his account. */
async function ashWithPlan(s: ReturnType<typeof setup>) {
  const ash = await s.as('Ash');
  await ash('PUT', '/api/teams/t-1', { baseVersion: 0, position: 0, name: 'Rain', paste: 'Pelipper\nEVs: 32 HP' });
  const plan = newPlan('vs Sun', 'Torkoal\nEVs: 32 HP');
  plan.tabs[0]!.children.push(newNode({ title: 'T1' }));
  plan.tabs.push({ ...plan.tabs[0]!, id: 'tab-2', name: 'Trick Room', children: [] });
  await ash('PUT', '/api/plans/p-1', { baseVersion: 0, position: 0, teamId: 't-1', name: plan.name, opponent: plan.opponent, tabs: plan.tabs });
  return ash;
}

test('only the signed-in owner can create a link, from the app; it is created once and reused', async () => {
  const s = setup();
  const ash = await ashWithPlan(s);
  assert.equal((await s.anon('/api/plans/p-1/share')).status, 401);
  assert.equal((await ash('POST', '/api/plans/p-1/share', {}, 'https://evil.example')).status, 403);
  assert.deepEqual(await (await ash('GET', '/api/plans/p-1/share')).json(), { token: null });

  const { token } = await (await ash('POST', '/api/plans/p-1/share', {})).json() as { token: string };
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '256 random bits');
  assert.deepEqual(await (await ash('POST', '/api/plans/p-1/share', {})).json(), { token }, 'the same link again');
  assert.deepEqual(await (await ash('GET', '/api/plans/p-1/share')).json(), { token });

  const misty = await s.as('Misty');
  assert.equal((await misty('POST', '/api/plans/p-1/share', {})).status, 409, 'p-1 is not one of Misty’s gameplans');
});

test('anyone with the link sees the gameplan and its team, but no account or record ids', async () => {
  const s = setup();
  const ash = await ashWithPlan(s);
  const { token } = await (await ash('POST', '/api/plans/p-1/share', {})).json() as { token: string };

  const res = await s.anon(`/api/shares/${token}`);
  assert.equal(res.status, 200);
  const text = await res.clone().text();
  const body = await res.json() as { owner: string; isOwner: boolean; team: { name: string; paste: string }; plan: { name: string; tabs: unknown[] } };
  assert.equal(body.owner, 'Ash');
  assert.equal(body.isOwner, false);
  assert.equal(body.team.name, 'Rain');
  assert.equal(body.plan.tabs.length, 2);
  assert.ok(!('planId' in body), 'viewers don’t learn the owner’s gameplan id');
  assert.ok(!text.includes('"u1"') && !text.includes('t-1'), 'no account or team ids');

  const asOwner = await (await ash('GET', `/api/shares/${token}`)).json() as { isOwner: boolean; planId: string };
  assert.deepEqual([asOwner.isOwner, asOwner.planId], [true, 'p-1']);
  const misty = await s.as('Misty');
  assert.equal(((await (await misty('GET', `/api/shares/${token}`)).json()) as { isOwner: boolean }).isOwner, false);

  assert.equal((await s.anon('/api/shares/not-a-token')).status, 404);
  assert.equal((await s.anon(`/api/shares/${'A'.repeat(43)}`)).status, 404);
});

test('a link stops working when sharing stops, or when its gameplan or team is deleted', async () => {
  const s = setup();
  const ash = await ashWithPlan(s);
  const first = (await (await ash('POST', '/api/plans/p-1/share', {})).json() as { token: string }).token;
  await ash('DELETE', '/api/plans/p-1/share');
  assert.equal((await s.anon(`/api/shares/${first}`)).status, 404);

  const second = (await (await ash('POST', '/api/plans/p-1/share', {})).json() as { token: string }).token;
  assert.notEqual(second, first, 'sharing again makes a new link');
  await ash('DELETE', '/api/teams/t-1');
  assert.equal((await s.anon(`/api/shares/${second}`)).status, 404);
  assert.equal(s.store.shares.length, 0);
});

test('a shared gameplan becomes the viewer’s own copy: validated, with fresh ids', async () => {
  const s = setup();
  const ash = await ashWithPlan(s);
  const { token } = await (await ash('POST', '/api/plans/p-1/share', {})).json() as { token: string };
  const shared = readSharedPlan(await (await s.anon(`/api/shares/${token}`)).json());
  assert.equal(shared.owner, 'Ash');
  const plan = shared.parsed.teams[0]!.plans[0]!;
  assert.deepEqual(plan.tabs.map((t) => t.name), ['Plan 1', 'Trick Room']);
  assert.equal(plan.tabs[0]!.children[0]!.title, 'T1');
  assert.notEqual(plan.id, 'p-1');
  assert.notEqual(plan.tabs[1]!.id, 'tab-2');

  const library: Library = { teams: [] };
  mergeImport(library, shared.parsed);
  assert.equal(library.teams[0]!.name, 'Rain');

  assert.throws(() => readSharedPlan({ owner: 'x', team: {}, plan: { name: 'p' } }), /missing its tabs/);
  assert.throws(() => readSharedPlan({ team: { name: 5 }, plan: { tabs: [] } }), /must be text/);
});
