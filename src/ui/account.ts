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
import { avatarUrl, openAvatarPicker } from './avatar-picker.ts';
import { openSharedLink, openSharedLinks, refreshShares } from './share.ts';
import { showWelcome } from './welcome.ts';

const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = { discord: 'Discord', google: 'Google' };
/** The providers' own marks, as their brand guidelines ask for on sign-in buttons (Discord in white on blurple, Google in colour). */
const PROVIDER_LOGO: Readonly<Record<ProviderId, string>> = {
  discord: '<svg class="provider-logo" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.1 14.1 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.332-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.332-.946 2.418-2.157 2.418z"/></svg>',
  google: '<svg class="provider-logo" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">'
    + '<path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>'
    + '<path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>'
    + '<path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>'
    + '<path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>',
};

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
        ${state.account.avatar
          ? `<img class="avatar-img" src="${avatarUrl(state.account.avatar)}" alt="" width="30" height="30">`
          : `<span class="avatar" aria-hidden="true">${esc(initials(state.account.name))}</span>`}
        <span class="who"><span class="nm">${esc(state.account.name)}</span><span class="via" title="${esc(state.account.provider === 'dev' ? 'Local test account' : `Signed in with ${PROVIDER_LABEL[state.account.provider]}`)}" id="save-state">${esc(SAVE_LABEL[store.saveState])}</span></span>
        <span class="more" aria-hidden="true">⋯</span></button>`
    : '<button class="btn block" data-act="sign-in">Sign in</button>';
}

/** Discord / Google buttons (only those the server has credentials for), plus the local test sign-in in development. */
export async function openSignIn(): Promise<void> {
  const state = session.state;
  if (!state || state.status === 'unavailable') return;
  const buttons = state.providers.map((p) => `<button class="btn block provider ${p}" data-act="sign-in-with" data-provider="${p}">${PROVIDER_LOGO[p]}<span>Continue with ${PROVIDER_LABEL[p]}</span></button>`).join('');
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
    await refreshShares();
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
  session.shared = new Map();
  await store.useRepository(device.repo, device.persistent);
  renderAccount();
  requestRender();
  toast('Signed out');
}

export function accountMenu(anchor: HTMLElement): void {
  const count = session.shared.size;
  openMenu(anchor, [
    { label: 'Change profile picture', run: () => void openAvatarPicker(renderAccount) },
    { label: count ? `Shared links (${count})` : 'Shared links', run: () => void openSharedLinks() },
    '-',
    { label: 'Sign out', run: () => void leaveAccount() },
  ]);
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
  // A share link opened while signed out is offered again now.
  await openSharedLink();
}

const SAVE_LABEL: Readonly<Record<AppStore['saveState'], string>> = { saved: 'All changes saved', pending: 'Saving…', saving: 'Saving…', error: 'Not saved' };

/** "Saving… / All changes saved" under the account name while signed in. */
export function renderSaveState(): void {
  const label = qs('#save-state');
  if (!label || session.state?.status !== 'signed-in') return;
  label.textContent = SAVE_LABEL[store.saveState];
  label.classList.toggle('err-text', store.saveState === 'error');
}
