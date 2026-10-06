import './styles/index.css';
import { store } from './state/instance.ts';
import { connectAccount, greetAccount, renderSaveState } from './ui/account.ts';
import { render } from './ui/app.ts';
import { openSharedLink } from './ui/share.ts';
import { installEvents, reportError } from './ui/events.ts';
import { installIconFallbacks } from './ui/icons.ts';
import { toast } from './ui/overlays.ts';
import { installPasteLinks } from './ui/paste-links.ts';

async function main(): Promise<void> {
  installIconFallbacks();
  installEvents();
  installPasteLinks();
  window.addEventListener('error', (e) => reportError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));

  store.onError = (message) => toast(message, true);
  store.onSaveState = () => renderSaveState();
  await store.init();
  if (store.loadError) toast(store.loadError, true);
  // Accounts are optional: without the API (or signed out) the app keeps working on this device only. When signed
  // in, the account's library replaces this device's before anything is drawn.
  await connectAccount();
  render();
  // First the welcome (first sign-in), then any share link the page was opened with.
  void greetAccount().then(() => openSharedLink());

  // Make sure the last edits are written when the tab is hidden or closed.
  const flush = (): void => { void store.flush(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

void main();
