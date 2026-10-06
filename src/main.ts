import './styles/index.css';
import { store } from './state/instance.ts';
import { initAccount } from './ui/account.ts';
import { render } from './ui/app.ts';
import { installEvents, reportError } from './ui/events.ts';
import { installIconFallbacks } from './ui/icons.ts';
import { toast } from './ui/overlays.ts';

async function main(): Promise<void> {
  installIconFallbacks();
  installEvents();
  window.addEventListener('error', (e) => reportError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));

  store.onError = (message) => toast(message, true);
  await store.init();
  render();
  if (store.loadError) toast(store.loadError, true);
  // Accounts are optional: without the API the app keeps working on this device only.
  void initAccount();

  // Make sure the last edits are written when the tab is hidden or closed.
  const flush = (): void => { void store.flush(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

void main();
