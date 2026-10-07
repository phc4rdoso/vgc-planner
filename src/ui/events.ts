import { config } from '../config.ts';
import { DataError } from '../domain/codec.ts';
import type { ActionKind, Side, SlotKind } from '../domain/types.ts';
import { simService, store } from '../state/instance.ts';
import { addNode, addTab, selectTab, startRenameTab, tabMenu, createPlan, createTeam, deleteNode, deletePlan, deleteTeam, duplicatePlan, editPaste, loadImportFile, pickSlot, renameTeam, showExport, showImport } from './actions.ts';
import { accountMenu, openSignIn, signInWith } from './account.ts';
import { openPalettePicker } from './theme.ts';
import { requestRender } from './bus.ts';
import { copyShareLink, openShareDialog, redrawSharedLinks, stopSharingPlan } from './share.ts';
import { session } from '../state/account.ts';
import { qs } from './dom.ts';
import { setOutcome } from './outcome-edit.ts';
import { openReplayImport } from './replay-import.ts';
import { openMenu, toast } from './overlays.ts';
import { isPivotMove, renderDrawer } from './views/drawer.ts';
import { rerenderCanvas, setZoom } from './views/plan-view.ts';
import { applyNavCollapsed, renderNav } from './views/sidebar.ts';

const asSide = (v: string | undefined): Side => (v === 'opp' ? 'opp' : 'me');
const asSlot = (v: string | undefined): SlotKind => (v === 'back' ? 'back' : 'lead');
const asKind = (v: string): ActionKind => (v === 'switch' || v === 'mega' ? v : 'move');

export function reportError(error: unknown): void {
  console.error(error);
  toast(error instanceof DataError ? error.message : 'Something went wrong. Your data is still saved; try again or reload the page.', true);
}

function selectTeam(teamId: string, planId: string | null): void {
  Object.assign(store.ui, { teamId, planId, tabId: null, selectedNode: null });
  store.ui.open[teamId] = true;
  store.persist();
  requestRender();
}

