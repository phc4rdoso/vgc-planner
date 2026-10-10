/**
 * "What's new": a box like the welcome tour that shows the features added since the visitor's last time here, newest
 * first, each with a small animation of how it works. Who sees what: state/news.ts.
 */
import { deviceFlags } from '../state/instance.ts';
import { session } from '../state/account.ts';
import { newsToShow, readSeen } from '../state/news.ts';
import { markNewsSeen } from '../infra/auth.ts';
import { showTour, type Step } from './welcome.ts';
import { NEWS_PREVIEWS } from './welcome-previews.ts';

/** `id`: increasing with each item (never reused); `date`: when it went live (YYYY-MM-DD). */
interface NewsItem extends Omit<Step, 'badge'> { id: number; date: string }

const svg = (path: string): string =>
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

/** Add new features at the end, with the next id. */
const NEWS: readonly NewsItem[] = [
  {
    id: 1,
    date: '2026-10-10',
    icon: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"/>'),
    preview: NEWS_PREVIEWS.copyTurn,
    title: 'Copy a turn',
    text: 'Press the copy button at the top of a turn card to get a copy right beside it, with the same moves and choices. Handy for planning a small variation, like the opponent targeting someone else.',
  },
];

/** At most this many items at once (someone back after a long time sees only the latest). */
const MAX_SHOWN = 5;
/** Where a signed-out visitor's news is remembered on this device. */
const SEEN_KEY = 'news-seen';

const formatDate = (date: string): string =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Shows what's new since this person last saw the news, then remembers it: on the account when signed in (so each
 * person sharing a device gets it), on this device when signed out. `who`: what greetAccount found; `hasLibrary`:
 * whether there are gameplans here (someone signed out who used the app before).
 */
export async function showNews(who: 'signed-out' | 'signed-in' | 'welcomed', hasLibrary: boolean): Promise<void> {
  const account = session.state?.status === 'signed-in' ? session.state.account : null;
  const visitor = who === 'welcomed' ? 'new' : account || hasLibrary ? 'returning' : 'new';
  const seen = account ? account.newsSeen : readSeen(deviceFlags.read(SEEN_KEY));
  const { show, remember } = newsToShow(NEWS.map((n) => n.id), seen, visitor, MAX_SHOWN);
  // Remembered before showing, so leaving the page halfway through doesn't bring it back.
  if (remember !== seen) {
    if (account) {
      account.newsSeen = remember;
      void markNewsSeen(remember).catch(() => undefined);
    } else {
      deviceFlags.write(SEEN_KEY, String(remember));
    }
  }
  const fresh = show.flatMap((id) => NEWS.filter((n) => n.id === id));
  if (!fresh.length) return;
  const steps: Step[] = fresh.map((n) => ({ icon: n.icon, preview: n.preview, title: n.title, text: n.text, badge: `New · ${formatDate(n.date)}` }));
  await showTour(steps, { start: 'Next', finish: 'Got it', skip: 'Close' });
}
