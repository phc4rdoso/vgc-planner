import { buildExport, mergeImport, readExport } from '../domain/codec.ts';
import { AccountRepository } from '../infra/account-repository.ts';
import type { ProviderId } from '../infra/auth.ts';
import { devSignIn, loadAccount, markOnboarded, signOut, startSignIn } from '../infra/auth.ts';
import { session } from '../state/account.ts';
import { device, deviceFlags, store } from '../state/instance.ts';
import type { AppStore } from '../state/store.ts';
import { requestRender } from './bus.ts';
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
        <span class="who"><span class="nm">${esc(state.account.name)}</span><span class="via" title="${esc(state.account.provider === 'dev' ? 'Local test account' : `Signed in with ${PROVIDER_LABEL[state.account.provider]}`)}" id="save-state">${esc(SAVE_LABEL[store.saveState])}</span></span>
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

/**
 * Finds out who is signed in and, if someone is, makes the account's library the one the app shows and saves to.
 * Runs before the first render so a signed-in user never sees this device's library flash by.
 */
export async function connectAccount(): Promise<void> {
  handleReturn();
  session.state = await loadAccount();
  if (session.state.status === 'signed-in') {
    await store.useRepository(new AccountRepository());
    if (store.loadError) toast(store.loadError, true);
  }
  renderAccount();
}

/** After the screen is drawn: the welcome tour on a first sign-in, then the offer to bring this device's gameplans. */
export async function greetAccount(): Promise<void> {
  const state = session.state;
  if (state?.status !== 'signed-in') return;
  if (!state.account.onboarded) {
    await showWelcome(state.account.name);
    state.account.onboarded = true;
    await markOnboarded().catch(() => undefined);
  }
  await offerDeviceUpload(state.account.id);
}

/**
 * If this device has gameplans saved while signed out, offers once (per account and device) to add them to the
 * account. They are merged like an import: teams with the same name receive the gameplans, everything gets new ids.
 */
async function offerDeviceUpload(accountId: string): Promise<void> {
  const flag = `offered-upload:${accountId}`;
  if (deviceFlags.get(flag) || store.loadError) return;
  const local = await device.repo.load().catch(() => null);
  const plans = local?.teams.reduce((n, t) => n + t.plans.length, 0) ?? 0;
  if (!local || !local.teams.length) return;
  const t = local.teams.length;
  const add = await modal<boolean>({
    title: 'Add this device’s gameplans to your account?',
    desc: `This browser has ${t} team${t === 1 ? '' : 's'} and ${plans} gameplan${plans === 1 ? '' : 's'} saved while you were signed out. Add them to your account so they’re available wherever you sign in. Teams with the same name are merged.`,
    actions: [{ label: 'Not now', value: false }, { label: 'Add to account', cls: 'primary', value: true }],
  });
  deviceFlags.set(flag);
  if (!add) return;
  const summary = mergeImport(store.library, readExport(JSON.parse(JSON.stringify(buildExport(local, { type: 'all' })))));
  store.persist();
  await store.flush();
  requestRender();
  toast(`Added ${summary.plans} gameplan${summary.plans === 1 ? '' : 's'} to your account`);
}

/** Sign out: back to this device's library (what was saved here while signed out is still there). */
async function leaveAccount(): Promise<void> {
  await store.flush();
  await signOut().catch(() => undefined);
  session.state = await loadAccount();
  await store.useRepository(device.repo, device.persistent);
  renderAccount();
  requestRender();
  toast('Signed out');
}

export function accountMenu(anchor: HTMLElement): void {
  openMenu(anchor, [{ label: 'Sign out', run: () => void leaveAccount() }]);
}

export function signInWith(provider: string): void {
  if (provider === 'discord' || provider === 'google') startSignIn(provider);
}

/** The local test sign-in (development only). */
async function signInDev(name: string): Promise<void> {
  if (!await devSignIn(name)) { toast('Sign-in didn’t complete. Try again.', true); return; }
  await connectAccount();
  requestRender();
  await greetAccount();
}

const SAVE_LABEL: Readonly<Record<AppStore['saveState'], string>> = { saved: 'All changes saved', pending: 'Saving…', saving: 'Saving…', error: 'Not saved' };

/** "Saving… / All changes saved" under the account name while signed in. */
export function renderSaveState(): void {
  const label = qs('#save-state');
  if (!label || session.state?.status !== 'signed-in') return;
  label.textContent = SAVE_LABEL[store.saveState];
  label.classList.toggle('err-text', store.saveState === 'error');
}
