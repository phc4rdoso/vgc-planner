/**
 * The API: sign-in with Discord or Google (OAuth 2.0 authorization-code flow), sessions, and the signed-in user.
 * Only standard web APIs are used (Request, Response, fetch, crypto), so this runs on Cloudflare Workers and in
 * Node tests alike; the database is behind {@link Store}.
 *
 * Security notes:
 * - The provider's client secret never leaves the server; the browser only ever sees our own session cookie.
 * - A random `state` (kept in a short-lived HttpOnly cookie) ties each callback to the sign-in that started it.
 * - Sessions are random 256-bit tokens in an HttpOnly, SameSite=Lax cookie; only their SHA-256 is stored.
 * - Requests that change something must come from the app's own origin (checked on `Origin`), on top of SameSite.
 */

import { AVATARS } from '../../src/domain/avatars.ts';
import type { LibraryStore } from './library.ts';
import { handleLibrary } from './library.ts';
import type { ShareStore } from './shares.ts';
import { handleShares } from './shares.ts';

export type ProviderId = 'discord' | 'google';
export const PROVIDER_IDS: readonly ProviderId[] = ['discord', 'google'];

export interface User {
  id: string;
  /** 'dev' only for the local development sign-in. */
  provider: ProviderId | 'dev';
  providerId: string;
  name: string;
  createdAt: number;
  onboardedAt: number | null;
  /** Profile picture: a name from AVATARS (null only for accounts made before profile pictures). */
  avatar: string | null;
}

/** Persistence for users, sessions and libraries (D1 in production, in memory in tests). Times are epoch milliseconds. */
export interface Store extends LibraryStore, ShareStore {
  /** Returns the user for this provider account, creating it on first sign-in. */
  /** `avatar` is used only when the account is created. */
  upsertUser(provider: User['provider'], providerId: string, name: string, now: number, avatar: string): Promise<{ user: User; created: boolean }>;
  setAvatar(userId: string, avatar: string): Promise<void>;
  createSession(tokenHash: string, userId: string, expiresAt: number, now: number): Promise<void>;
  /** The session's user, or null when the session is unknown or expired. */
  sessionUser(tokenHash: string, now: number): Promise<User | null>;
  deleteSession(tokenHash: string): Promise<void>;
  markOnboarded(userId: string, now: number): Promise<void>;
}

export interface OAuthClient { clientId: string; clientSecret: string }

export interface ApiConfig {
  /** Where the app is served, e.g. "https://gameplans.example" (in development, the Vite dev server). */
  appUrl: string;
  /** Providers with credentials; the others are hidden from the sign-in box. */
  providers: Partial<Record<ProviderId, OAuthClient>>;
  /** Development only: allows signing in with just a name. Never enable in production. */
  devLogin: boolean;
}

export interface ApiDeps {
  store: Store;
  config: ApiConfig;
  /** Outgoing requests to the providers (injected so tests don't touch the network). */
  fetch: typeof fetch;
  now: () => number;
}

const SESSION_COOKIE = 'sid';
const STATE_COOKIE = 'oauth_state';
const SESSION_DAYS = 30;
const STATE_MINUTES = 10;
const NAME_MAX = 64;

