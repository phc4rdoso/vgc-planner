/**
 * Which "What's new" items to show (the box itself is ui/news.ts). What was shown is remembered per person: on the
 * account when signed in, on this device when signed out.
 */

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
