/**
 * The "What's new" items and which of them to show (the box, with each item's icon and animation, is ui/news.ts).
 * What was shown is remembered per person: on the account when signed in, on this device when signed out. The server
 * uses {@link LATEST_NEWS_ID} so a new account starts with everything so far already seen.
 */

/** `id`: increasing with each item, never reused; `date`: when it went live (YYYY-MM-DD). Add new ones at the end. */
export const NEWS = [
  {
    id: 1,
    date: '2026-10-10',
    title: 'Copy a turn',
    text: 'Press the copy button at the top of a turn card to get a copy right beside it, with the same moves and choices. Handy for planning a small variation, like the opponent targeting someone else.',
  },
] as const satisfies readonly { id: number; date: string; title: string; text: string }[];

export type NewsId = (typeof NEWS)[number]['id'];

/** The newest item: what a brand-new account has already "seen". */
export const LATEST_NEWS_ID: number = Math.max(0, ...NEWS.map((n) => n.id));

/**
 * `seen`: the newest item already shown (null: nothing remembered yet). `visitor`: "returning" for someone who used
 * the app before, so they get the news even if none was remembered; "new" for a first visit or a first sign-in, for
 * whom everything so far counts as seen. Returns the ids to show, newest first (at most `max`), and what to remember.
 */
export function newsToShow(ids: readonly number[], seen: number | null, visitor: 'new' | 'returning', max = 5): { show: number[]; remember: number } {
  const latest = Math.max(0, ...ids);
  const from = seen ?? (visitor === 'new' ? latest : 0);
  return { show: ids.filter((id) => id > from).slice(-max).reverse(), remember: Math.max(from, latest) };
}

/** A value kept in the browser's storage: null when there is none, 0 when it isn't a number. */
export const readSeen = (raw: string | null): number | null => (raw === null ? null : Math.max(0, Math.floor(Number(raw))) || 0);
