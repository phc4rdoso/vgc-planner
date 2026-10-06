import { mergeImport } from '../domain/codec.ts';
import { countPlanTurns, findPlan, oppMons, teamMons } from '../domain/model.ts';
import type { SharedPlan } from '../domain/share.ts';
import type { Team } from '../domain/types.ts';
import { createShare, openShare, shareTokenOf, shareUrl, stopSharing } from '../infra/shares.ts';
import { session } from '../state/account.ts';
import { store } from '../state/instance.ts';
import { openSignIn } from './account.ts';
import { requestRender } from './bus.ts';
import { esc, must } from './dom.ts';
import { monIcon } from './icons.ts';
import { formOf } from './names.ts';
import { modal, toast } from './overlays.ts';

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
  const plan = findPlan(store.team, planId) ?? store.library.teams.flatMap((t) => t.plans).find((p) => p.id === planId);
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
  if (!stop) return;
  try { await stopSharing(planId); toast('Sharing stopped. The link no longer works.'); } catch (e) { toast(message(e, 'Couldn’t stop sharing.'), true); }
}

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
