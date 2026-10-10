/**
 * Which "What's new" items to show (the box itself is ui/news.ts). Each device remembers the id of the latest item it
 * has shown, so an item is shown once, signed in or not.
 */

/**
 * `seenRaw`: what this device remembered (null: nothing yet). `visitor`: "returning" for someone who used the app
 * before, so they get the news even if this device never showed any; "new" for a first visit or a first sign-in, for
 * whom everything so far counts as seen. Returns the ids to show, newest first (at most `max`), and what to remember.
 */
export function newsToShow(ids: readonly number[], seenRaw: string | null, visitor: 'new' | 'returning', max = 5): { show: number[]; remember: number } {
  const latest = Math.max(0, ...ids);
  const seen = seenRaw === null ? (visitor === 'new' ? latest : 0) : Number(seenRaw) || 0;
  return { show: ids.filter((id) => id > seen).slice(-max).reverse(), remember: Math.max(seen, latest) };
}
