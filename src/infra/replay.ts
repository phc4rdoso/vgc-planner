/**
 * Replay links and fetching. Showdown serves every replay (private ones too, with their "…pw" id) as JSON and allows
 * cross-origin reads, so the browser reads it directly: no cookies sent, nothing through our server.
 */
export interface ReplayLink { id: string; url: string; json: string }

/**
 * Recognises a Pokémon Showdown replay link: replay.pokemonshowdown.com/<id>, with or without https://, a trailing
 * .json / .log, a query (?p2) or a fragment. Null for anything else.
 */
export function parseReplayLink(text: string): ReplayLink | null {
  const raw = text.trim();
  if (!raw || /\s/.test(raw) || raw.length > 300) return null;
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (url.hostname.toLowerCase() !== 'replay.pokemonshowdown.com') return null;
  const id = url.pathname.replace(/^\//, '').replace(/\.(json|log)$/i, '');
  if (!/^[a-z0-9]+-\d+(-[a-z0-9]+pw)?$/i.test(id)) return null;
  return { id, url: `https://replay.pokemonshowdown.com/${id}`, json: `https://replay.pokemonshowdown.com/${id}.json` };
}

/** Downloads a replay's battle log. */
export async function fetchReplayLog(link: ReplayLink, fetchFn: typeof fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(link.json, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error('Couldn’t reach Pokémon Showdown. Check your connection and try again.');
  }
  if (res.status === 404) throw new Error('There’s no replay at that link (a private replay needs its full link, ending in “pw”).');
  if (!res.ok) throw new Error(`Pokémon Showdown answered with an error (${res.status}). Try again later.`);
  const data = (await res.json().catch(() => null)) as { log?: unknown } | null;
  if (!data || typeof data.log !== 'string' || !data.log) throw new Error('That replay has no battle log.');
  if (data.log.length > 2_000_000) throw new Error('That replay is too long to import.');
  return data.log;
}
