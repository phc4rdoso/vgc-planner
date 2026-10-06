import type { FetchedPaste, PasteLink } from '../domain/paste-links.ts';
import { PASTE_SITE_LABEL, readPokepaste, readVrPaste } from '../domain/paste-links.ts';

/** Downloads the team behind a paste link, straight from the site (no cookies sent, nothing goes through our server). */
export async function fetchPasteLink(link: PasteLink, fetchFn: typeof fetch = fetch): Promise<FetchedPaste> {
  const site = PASTE_SITE_LABEL[link.site];
  let res: Response;
  try {
    res = await fetchFn(link.api, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error(`Couldn't reach ${site}. Check your connection and try again.`);
  }
  if (res.status === 404) throw new Error(`${site} has no team at that link.`);
  if (!res.ok) throw new Error(`${site} answered with an error (${res.status}). Try again later.`);
  let data: unknown;
  try { data = await res.json(); } catch { throw new Error(`${site} sent something that isn't a team.`); }
  return link.site === 'pokepaste' ? readPokepaste(data) : readVrPaste(data);
}
