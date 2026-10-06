import { mergeImport } from '../domain/codec.ts';
import { countPlanTurns, oppMons, teamMons } from '../domain/model.ts';
import type { SharedPlan } from '../domain/share.ts';
import type { Plan, Team } from '../domain/types.ts';
import { createShare, listShares, openShare, shareTokenOf, shareUrl, stopSharing } from '../infra/shares.ts';
import { session } from '../state/account.ts';
import { store } from '../state/instance.ts';
import { openSignIn } from './account.ts';
import { requestRender } from './bus.ts';
import { esc, must } from './dom.ts';
import { monIcon } from './icons.ts';
import { formOf } from './names.ts';
import { confirmDialog, modal, toast } from './overlays.ts';

/** A link opened while signed out is kept here through the sign-in redirect, then offered again. */
const PENDING_KEY = 'vgc-planner:pending-share';
const pending = {
  get: (): string | null => { try { return sessionStorage.getItem(PENDING_KEY); } catch { return null; } },
  set: (token: string): void => { try { sessionStorage.setItem(PENDING_KEY, token); } catch { /* best effort */ } },
  clear: (): void => { try { sessionStorage.removeItem(PENDING_KEY); } catch { /* best effort */ } },
};

const message = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

/* ------------------------------ sharing your own ------------------------------ */

/** Share a gameplan: explains what a link reveals, then shows the link with Copy and Stop sharing. */
export async function openShareDialog(planId: string): Promise<void> {
  const state = session.state;
  if (!state || state.status === 'unavailable') { toast('Sharing needs an account, which isn’t available here.', true); return; }
  if (state.status === 'signed-out') {
    const go = await modal<boolean>({
      title: 'Sign in to share', desc: 'Share links live in your account. Sign in, then share this gameplan from here.',
      actions: [{ label: 'Cancel', value: false }, { label: 'Sign in', cls: 'primary', value: true }],
    });
    if (go) await openSignIn();
    return;
  }
  const plan = planById(planId)?.plan;
  if (!plan) return;
  // The link serves what the account has, so send any pending edits first.
  await store.flush();
  if (store.saveState === 'error') { toast('Save your latest changes to your account before sharing.', true); return; }

  let token: string | null;
  try { token = await shareTokenOf(planId); } catch (e) { toast(message(e, 'Couldn’t check the share link.'), true); return; }

  if (!token) {
    const create = await modal<boolean>({
      title: `Share “${plan.name}”`,
      desc: 'Anyone with the link can see this gameplan, all its tabs and your team’s paste, and add a copy to their own gameplans. They can’t change yours. Later edits show through the same link, and you can stop sharing at any time.',
      actions: [{ label: 'Cancel', value: false }, { label: 'Create link', cls: 'primary', value: true }],
    });
    if (!create) return;
    try { token = await createShare(planId); } catch (e) { toast(message(e, 'Couldn’t create the link.'), true); return; }
  }
  markShared(planId, token);

  const url = shareUrl(token);
  const stop = await modal<boolean>({
    title: `Share “${plan.name}”`,
    desc: 'Anyone with this link can view the gameplan and add a copy to their own.',
    body: `<div class="share-link"><input class="field" id="share-url" readonly value="${esc(url)}" aria-label="Share link"></div>`,
    actions: [
      { label: 'Stop sharing', cls: 'danger', value: true },
      {
        label: 'Copy link',
        run: (ov) => {
          must<HTMLInputElement>('#share-url', ov).select();
          void navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => toast('Copy failed. Select the link and copy it manually.', true));
          return false;
        },
      },
      { label: 'Done', cls: 'primary', value: false },
    ],
  });
  if (stop) await stopSharingPlan(planId);
}

/* ------------------------------ managing your links ------------------------------ */

const planById = (planId: string): { team: Team; plan: Plan } | null => {
  for (const team of store.library.teams) {
    const plan = team.plans.find((p) => p.id === planId);
    if (plan) return { team, plan };
  }
  return null;
};

