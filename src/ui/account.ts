import type { ProviderId } from '../infra/auth.ts';
import { devSignIn, loadAccount, markOnboarded, signOut, startSignIn } from '../infra/auth.ts';
import { session } from '../state/account.ts';
import { esc, must, qs } from './dom.ts';
import { modal, openMenu, toast } from './overlays.ts';
import { showWelcome } from './welcome.ts';

const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = { discord: 'Discord', google: 'Google' };

const initials = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase()).join('') || '?';

/** The account row at the bottom of the sidebar. Hidden when the app runs without the API. */
export function renderAccount(): void {
  const host = qs('#account');
  if (!host) return;
  const state = session.state;
  if (!state || state.status === 'unavailable') { host.innerHTML = ''; host.hidden = true; return; }
  host.hidden = false;
  host.innerHTML = state.status === 'signed-in'
    ? `<button class="account-btn" data-act="account-menu" aria-label="Account: ${esc(state.account.name)}">
        <span class="avatar" aria-hidden="true">${esc(initials(state.account.name))}</span>
        <span class="who"><span class="nm">${esc(state.account.name)}</span><span class="via">${esc(state.account.provider === 'dev' ? 'Local test account' : `Signed in with ${PROVIDER_LABEL[state.account.provider]}`)}</span></span>
        <span class="more" aria-hidden="true">⋯</span></button>`
    : '<button class="btn block" data-act="sign-in">Sign in</button>';
}

/** Discord / Google buttons (only those the server has credentials for), plus the local test sign-in in development. */
export async function openSignIn(): Promise<void> {
  const state = session.state;
  if (!state || state.status === 'unavailable') return;
  const buttons = state.providers.map((p) => `<button class="btn block provider ${p}" data-act="sign-in-with" data-provider="${p}">Continue with ${PROVIDER_LABEL[p]}</button>`).join('');
  const dev = state.dev
    ? `<div class="dev-sign-in"><label class="lbl" for="dev-name">Local test account (development only)</label>
        <input class="field" id="dev-name" placeholder="Any name" maxlength="64"><div class="hint err-text" id="dev-err" role="alert"></div></div>`
    : '';
  const empty = !buttons && !dev ? '<p class="hint">Sign-in isn’t set up on this server yet.</p>' : '';
  const name = await modal<string>({
    title: 'Sign in',
    desc: 'Use your Discord or Google account. The first sign-in creates your account; no password needed.',
    body: `<div class="sign-in">${buttons}${dev}${empty}</div>`,
    actions: [
      { label: 'Close', value: null },
      ...(state.dev ? [{
        label: 'Sign in as test user',
        run: (ov: HTMLElement): string | false => {
          const value = must<HTMLInputElement>('#dev-name', ov).value.trim();
          if (value) return value;
          must('#dev-err', ov).textContent = 'Enter a name first';
          return false;
        },
      }] : []),
    ],
  });
  if (name) await signInDev(name);
}

/** After a provider sends the user back: report a failed or cancelled sign-in, and tidy the address bar. */
function handleReturn(): void {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('login');
  if (!outcome) return;
  if (outcome === 'error') toast('Sign-in didn’t complete. Try again.', true);
  else if (outcome === 'cancelled') toast('Sign-in cancelled');
  params.delete('login');
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

/** Loads the account on startup and, right after a first sign-in, shows the welcome tour once. */
export async function initAccount(): Promise<void> {
  handleReturn();
  session.state = await loadAccount();
  renderAccount();
  const state = session.state;
  if (state.status === 'signed-in' && !state.account.onboarded) {
    await showWelcome(state.account.name);
    state.account.onboarded = true;
    await markOnboarded().catch(() => undefined);
  }
}

export function accountMenu(anchor: HTMLElement): void {
  openMenu(anchor, [{
    label: 'Sign out',
    run: () => {
      void signOut().finally(async () => {
        session.state = await loadAccount();
        renderAccount();
        toast('Signed out');
      });
    },
  }]);
}

export function signInWith(provider: string): void {
  if (provider === 'discord' || provider === 'google') startSignIn(provider);
}

/** The local test sign-in (development only). */
async function signInDev(name: string): Promise<void> {
  if (!await devSignIn(name)) { toast('Sign-in didn’t complete. Try again.', true); return; }
  await initAccount();
}
