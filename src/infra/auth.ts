/**
 * Talks to the sign-in API (server/src/app.ts). The session lives in an HttpOnly cookie the page can't read, so
 * every call just sends same-origin credentials. When there is no API at all (the app deployed as a plain static
 * site), accounts are reported as unavailable and the app keeps working locally.
 */

export type ProviderId = 'discord' | 'google';

/** `avatar`: the profile picture, a name from AVATARS (file public/avatars/<avatar>.png). */
export interface Account { id: string; name: string; provider: ProviderId | 'dev'; onboarded: boolean; newsSeen: number | null; avatar: string | null }

export type AccountState =
  | { status: 'unavailable' }
  | { status: 'signed-out'; providers: ProviderId[]; dev: boolean }
  | { status: 'signed-in'; account: Account; providers: ProviderId[]; dev: boolean };

const send = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(path, { credentials: 'same-origin', ...init, headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });

const isJson = (res: Response): boolean => (res.headers.get('Content-Type') ?? '').includes('application/json');

/** Who is signed in, and which sign-in options the server offers. */
export async function loadAccount(): Promise<AccountState> {
  try {
    // Startup waits for this, so a slow or missing API must not hold the app for long.
    const signal = AbortSignal.timeout(5000);
    const [providersRes, meRes] = await Promise.all([send('/api/auth/providers', { signal }), send('/api/me', { signal })]);
    if (!providersRes.ok || !isJson(providersRes)) return { status: 'unavailable' };
    const { providers, dev } = (await providersRes.json()) as { providers: ProviderId[]; dev: boolean };
    const user = meRes.ok && isJson(meRes) ? ((await meRes.json()) as { user: Account | null }).user : null;
    return user ? { status: 'signed-in', account: user, providers, dev } : { status: 'signed-out', providers, dev };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Leaves the page for the provider's consent screen; it comes back to the app signed in. */
export function startSignIn(provider: ProviderId): void {
  window.location.assign(`/api/auth/${provider}/start`);
}

/** Local development only: signs in with just a name. */
export async function devSignIn(name: string): Promise<boolean> {
  const res = await send('/api/auth/dev', { method: 'POST', body: JSON.stringify({ name }) });
  return res.ok;
}

export async function signOut(): Promise<void> {
  await send('/api/auth/logout', { method: 'POST', body: '{}' });
}

/** Changes the profile picture to one of AVATARS. Returns the updated account. */
export async function setAvatar(avatar: string): Promise<Account> {
  const res = await send('/api/me/avatar', { method: 'POST', body: JSON.stringify({ avatar }) });
  const body = (await res.json().catch(() => ({}))) as { user?: Account; error?: string };
  if (!res.ok || !body.user) throw new Error(body.error ?? 'Couldn’t change the profile picture. Try again.');
  return body.user;
}

/** Changes the display name (shown in the app and on share links). Returns the updated account. */
export async function setDisplayName(name: string): Promise<Account> {
  const res = await send('/api/me/name', { method: 'POST', body: JSON.stringify({ name }) });
  const body = (await res.json().catch(() => ({}))) as { user?: Account; error?: string };
  if (!res.ok || !body.user) throw new Error(body.error ?? 'Couldn’t change the name. Try again.');
  return body.user;
}

/** Remembers on the account the newest "What's new" item it was shown. */
export async function markNewsSeen(seen: number): Promise<void> {
  await send('/api/me/news', { method: 'POST', body: JSON.stringify({ seen }) });
}

/** Remembers on the account that the welcome tour was seen, so it shows only after the first sign-in. */
export async function markOnboarded(): Promise<void> {
  await send('/api/me/onboarded', { method: 'POST', body: '{}' });
}
