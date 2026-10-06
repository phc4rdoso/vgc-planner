import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { AVATARS } from '../src/domain/avatars.ts';
import type { ApiDeps } from '../server/src/app.ts';
import { handleApi } from '../server/src/app.ts';
import { MemoryStore } from './helpers/memory-store.ts';

const APP = 'http://localhost:5173';

function setup() {
  const store = new MemoryStore();
  const deps: ApiDeps = { store, fetch, now: () => 1000, config: { appUrl: APP, providers: {}, devLogin: true } };
  const signIn = async (name: string) => {
    const res = await handleApi(new Request(`${APP}/api/auth/dev`, { method: 'POST', headers: { Origin: APP }, body: JSON.stringify({ name }) }), deps);
    const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
    const call = (method: string, path: string, body?: unknown, origin: string | null = APP) => handleApi(new Request(`${APP}${path}`, {
      method, headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    }), deps);
    const me = async () => ((await (await call('GET', '/api/me')).json()) as { user: { avatar: string } }).user;
    return { call, me };
  };
  return { store, signIn };
}

test('every portrait in the allowed list has its image (1-1025, named after the Pokémon)', () => {
  assert.equal(AVATARS.length, 1025);
  assert.deepEqual([AVATARS[0], AVATARS[24], AVATARS[121], AVATARS[1024]], ['Bulbasaur', 'Pikachu', 'Mr_Mime', 'Pecharunt']);
  const missing = AVATARS.filter((a) => !existsSync(new URL(`../public/avatars/${a}.png`, import.meta.url)));
  assert.deepEqual(missing, []);
});

test('a new account gets a random allowed picture that stays the same across sessions', async () => {
  const s = setup();
  const first = await (await s.signIn('Ash')).me();
  assert.ok(AVATARS.includes(first.avatar));
  const again = await (await s.signIn('Ash')).me();
  assert.equal(again.avatar, first.avatar, 'signing in again keeps it');

  const picks = new Set<string>();
  for (let i = 0; i < 25; i++) picks.add((await (await s.signIn(`Trainer ${i}`)).me()).avatar);
  assert.ok(picks.size > 5, 'pictures are picked at random');
});

test('accounts made before profile pictures get one once, and keep it', async () => {
  const s = setup();
  const misty = await s.signIn('Misty');
  s.store.users[0]!.avatar = null;
  const given = (await misty.me()).avatar;
  assert.ok(AVATARS.includes(given));
  assert.equal(s.store.users[0]!.avatar, given, 'stored');
  assert.equal((await misty.me()).avatar, given);
});

test('only allowed pictures can be chosen, by the signed-in owner, from the app', async () => {
  const s = setup();
  const brock = await s.signIn('Brock');
  const res = await brock.call('POST', '/api/me/avatar', { avatar: 'Onix' });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { user: { avatar: string } }).user.avatar, 'Onix');
  assert.equal((await brock.me()).avatar, 'Onix');

  for (const bad of ['../../etc/passwd', 'onix', 'Agumon', '', 42]) {
    assert.equal((await brock.call('POST', '/api/me/avatar', { avatar: bad })).status, 400, String(bad));
  }
  assert.equal((await brock.call('POST', '/api/me/avatar', { avatar: 'Geodude' }, 'https://evil.example')).status, 403);
  assert.equal((await handleApi(new Request(`${APP}/api/me/avatar`, { method: 'POST', headers: { Origin: APP }, body: '{"avatar":"Geodude"}' }), {
    store: s.store, fetch, now: () => 1, config: { appUrl: APP, providers: {}, devLogin: true },
  })).status, 401);
  assert.equal((await brock.me()).avatar, 'Onix');
});

test('portrait names are written properly where the file name can\u2019t', async () => {
  const { avatarLabel } = await import('../src/ui/avatar-picker.ts');
  assert.deepEqual(['Mr_Mime', 'Farfetch_d', 'Nidoran_F', 'Type_Null', 'Flabebe', 'Iron_Valiant', 'Pikachu'].map(avatarLabel),
    ['Mr. Mime', 'Farfetch\u2019d', 'Nidoran\u2640', 'Type: Null', 'Flab\u00e9b\u00e9', 'Iron Valiant', 'Pikachu']);
});
