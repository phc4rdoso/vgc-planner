import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiConfig, ApiDeps } from '../server/src/app.ts';
import { handleApi } from '../server/src/app.ts';
import { MemoryStore } from './helpers/memory-store.ts';
import { AVATARS } from '../src/domain/avatars.ts';

const APP = 'https://gameplans.example';

/** A fake Discord: issues a token for code "good" and returns a fixed profile. Records what it was sent. */
function fakeDiscord(calls: { url: string; body?: string }[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    if (url.includes('/oauth2/token')) {
      const code = new URLSearchParams(String(init?.body)).get('code');
      return code === 'good' ? Response.json({ access_token: 'at-1' }) : new Response('bad', { status: 400 });
    }
    if (url.endsWith('/users/@me')) return Response.json({ id: '42', username: 'ash', global_name: 'Ash\u0007 Ketchum' });
    return new Response('?', { status: 404 });
  }) as typeof fetch;
}

function setup(config: Partial<ApiConfig> = {}) {
  const store = new MemoryStore();
  const calls: { url: string; body?: string }[] = [];
  let now = 1_000_000;
  const deps: ApiDeps = {
    store, fetch: fakeDiscord(calls), now: () => now,
    config: { appUrl: APP, providers: { discord: { clientId: 'cid', clientSecret: 'shh' } }, devLogin: false, ...config },
  };
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set('Cookie', init.cookie);
    return handleApi(new Request(`${APP}${path}`, { ...init, headers }), deps);
  };
  return { store, calls, call, advance: (ms: number) => { now += ms; } };
}

const setCookies = (res: Response): string[] => res.headers.getSetCookie();
const cookieValue = (res: Response, name: string): string =>
  setCookies(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1) ?? '';

/** Runs start + callback, returning the session cookie header to send afterwards. */
async function signIn(s: ReturnType<typeof setup>, code = 'good'): Promise<{ res: Response; sid: string }> {
  const start = await s.call('/api/auth/discord/start');
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const res = await s.call(`/api/auth/discord/callback?code=${code}&state=${state}`, { cookie: `oauth_state=${cookieValue(start, 'oauth_state')}` });
  return { res, sid: cookieValue(res, 'sid') };
}

test('only configured providers are offered, and the dev sign-in is off unless enabled', async () => {
  const s = setup();
  assert.deepEqual(await (await s.call('/api/auth/providers')).json(), { providers: ['discord'], dev: false });
  assert.equal((await s.call('/api/auth/google/start')).status, 404);
  const dev = await s.call('/api/auth/dev', { method: 'POST', headers: { Origin: APP }, body: '{"name":"x"}' });
  assert.equal(dev.status, 404);
});

