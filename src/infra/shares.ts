/** Share links (server/src/shares.ts). Creating and stopping a link needs a session; opening one doesn't. */
import { readSharedPlan } from '../domain/share.ts';
import type { SharedPlan } from '../domain/share.ts';

const send = (path: string, method = 'GET'): Promise<Response> =>
  fetch(path, { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) }, body: method === 'GET' ? undefined : '{}' });

async function errorOf(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => ({})) as { error?: unknown };
  return new Error(typeof body.error === 'string' && res.status < 500 ? body.error : fallback);
}

/** The address someone opens to see the shared gameplan. */
export const shareUrl = (token: string): string => `${window.location.origin}/?share=${encodeURIComponent(token)}`;

/** The current link token for one of your gameplans, or null when it isn't shared. */
export async function shareTokenOf(planId: string): Promise<string | null> {
  const res = await send(`/api/plans/${encodeURIComponent(planId)}/share`);
  if (!res.ok) throw await errorOf(res, 'Couldn’t check the share link.');
  return ((await res.json()) as { token: string | null }).token;
}

export async function createShare(planId: string): Promise<string> {
  const res = await send(`/api/plans/${encodeURIComponent(planId)}/share`, 'POST');
  if (!res.ok) throw await errorOf(res, 'Couldn’t create the link. Try again.');
  return ((await res.json()) as { token: string }).token;
}

export async function stopSharing(planId: string): Promise<void> {
  const res = await send(`/api/plans/${encodeURIComponent(planId)}/share`, 'DELETE');
  if (!res.ok) throw await errorOf(res, 'Couldn’t stop sharing. Try again.');
}

/** Opens a link: the shared gameplan, validated. Throws with a readable message when the link doesn't work. */
export async function openShare(token: string): Promise<SharedPlan> {
  const res = await send(`/api/shares/${encodeURIComponent(token)}`);
  if (!res.ok) throw await errorOf(res, 'Couldn’t open this link. Try again later.');
  return readSharedPlan(await res.json());
}

/** Every gameplan you share, as gameplan id -> link token. */
export async function listShares(): Promise<Map<string, string>> {
  const res = await send('/api/shares');
  if (!res.ok) throw await errorOf(res, 'Couldn\u2019t load your share links.');
  const { shares } = (await res.json()) as { shares: { planId: string; token: string }[] };
  return new Map(shares.map((s) => [s.planId, s.token]));
}