/** Updates which gameplans show as shared (sidebar mark, Shared button). */
function markShared(planId: string, token: string | null): void {
  const had = session.shared.get(planId);
  if (token) session.shared.set(planId, token); else session.shared.delete(planId);
  if (had !== (token ?? undefined)) requestRender();
}

/** Loads which of the account's gameplans are shared. Quietly keeps the last known state if it fails. */
export async function refreshShares(): Promise<void> {
  if (session.state?.status !== 'signed-in') { session.shared = new Map(); return; }
  try { session.shared = await listShares(); } catch { /* the marks are a convenience; sharing still works */ }
}

/**
 * Stops sharing one gameplan, after confirming: everyone who has the link loses access straight away. Sharing
 * again later makes a new link. Resolves true when sharing was stopped.
 */
export async function stopSharingPlan(planId: string): Promise<boolean> {
  const name = planById(planId)?.plan.name ?? 'this gameplan';
  const ok = await confirmDialog(`Stop sharing “${name}”?`, 'The link stops working for everyone who has it. You can share again later; that makes a new link.', 'Stop sharing');
  if (!ok) return false;
  try {
    await stopSharing(planId);
    markShared(planId, null);
    toast('Sharing stopped. The link no longer works.');
    return true;
  } catch (e) {
    toast(message(e, 'Couldn’t stop sharing.'), true);
    return false;
  }
}

export function copyShareLink(planId: string): void {
  const token = session.shared.get(planId);
  if (!token) return;
  void navigator.clipboard.writeText(shareUrl(token)).then(() => toast('Link copied'), () => toast('Copy failed. Open Share to copy it by hand.', true));
}

function sharedListHTML(): string {
  const rows = [...session.shared.keys()].map((planId) => {
    const found = planById(planId);
    if (!found) return '';
    return `<li class="shared-row"><span class="link-mark" aria-hidden="true">${ICON_LINK}</span>
      <span class="who"><span class="nm">${esc(found.plan.name)}</span><span class="sub">${esc(found.team.name)}</span></span>
      <button class="btn sm" data-act="copy-share" data-plan="${esc(planId)}">Copy link</button>
      <button class="btn sm danger" data-act="stop-share" data-plan="${esc(planId)}">Stop sharing</button></li>`;
  }).join('');
  return rows ? `<ul class="shared-list">${rows}</ul>` : '<p class="hint">You aren’t sharing any gameplans. Use Share on a gameplan to create a link.</p>';
}

/** Account menu → Shared links: every gameplan you share, each with Copy link and Stop sharing. */
export async function openSharedLinks(): Promise<void> {
  await refreshShares();
  requestRender();
  await modal<null>({
    title: 'Shared links',
    desc: 'Gameplans anyone with the link can view and copy. Stopping a link takes effect immediately.',
    body: `<div id="shared-links">${sharedListHTML()}</div>`,
    actions: [{ label: 'Done', cls: 'primary', value: null }],
  });
}

/** Called after a row's Stop sharing: redraws the list in the open dialog. */
export function redrawSharedLinks(): void {
  const host = document.querySelector('#shared-links');
  if (host) host.innerHTML = sharedListHTML();
}

/** A small link icon, used to mark shared gameplans. */
export const ICON_LINK = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.1-2.1a3 3 0 0 0-4.2-4.2l-.7.7"/><path d="M9.5 6.5a3 3 0 0 0-4.2 0L3.2 8.6a3 3 0 0 0 4.2 4.2l.7-.7"/></svg>';

/* ------------------------------ opening a link ------------------------------ */

/** Sprites of a team, as they start the battle (base forms). */
const strip = (names: string[]): string => names.slice(0, 6).map((n) => monIcon(formOf(null, 'me', n), 'sm')).join('');