async function handleClick(el: HTMLElement, e: MouseEvent): Promise<void> {
  const d = el.dataset;
  const team = d.team ?? '';
  const plan = d.plan ?? '';
  switch (d.act) {
    case 'new-team': return createTeam();
    case 'import': if (el.tagName === 'A') e.preventDefault(); return showImport();
    case 'export-all':
      if (store.library.teams.length) return showExport({ type: 'all' });
      toast('Nothing to export yet', true);
      return;
    case 'sign-in': return openSignIn();
    case 'sign-in-with': signInWith(d.provider ?? ''); return;
    case 'account-menu': e.stopPropagation(); accountMenu(el); return;
    case 'theme': return openPalettePicker();
    case 'toggle-nav':
      store.ui.navCollapsed = !store.ui.navCollapsed;
      store.persist();
      applyNavCollapsed();
      return;
    case 'toggle-team':
      e.stopPropagation();
      store.ui.open[team] = !store.ui.open[team];
      store.persist();
      renderNav();
      return;
    case 'open-team': selectTeam(team, null); return;
    case 'open-plan':
      e.stopPropagation();
      Object.assign(store.ui, { scrollX: 0, scrollY: 0 });
      selectTeam(team, plan);
      return;
    case 'team-menu':
      e.stopPropagation();
      openMenu(el, [
        { label: 'Rename', run: () => void renameTeam(team) },
        { label: 'New gameplan', run: () => void createPlan(team) },
        { label: 'Export team', run: () => void showExport({ type: 'team', teamId: team }) },
        '-',
        { label: 'Delete', cls: 'danger', run: () => void deleteTeam(team) },
      ]);
      return;
    case 'plan-menu':
      e.stopPropagation();
      openMenu(el, [
        { label: 'Duplicate', run: () => duplicatePlan(team, plan) },
        ...(session.shared.has(plan)
          ? [{ label: 'Copy share link', run: () => copyShareLink(plan) }, { label: 'Stop sharing', run: () => void stopSharingPlan(plan) }]
          : [{ label: 'Share link', run: () => void openShareDialog(plan) }]),
        { label: 'Export gameplan', run: () => void showExport({ type: 'plan', teamId: team, planId: plan }) },
        '-',
        { label: 'Delete', cls: 'danger', run: () => void deletePlan(team, plan) },
      ]);
      return;
    case 'new-plan': e.stopPropagation(); return createPlan(team);
    case 'share-plan': return openShareDialog(plan);
    case 'replay-import': return openReplayImport();
    case 'copy-share': copyShareLink(plan); return;
    case 'stop-share': if (await stopSharingPlan(plan)) redrawSharedLinks(); return;
    case 'export-team': return showExport({ type: 'team', teamId: team });
    case 'delete-team': return deleteTeam(team);
    case 'export-plan': return showExport({ type: 'plan', teamId: team, planId: plan });
    case 'edit-paste': return editPaste(asSide(d.kind));
    case 'zoom': setZoom(store.ui.zoom + Number(d.d ?? 0) * config.zoom.step); return;
    case 'pick-slot': pickSlot(el, asSide(d.side), asSlot(d.kind), Number(d.i ?? 0)); return;
    case 'toggle-result': {
      e.stopPropagation();
      const id = d.node ?? '';
      store.ui.expanded[id] = !store.ui.expanded[id];
      rerenderCanvas();
      return;
    }
    case 'select-node':
      store.ui.selectedNode = d.node ?? null;
      rerenderCanvas();
      renderDrawer();
      return;
    case 'close-drawer':
      store.ui.selectedNode = null;
      qs('#drawer')?.classList.add('hidden');
      rerenderCanvas();
      return;
    case 'select-tab':
      if (e.target instanceof HTMLInputElement) return; // clicking inside the rename box
      selectTab(d.tab ?? '');
      return;
    case 'add-tab': addTab(); return;
    case 'tab-menu': e.stopPropagation(); tabMenu(el, d.tab ?? ''); return;
    case 'add-node': addNode(d.parent || null); return;
    case 'add-branch-child': addNode(store.ui.selectedNode); return;
    case 'delete-node': return deleteNode();
  }
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const isField = (t: EventTarget | null): t is Field => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;

/** Editor fields write straight into the store as you type (no full redraw, so focus stays). */
function onInput(e: Event): void {
  const t = e.target;
  if (!isField(t) || !t.closest('#drawer')) return;
  const found = store.currentNode();
  if (!found) return;
  const f = t.dataset.f;
  const a = t.dataset.a;
  if (f === 'title' || f === 'condition' || f === 'note') {
    found.node[f] = t.value;
    if (f === 'title') { const h = qs('#drawer h3'); if (h) h.textContent = t.value || `Turn ${found.depth}`; }
  } else if (a) {
    const index = Number(t.dataset.i);
    const action = found.node.actions[index];
    if (!action) return;
    if (a === 'kind') action.kind = asKind(t.value);
    else if (a === 'mon' || a === 'target') action[a] = t.value;
    else if (a === 'pivot') { if (t.value) action.pivot = t.value; else delete action.pivot; }
    else if (a === 'move') {
      const wasPivot = isPivotMove(action.move);
      action.move = t.value;
      if (wasPivot !== isPivotMove(action.move)) {
        // Show or hide the "Then switch to" picker right away, keeping the caret in the move box.
        if (!isPivotMove(action.move)) delete action.pivot;
        const caret = t instanceof HTMLInputElement ? t.selectionStart : null;
        renderDrawer();
        const box = qs<HTMLInputElement>(`#a-move-${index}`);
        box?.focus();
        if (box && caret !== null) box.setSelectionRange(caret, caret);
      }
    } else return;
  } else if (t.dataset.tie) {
    // Speed tie: the chosen Pokémon moves ahead of the other one.
    const [a, b] = t.dataset.tie.split('|');
    const winner = t.value;
    const loser = winner === a ? b : a;
    if (!winner || !loser) return;
    const node = found.node;
    node.tieOrder = [...(node.tieOrder ?? []).filter((k) => k !== winner && k !== loser), winner, loser];
  } else if (t.dataset.o) {
    const action = found.node.actions[Number(t.dataset.i)];
    if (!action) return;
    setOutcome(action, t.dataset.o, t.dataset.t ?? '', t);
  } else return;
  store.persist();
  rerenderCanvas();
}

/** Some edits change what the editor itself should offer (move suggestions, switch target list). */
function onChange(e: Event): void {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.id === 'imp-file' && t.files?.[0]) { loadImportFile(t.files[0]); return; }
  if (!isField(t) || !t.closest('#drawer')) return;
  const a = t.dataset.a;
  const found = store.currentNode();
  const action = found?.node.actions[Number(t.dataset.i)];
  if (!found || !action) return;
  // A switch target changes who is left to pivot into.
  if (a !== 'kind' && a !== 'mon' && !(a === 'target' && action.kind === 'switch')) return;
  if (a === 'kind') { if (action.kind === 'switch') action.move = ''; action.target = ''; delete action.pivot; }
  store.persist();
  renderDrawer();
  rerenderCanvas();
}

function onKeydown(e: KeyboardEvent): void {
  const t = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && t instanceof HTMLElement && t.matches('[role="button"][data-act], [role="tab"][data-act]')) {
    e.preventDefault();
    t.click();
  }
  // F2 renames the focused tab, as in spreadsheets.
  if (e.key === 'F2' && t instanceof HTMLElement && t.matches('.sheet-tab[data-tab]')) {
    e.preventDefault();
    startRenameTab(t.dataset.tab ?? '');
  }
  if (e.key === 'Escape' && store.ui.selectedNode && !qs('.overlay')) {
    store.ui.selectedNode = null;
    qs('#drawer')?.classList.add('hidden');
    rerenderCanvas();
  }
}

export function installEvents(): void {
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]') : null;
    if (el) handleClick(el, e).catch(reportError);
  });
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('dblclick', (e) => {
    const tab = e.target instanceof Element ? e.target.closest<HTMLElement>('.sheet-tab[data-tab]') : null;
    if (tab && !(e.target instanceof HTMLInputElement)) startRenameTab(tab.dataset.tab ?? '');
  });
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  simService.onChange = () => rerenderCanvas();
}