test('start redirects to the provider with a state that is also kept in an HttpOnly cookie', async () => {
  const s = setup();
  const res = await s.call('/api/auth/discord/start');
  assert.equal(res.status, 302);
  const target = new URL(res.headers.get('Location')!);
  assert.equal(target.origin + target.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(target.searchParams.get('scope'), 'identify');
  assert.equal(target.searchParams.get('redirect_uri'), `${APP}/api/auth/discord/callback`);
  assert.ok(!target.toString().includes('shh'), 'the client secret never reaches the browser');
  const stateCookie = setCookies(res).find((c) => c.startsWith('oauth_state='))!;
  assert.match(stateCookie, /HttpOnly; SameSite=Lax; Secure/);
  assert.equal(decodeURIComponent(cookieValue(res, 'oauth_state')), `discord:${target.searchParams.get('state')}`);
});

test('a first sign-in creates the account and a session; the welcome tour is pending until marked done', async () => {
  const s = setup();
  const { res, sid } = await signIn(s);
  assert.equal(res.headers.get('Location'), `${APP}/`);
  assert.ok(sid.length >= 40);
  assert.ok(!s.store.sessions.has(sid), 'only a hash of the token is stored');
  assert.match(s.calls.find((c) => c.url.includes('/token'))?.body ?? '', /client_secret=shh/);

  const me = await (await s.call('/api/me', { cookie: `sid=${sid}` })).json() as { user: { name: string; onboarded: boolean; avatar: string } };
  const { avatar, ...rest } = me.user;
  assert.deepEqual(rest, { id: 'u1', name: 'Ash Ketchum', provider: 'discord', onboarded: false, newsSeen: null }, 'control characters are stripped from names');
  assert.ok(AVATARS.includes(avatar), 'a profile picture from the allowed list');

  assert.equal((await s.call('/api/me/onboarded', { method: 'POST', cookie: `sid=${sid}`, headers: { Origin: APP } })).status, 200);
  const again = await (await s.call('/api/me', { cookie: `sid=${sid}` })).json() as { user: { onboarded: boolean } };
  assert.equal(again.user.onboarded, true);

  // The news shown is kept on the account, and never goes back to an older item.
  const news = (seen: unknown) => s.call('/api/me/news', { method: 'POST', cookie: `sid=${sid}`, headers: { Origin: APP }, body: JSON.stringify({ seen }) });
  assert.equal((await news(2)).status, 200);
  assert.equal((await news(1)).status, 200);
  assert.equal((await news('2')).status, 400, 'a number is required');
  assert.equal((await news(-1)).status, 400);
  const seenNow = await (await s.call('/api/me', { cookie: `sid=${sid}` })).json() as { user: { newsSeen: number | null } };
  assert.equal(seenNow.user.newsSeen, 2);
  assert.equal((await s.call('/api/me/news', { method: 'POST', body: '{"seen":3}', headers: { Origin: APP } })).status, 401, 'signed out');

  await signIn(s);
  assert.equal(s.store.users.length, 1, 'signing in again reuses the account');
});

test('a callback with a missing or forged state, a refused consent or a bad code does not sign in', async () => {
  const s = setup();
  const start = await s.call('/api/auth/discord/start');
  const forged = await s.call('/api/auth/discord/callback?code=good&state=attacker', { cookie: `oauth_state=${cookieValue(start, 'oauth_state')}` });
  assert.equal(forged.headers.get('Location'), `${APP}/?login=error`);
  assert.equal(cookieValue(forged, 'sid'), '');
  const noCookie = await s.call('/api/auth/discord/callback?code=good&state=abc');
  assert.equal(noCookie.headers.get('Location'), `${APP}/?login=error`);
  const denied = await s.call('/api/auth/discord/callback?error=access_denied&state=abc');
  assert.equal(denied.headers.get('Location'), `${APP}/?login=cancelled`);
  const { res } = await signIn(s, 'bad');
  assert.equal(res.headers.get('Location'), `${APP}/?login=error`);
  assert.equal(s.store.users.length, 0);
});

test('changes need the app’s own Origin; sessions expire and end on sign-out', async () => {
  const s = setup();
  const { sid } = await signIn(s);
  const cross = await s.call('/api/me/onboarded', { method: 'POST', cookie: `sid=${sid}`, headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal((await s.call('/api/me/onboarded', { method: 'POST', cookie: `sid=${sid}` })).status, 403, 'no Origin header');

  const out = await s.call('/api/auth/logout', { method: 'POST', cookie: `sid=${sid}`, headers: { Origin: APP } });
  assert.match(setCookies(out).join(), /sid=; Path=\/; Max-Age=0/);
  assert.deepEqual(await (await s.call('/api/me', { cookie: `sid=${sid}` })).json(), { user: null }, 'signed out');

  const second = await signIn(s);
  s.advance(31 * 864e5);
  assert.deepEqual(await (await s.call('/api/me', { cookie: `sid=${second.sid}` })).json(), { user: null }, 'sessions last 30 days');
});

test('the development sign-in works only when enabled, and API responses are never cached', async () => {
  const s = setup({ devLogin: true, appUrl: 'http://localhost:5173' });
  const res = await handleApi(new Request('http://localhost:5173/api/auth/dev', {
    method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Misty' }),
  }), { store: s.store, fetch, now: () => 1, config: { appUrl: 'http://localhost:5173', providers: {}, devLogin: true } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.doesNotMatch(setCookies(res).join(), /Secure/, 'plain http on localhost');
  assert.equal(s.store.users[0]?.name, 'Misty');
});

test('a user can pick their own display name; signing in again keeps it, and bad names are refused', async () => {
  const s = setup();
  const { sid } = await signIn(s);
  const rename = (name: unknown, origin = APP) => s.call('/api/me/name', { method: 'POST', cookie: `sid=${sid}`, headers: { Origin: origin }, body: JSON.stringify({ name }) });
  assert.equal((await rename('')).status, 400);
  assert.equal((await rename('x'.repeat(65))).status, 400);
  assert.equal((await rename('Ash\u0007')).status, 400, 'control characters are refused');
  assert.equal((await rename('Rain Master', 'https://evil.example')).status, 403, 'only from the app itself');
  const ok = await rename('  Rain Master  ');
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { user: { name: string } }).user.name, 'Rain Master');
  await signIn(s);
  assert.equal(s.store.users[0]!.name, 'Rain Master', 'the provider name no longer overwrites it');
});