function previewHTML(shared: SharedPlan): string {
  const team = shared.parsed.teams[0]!;
  const plan = team.plans[0]!;
  const tabs = plan.tabs.length;
  const turns = countPlanTurns(plan);
  return `<div class="share-preview">
    <div class="sp-row"><span class="sp-who">${esc(team.name)}</span><span class="sp-icons">${strip(teamMons(team).map((m) => m.species))}</span></div>
    <div class="sp-vs">vs</div>
    <div class="sp-row"><span class="sp-who">${esc(plan.opponent.name || 'Opponent')}</span><span class="sp-icons">${strip(oppMons(plan).map((m) => m.species))}</span></div>
    <div class="sp-meta"><b>${esc(plan.name)}</b> · ${tabs} tab${tabs === 1 ? '' : 's'} · ${turns} turn${turns === 1 ? '' : 's'}</div></div>`;
}

/**
 * Adds the shared gameplan to the current library. It joins the viewer's team of the same name only when that team
 * has the same paste; otherwise it gets its own team ("Name (from Owner)"), since the plan depends on that team.
 */
function addShared(shared: SharedPlan): void {
  const incoming: Team = shared.parsed.teams[0]!;
  const sameName = (t: Team): boolean => t.name.trim().toLowerCase() === incoming.name.trim().toLowerCase();
  const existing = store.library.teams.find(sameName);
  if (existing && existing.paste.trim() !== incoming.paste.trim()) {
    const base = `${incoming.name} (from ${shared.owner})`;
    let name = base;
    for (let n = 2; store.library.teams.some((t) => t.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} ${n}`;
    incoming.name = name;
  }
  const summary = mergeImport(store.library, shared.parsed);
  if (summary.focus) {
    Object.assign(store.ui, { teamId: summary.focus.teamId, planId: summary.focus.planId, tabId: null, selectedNode: null, scrollX: 0, scrollY: 0 });
    store.ui.open[summary.focus.teamId] = true;
  }
  store.persist();
  requestRender();
  toast(`Added “${incoming.plans[0]!.name}” to your gameplans`);
}

/**
 * Handles `?share=<token>` (or a link remembered through sign-in): the owner just gets their gameplan opened; anyone
 * else is offered to add a copy (to their account, or to this device when signed out).
 */
export async function openSharedLink(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  let token = params.get('share');
  if (token) {
    params.delete('share');
    const query = params.toString();
    history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  } else token = pending.get();
  pending.clear();
  if (!token) return;

  const state = session.state;
  if (!state || state.status === 'unavailable') { toast('Shared gameplans can’t be opened here: the app’s server isn’t available.', true); return; }

  let shared: SharedPlan;
  try { shared = await openShare(token); } catch (e) { toast(message(e, 'Couldn’t open this link.'), true); return; }

  if (shared.isOwner) {
    const team = store.library.teams.find((t) => t.plans.some((p) => p.id === shared.planId));
    if (team) {
      Object.assign(store.ui, { teamId: team.id, planId: shared.planId, tabId: null, selectedNode: null });
      store.ui.open[team.id] = true;
      requestRender();
    }
    toast('This is your own gameplan');
    return;
  }

  const signedIn = state.status === 'signed-in';
  const choice = await modal<'add' | 'sign-in'>({
    title: `${shared.owner} shared a gameplan with you`,
    desc: signedIn
      ? 'Add a copy to your gameplans? It’s yours to change; the original stays with its owner.'
      : 'Sign in to add a copy to your account, or keep it on this device. It’s yours to change; the original stays with its owner.',
    body: previewHTML(shared),
    actions: signedIn
      ? [{ label: 'Not now', value: null }, { label: 'Add to my gameplans', cls: 'primary', value: 'add' }]
      : [{ label: 'Not now', value: null }, { label: 'Save on this device', value: 'add' }, { label: 'Sign in to add it', cls: 'primary', value: 'sign-in' }],
  });
  if (choice === 'add') addShared(shared);
  else if (choice === 'sign-in') { pending.set(token); await openSignIn(); }
}
