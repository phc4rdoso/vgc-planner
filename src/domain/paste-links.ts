/**
 * Team links from paste sites: recognising them, and turning what the sites return into a Showdown paste.
 * Fetching lives in infra/paste-links.ts.
 */

export type PasteSite = 'pokepaste' | 'vrpastes';

export interface PasteLink {
  site: PasteSite;
  id: string;
  /** Where the team data is fetched from (both sites allow cross-origin reads). */
  api: string;
}

export const PASTE_SITE_LABEL: Readonly<Record<PasteSite, string>> = { pokepaste: 'pokepast.es', vrpastes: 'VR Pastes' };

/** The API origins the browser fetches from; listed in the Content-Security-Policy's connect-src. */
export const PASTE_API_ORIGINS = ['https://pokepast.es', 'https://vrpaste-backend.vercel.app'] as const;

/**
 * Recognises a pokepast.es or vrpastes.com link (with or without https://, www., a trailing /raw or /json, a query or
 * a fragment). Returns null for anything else, including text that merely contains a link.
 */
export function parsePasteLink(text: string): PasteLink | null {
  const raw = text.trim();
  if (!raw || /\s/.test(raw) || raw.length > 200) return null;
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  const id = parts[0] ?? '';
  if (host === 'pokepast.es' && /^[0-9a-f]{8,32}$/i.test(id) && (parts.length === 1 || (parts.length === 2 && ['raw', 'json'].includes(parts[1]!)))) {
    return { site: 'pokepaste', id, api: `https://pokepast.es/${id}/json` };
  }
  if (host === 'vrpastes.com' && /^[A-Za-z0-9_-]{4,32}$/.test(id) && parts.length === 1) {
    return { site: 'vrpastes', id, api: `https://vrpaste-backend.vercel.app/api/paste/${encodeURIComponent(id)}?lang=english` };
  }
  return null;
}

export interface FetchedPaste { paste: string; title: string }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const MAX_PASTE = 20_000;
/** Both sites fill in "Untitled …" when the author gave no title; that isn't worth keeping as a team name. */
const realTitle = (v: unknown): string => (/^untitled\b/i.test(str(v)) ? '' : str(v));

/** pokepast.es `/<id>/json`: `{ title, author, notes, paste }`. */
export function readPokepaste(data: unknown): FetchedPaste {
  const d = (data ?? {}) as Record<string, unknown>;
  const paste = str(d.paste).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n');
  if (!paste) throw new Error('That pokepast.es link has no team in it.');
  return { paste: paste.slice(0, MAX_PASTE), title: realTitle(d.title) };
}

const EV_LABEL: ReadonlyArray<[string, string]> = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];
const spread = (v: unknown, label: string): string => {
  if (!v || typeof v !== 'object') return '';
  const o = v as Record<string, unknown>;
  const parts = EV_LABEL.filter(([k]) => typeof o[k] === 'number' && Number.isFinite(o[k])).map(([k, l]) => `${Math.round(o[k] as number)} ${l}`);
  return parts.length ? `${label}: ${parts.join(' / ')}` : '';
};

/** One vrpastes set (`{ name, species, item, ability, nature, evs, ivs, moves, ... }`) as Showdown text. */
function vrSet(m: Record<string, unknown>): string {
  const species = str(m.species) || str(m.name);
  if (!species) return '';
  const nick = str(m.name);
  const gender = str(m.gender).toUpperCase();
  let first = nick && nick !== species ? `${nick} (${species})` : species;
  if (gender === 'M' || gender === 'F') first += ` (${gender})`;
  if (str(m.item)) first += ` @ ${str(m.item)}`;
  const lines = [first];
  if (str(m.ability)) lines.push(`Ability: ${str(m.ability)}`);
  if (typeof m.level === 'number' && m.level !== 100) lines.push(`Level: ${Math.round(m.level)}`);
  if (str(m.teraType)) lines.push(`Tera Type: ${str(m.teraType)}`);
  const evs = spread(m.evs, 'EVs');
  if (evs) lines.push(evs);
  if (str(m.nature)) lines.push(`${str(m.nature)} Nature`);
  const ivs = spread(m.ivs, 'IVs');
  if (ivs) lines.push(ivs);
  for (const move of Array.isArray(m.moves) ? m.moves : []) if (str(move)) lines.push(`- ${str(move)}`);
  return lines.join('\n');
}

/** vrpastes `/api/paste/<id>`: `{ title, is_encrypted, teams: [set, ...] }`. */
export function readVrPaste(data: unknown): FetchedPaste {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.is_encrypted === true) throw new Error('That VR Pastes team is password-protected. Copy its text instead.');
  const sets = (Array.isArray(d.teams) ? d.teams : []).slice(0, 24)
    .map((m) => (m && typeof m === 'object' ? vrSet(m as Record<string, unknown>) : '')).filter(Boolean);
  if (!sets.length) throw new Error('That VR Pastes link has no team in it.');
  return { paste: sets.join('\n\n').slice(0, MAX_PASTE), title: realTitle(d.title) };
}