interface ProviderSpec {
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  /** The smallest scope that gives an id and a display name (no e-mail). */
  scope: string;
  profile(body: Record<string, unknown>): { id: string; name: string } | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const PROVIDERS: Readonly<Record<ProviderId, ProviderSpec>> = {
  discord: {
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    profileUrl: 'https://discord.com/api/users/@me',
    scope: 'identify',
    profile: (b) => (str(b.id) ? { id: str(b.id), name: str(b.global_name) || str(b.username) } : null),
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid profile',
    profile: (b) => (str(b.sub) ? { id: str(b.sub), name: str(b.name) || str(b.given_name) } : null),
  },
};

/* ------------------------------- helpers ------------------------------- */

const isProvider = (v: string): v is ProviderId => (PROVIDER_IDS as readonly string[]).includes(v);

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const randomToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares secrets without leaking where they differ through timing. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, opts: { maxAge: number; path: string; secure: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Path=${opts.path}; Max-Age=${opts.maxAge}; HttpOnly; SameSite=Lax${opts.secure ? '; Secure' : ''}`;
}

/** Display names come from the provider: trimmed, control characters removed, length-capped. */
function cleanName(name: string): string {
  const printable = Array.from(name).filter((ch) => { const c = ch.codePointAt(0)!; return c >= 0x20 && c !== 0x7f; });
  const cleaned = Array.from(printable.join('').trim()).slice(0, NAME_MAX).join('');
  return cleaned || 'Trainer';
}

const API_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const;

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers({ ...API_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  for (const [k, v] of new Headers(extra)) headers.append(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ ...API_HEADERS, Location: location });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

const publicUser = (u: User) => ({ id: u.id, name: u.name, provider: u.provider, onboarded: u.onboardedAt !== null, avatar: u.avatar });

const ALLOWED_AVATARS: ReadonlySet<string> = new Set(AVATARS);

/** A profile picture chosen at random, for a new account. */
function randomAvatar(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return AVATARS[n! % AVATARS.length]!;
}

/* -------------------------------- routes -------------------------------- */

export async function handleApi(req: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const app = new URL(deps.config.appUrl);
  const secure = app.protocol === 'https:';

  // Anything that changes state must come from the app itself (defence in depth on top of SameSite cookies).
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.get('Origin') !== app.origin) {
    return json({ error: 'forbidden' }, 403);
  }

  const sessionHash = async (): Promise<string | null> => {
    const token = readCookies(req)[SESSION_COOKIE];
    return token ? sha256Hex(token) : null;
  };
  const currentUser = async (): Promise<User | null> => {
    const hash = await sessionHash();
    return hash ? deps.store.sessionUser(hash, deps.now()) : null;
  };
  const startSession = async (user: User): Promise<string> => {
    const token = randomToken();
    const now = deps.now();
    await deps.store.createSession(await sha256Hex(token), user.id, now + SESSION_DAYS * 864e5, now);
    return cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400, path: '/', secure });
  };

  if (req.method === 'GET' && path === '/api/auth/providers') {
    return json({ providers: PROVIDER_IDS.filter((p) => deps.config.providers[p]), dev: deps.config.devLogin });
  }

  const start = path.match(/^\/api\/auth\/([a-z]+)\/start$/);
  if (req.method === 'GET' && start) {
    const id = start[1]!;
    const client = isProvider(id) ? deps.config.providers[id] : undefined;
    if (!isProvider(id) || !client) return json({ error: 'unknown provider' }, 404);
    const state = randomToken();
    const target = new URL(PROVIDERS[id].authorizeUrl);
    target.search = new URLSearchParams({
      client_id: client.clientId, redirect_uri: `${app.origin}/api/auth/${id}/callback`,
      response_type: 'code', scope: PROVIDERS[id].scope, state, prompt: id === 'google' ? 'select_account' : 'consent',
    }).toString();
    return redirect(target.toString(), [cookie(STATE_COOKIE, `${id}:${state}`, { maxAge: STATE_MINUTES * 60, path: '/api/auth', secure })]);
  }

  const callback = path.match(/^\/api\/auth\/([a-z]+)\/callback$/);
  if (req.method === 'GET' && callback) {
    const id = callback[1]!;
    const clearState = cookie(STATE_COOKIE, '', { maxAge: 0, path: '/api/auth', secure });
    const back = (outcome: string): Response => redirect(`${app.origin}/?login=${outcome}`, [clearState]);
    const client = isProvider(id) ? deps.config.providers[id] : undefined;
    if (!isProvider(id) || !client) return back('error');
    if (url.searchParams.get('error')) return back('cancelled');
    const code = url.searchParams.get('code') ?? '';
    const expected = readCookies(req)[STATE_COOKIE] ?? '';
    if (!code || !expected || !sameSecret(expected, `${id}:${url.searchParams.get('state') ?? ''}`)) return back('error');

    try {
      const spec = PROVIDERS[id];
      const tokenRes = await deps.fetch(spec.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'authorization_code',
          code, redirect_uri: `${app.origin}/api/auth/${id}/callback`,
        }),
      });
      if (!tokenRes.ok) return back('error');
      const accessToken = str(((await tokenRes.json()) as Record<string, unknown>).access_token);
      if (!accessToken) return back('error');
      const profileRes = await deps.fetch(spec.profileUrl, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
      if (!profileRes.ok) return back('error');
      const profile = spec.profile((await profileRes.json()) as Record<string, unknown>);
      if (!profile) return back('error');
      const { user } = await deps.store.upsertUser(id, profile.id, cleanName(profile.name), deps.now(), randomAvatar());
      return redirect(`${app.origin}/`, [clearState, await startSession(user)]);
    } catch {
      return back('error');
    }
  }

  if (req.method === 'POST' && path === '/api/auth/dev') {
    if (!deps.config.devLogin) return json({ error: 'not found' }, 404);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = cleanName(str(body.name));
    const { user } = await deps.store.upsertUser('dev', name.toLowerCase(), name, deps.now(), randomAvatar());
    return json({ user: publicUser(user) }, 200, { 'Set-Cookie': await startSession(user) });
  }

  if (req.method === 'POST' && path === '/api/auth/logout') {
    const hash = await sessionHash();
    if (hash) await deps.store.deleteSession(hash);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0, path: '/', secure }) });
  }

  if (req.method === 'GET' && path === '/api/me') {
    // Being signed out is a normal answer here (not a 401), so a visitor's first page load logs no errors.
    const user = await currentUser();
    if (!user) return json({ user: null });
    // Accounts from before profile pictures get theirs now; it is stored, so it stays the same from then on.
    if (!user.avatar || !ALLOWED_AVATARS.has(user.avatar)) {
      user.avatar = randomAvatar();
      await deps.store.setAvatar(user.id, user.avatar);
    }
    return json({ user: publicUser(user) });
  }

  if (req.method === 'POST' && path === '/api/me/avatar') {
    const user = await currentUser();
    if (!user) return json({ error: 'signed out' }, 401);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const avatar = str(body.avatar);
    if (!ALLOWED_AVATARS.has(avatar)) return json({ error: 'Pick one of the available profile pictures.' }, 400);
    await deps.store.setAvatar(user.id, avatar);
    return json({ user: publicUser({ ...user, avatar }) });
  }

  if (req.method === 'POST' && path === '/api/me/onboarded') {
    const user = await currentUser();
    if (!user) return json({ error: 'signed out' }, 401);
    await deps.store.markOnboarded(user.id, deps.now());
    return json({ ok: true });
  }

  // Share links come first: reading one works signed out, and /api/plans/:id/share isn't a library route.
  if (path === '/api/shares' || path.startsWith('/api/shares/') || /^\/api\/plans\/[^/]+\/share$/.test(path)) {
    const user = await currentUser();
    const res = await handleShares(req, path, user?.id ?? null, deps.store, deps.now(), randomToken);
    if (res) return res;
  }

  if (path === '/api/library' || path.startsWith('/api/teams/') || path.startsWith('/api/plans/')) {
    const user = await currentUser();
    if (!user) return json({ error: 'signed out' }, 401);
    const res = await handleLibrary(req, path, user.id, deps.store, deps.now());
    if (res) return res;
  }

  return json({ error: 'not found' }, 404);
}
