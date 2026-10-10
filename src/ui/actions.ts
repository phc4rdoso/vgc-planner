import { buildExport, DataError, LIMITS, mergeImport, readExport } from '../domain/codec.ts';
import type { ExportScope } from '../domain/codec.ts';
import { cleanSelections, clonePlan, cloneTab, copyTurn, countNodes, findNode, findPlan, findTeam, monsFor, newNode, newPlan, newTab, newTeam, nextTabName, seedActions } from '../domain/model.ts';
import { parseShowdown, teamWarnings } from '../domain/showdown.ts';
import { slug } from '../domain/strings.ts';
import { nextActions } from '../domain/simulation/state.ts';
import type { Side, SlotKind } from '../domain/types.ts';
import { store } from '../state/instance.ts';
import { requestRender } from './bus.ts';
import { esc, must } from './dom.ts';
import { monIcon } from './icons.ts';
import { formOf } from './names.ts';
import { PASTE_LINK_HINT } from './paste-links.ts';
import { confirmDialog, modal, openMenu, toast } from './overlays.ts';
import { turnResult } from './turn-results.ts';
import type { MenuItem } from './overlays.ts';
import { renderDrawer } from './views/drawer.ts';
import { renderTabBar, rerenderCanvas, revealTurn } from './views/plan-view.ts';

/* ------------------------------ teams & plans ------------------------------ */

export async function createTeam(): Promise<void> {
  const input = await modal<{ name: string; paste: string }>({
    title: 'New team', desc: `Paste your team in Showdown format, ${PASTE_LINK_HINT}.`,
    body: `<div><label class="lbl" for="nt-name">Team name</label><input class="field" id="nt-name" placeholder="e.g. Rain offense"></div>
           <div><label class="lbl" for="nt-paste">Showdown paste</label><textarea class="paste" id="nt-paste" data-team-paste data-name-field="#nt-name" placeholder="Rillaboom @ Assault Vest&#10;Ability: Grassy Surge&#10;- Fake Out&#10;- Grassy Glide&#10;&#10;…${PASTE_LINK_HINT}"></textarea></div>`,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Create team', cls: 'primary', run: (ov) => ({ name: must<HTMLInputElement>('#nt-name', ov).value.trim(), paste: must<HTMLTextAreaElement>('#nt-paste', ov).value }) },
    ],
  });
  if (!input) return;
  const mons = parseShowdown(input.paste);
  const team = newTeam(input.name || (mons[0] ? `${mons[0].species} team` : 'My team'), input.paste);
  store.library.teams.push(team);
  Object.assign(store.ui, { teamId: team.id, planId: null });
  store.ui.open[team.id] = true;
  store.persist();
  requestRender();
  teamWarnings(mons).forEach((w) => toast(w, true));
}

export async function createPlan(teamId: string): Promise<void> {
  const team = findTeam(store.library, teamId);
  if (!team) return;
  const input = await modal<{ name: string; paste: string }>({
    title: 'New gameplan', desc: `Against which team? Gameplans are saved inside “${team.name}”.`,
    body: `<div><label class="lbl" for="np-name">Opponent team name (optional)</label><input class="field" id="np-name" placeholder="e.g. Sun balance from Regionals"></div>
           <div><label class="lbl" for="np-paste">Opponent Showdown paste (optional)</label><textarea class="paste" id="np-paste" data-team-paste data-name-field="#np-name" placeholder="Showdown paste, ${PASTE_LINK_HINT}"></textarea></div>`,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Create gameplan', cls: 'primary', run: (ov) => ({ name: must<HTMLInputElement>('#np-name', ov).value.trim(), paste: must<HTMLTextAreaElement>('#np-paste', ov).value }) },
    ],
  });
  if (!input) return;
  const mons = parseShowdown(input.paste);
  const label = input.name || mons.slice(0, 2).map((m) => m.species).join(' / ');
  const plan = newPlan(label ? `vs ${label}` : 'New gameplan', input.paste);
  plan.opponent.name = input.name;
  team.plans.push(plan);
  Object.assign(store.ui, { teamId: team.id, planId: plan.id, tabId: null, selectedNode: null });
  store.ui.open[team.id] = true;
  store.persist();
  requestRender();
}

export async function editPaste(kind: Side): Promise<void> {
  const team = store.team; const plan = store.plan;
  if (!team || (kind === 'opp' && !plan)) return;
  const current = kind === 'opp' ? plan!.opponent.paste : team.paste;
  const input = await modal<{ paste: string; name: string }>({
    title: kind === 'opp' ? 'Opponent team' : 'Your team', desc: `Paste the team in Showdown format, ${PASTE_LINK_HINT}.`,
    body: (kind === 'opp' ? `<div><label class="lbl" for="ep-name">Team name (optional)</label><input class="field" id="ep-name" value="${esc(plan!.opponent.name)}"></div>` : '')
      + `<textarea class="paste tall" id="ep-paste" data-team-paste${kind === 'opp' ? ' data-name-field="#ep-name"' : ''} aria-label="Showdown paste">${esc(current)}</textarea>`,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Save', cls: 'primary', run: (ov) => ({ paste: must<HTMLTextAreaElement>('#ep-paste', ov).value, name: (ov.querySelector<HTMLInputElement>('#ep-name')?.value ?? '').trim() }) },
    ],
  });
  if (!input) return;
  const parsed = parseShowdown(input.paste);
  if (kind === 'opp' && plan) {
    plan.opponent.paste = input.paste;
    plan.opponent.name = input.name;
    cleanSelections([plan], 'opp', parsed);
  } else {
    team.paste = input.paste;
    cleanSelections(team.plans, 'me', parsed);
  }
  store.persist();
  requestRender();
  teamWarnings(parsed).forEach((w) => toast(w, true));
}

export async function renameTeam(id: string): Promise<void> {
  const team = findTeam(store.library, id);
  if (!team) return;
  const name = await modal<string>({
    title: 'Rename team', body: `<input class="field" id="rn" aria-label="Team name" value="${esc(team.name)}">`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', run: (ov) => must<HTMLInputElement>('#rn', ov).value.trim() || team.name }],
  });
  if (name) { team.name = name; store.persist(); requestRender(); }
}

export async function deleteTeam(id: string): Promise<void> {
  const team = findTeam(store.library, id);
  if (!team) return;
  const n = team.plans.length;
  if (!await confirmDialog(`Delete “${team.name}”?`, `This also deletes its ${n} gameplan${n === 1 ? '' : 's'}. Export first if you want a backup.`)) return;
  store.library.teams = store.library.teams.filter((t) => t.id !== id);
  if (store.ui.teamId === id) Object.assign(store.ui, { teamId: null, planId: null, selectedNode: null });
  store.persist();
  requestRender();
}

export async function deletePlan(teamId: string, planId: string): Promise<void> {
  const team = findTeam(store.library, teamId);
  const plan = findPlan(team, planId);
  if (!team || !plan) return;
  if (!await confirmDialog(`Delete “${plan.name}”?`, 'The whole flowchart for this matchup will be removed.')) return;
  team.plans = team.plans.filter((p) => p.id !== planId);
  if (store.ui.planId === planId) Object.assign(store.ui, { planId: null, selectedNode: null });
  store.persist();
  requestRender();
}

export function duplicatePlan(teamId: string, planId: string): void {
  const team = findTeam(store.library, teamId);
  const plan = findPlan(team, planId);
  if (!team || !plan) return;
  const copy = clonePlan(plan);
  team.plans.push(copy);
  Object.assign(store.ui, { planId: copy.id, tabId: null, selectedNode: null });
  store.persist();
  requestRender();
}

/* ------------------------------ gameplan tabs ------------------------------ */

/** Opens a tab: the canvas starts at the top with no turn selected. */
export function selectTab(tabId: string): void {
  const plan = store.plan;
  if (!plan || !plan.tabs.some((t) => t.id === tabId) || store.tab?.id === tabId) return;
  Object.assign(store.ui, { tabId, selectedNode: null, scrollX: 0, scrollY: 0 });
  store.persist();
  requestRender();
}

/** A new, empty tab (pick its leads and backs), opened straight away with its name ready to edit. */
export function addTab(): void {
  const plan = store.plan;
  if (!plan) return;
  if (plan.tabs.length >= LIMITS.tabsPerPlan) { toast(`A gameplan can have up to ${LIMITS.tabsPerPlan} tabs.`, true); return; }
  const tab = newTab(nextTabName(plan));
  plan.tabs.push(tab);
  Object.assign(store.ui, { tabId: tab.id, selectedNode: null, scrollX: 0, scrollY: 0 });
  store.persist();
  requestRender();
  startRenameTab(tab.id);
}

export function duplicateTab(tabId: string): void {
  const plan = store.plan;
  const tab = plan?.tabs.find((t) => t.id === tabId);
  if (!plan || !tab) return;
  if (plan.tabs.length >= LIMITS.tabsPerPlan) { toast(`A gameplan can have up to ${LIMITS.tabsPerPlan} tabs.`, true); return; }
  const copy = cloneTab(tab, `${tab.name} (copy)`);
  plan.tabs.splice(plan.tabs.indexOf(tab) + 1, 0, copy);
  Object.assign(store.ui, { tabId: copy.id, selectedNode: null });
  store.persist();
  requestRender();
}

export async function deleteTab(tabId: string): Promise<void> {
  const plan = store.plan;
  const tab = plan?.tabs.find((t) => t.id === tabId);
  if (!plan || !tab) return;
  if (plan.tabs.length === 1) { toast('A gameplan needs at least one tab.', true); return; }
  const turns = countNodes(tab.children);
  if (turns && !await confirmDialog(`Delete the tab “${tab.name}”?`, `Its ${turns} turn${turns === 1 ? '' : 's'} will be deleted too.`)) return;
  const index = plan.tabs.indexOf(tab);
  plan.tabs.splice(index, 1);
  if (store.ui.tabId === tabId || !plan.tabs.some((t) => t.id === store.ui.tabId)) {
    Object.assign(store.ui, { tabId: plan.tabs[Math.max(0, index - 1)]!.id, selectedNode: null });
  }
  store.persist();
  requestRender();
}

/** Turns the tab's label into a text box, like renaming a spreadsheet sheet. Enter or leaving the box saves; Escape cancels. */
export function startRenameTab(tabId: string): void {
  const plan = store.plan;
  const tab = plan?.tabs.find((t) => t.id === tabId);
  const label = document.querySelector<HTMLElement>(`.sheet-tab[data-tab="${CSS.escape(tabId)}"] .nm`);
  if (!tab || !label) return;
  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.value = tab.name;
  input.maxLength = LIMITS.nameLength;
  input.setAttribute('aria-label', 'Tab name');
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== tab.name) { tab.name = name; store.persist(); }
    renderTabBar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

export function tabMenu(anchor: HTMLElement, tabId: string): void {
  const plan = store.plan;
  if (!plan) return;
  const items: MenuItem[] = [
    { label: 'Rename', run: () => startRenameTab(tabId) },
    { label: 'Duplicate', run: () => duplicateTab(tabId) },
  ];
  if (plan.tabs.length > 1) items.push('-', { label: 'Delete', cls: 'danger', run: () => void deleteTab(tabId) });
  openMenu(anchor, items);
}

/* ------------------------------ export / import ------------------------------ */

export async function showExport(scope: ExportScope): Promise<void> {
  let json: string;
  try { json = JSON.stringify(buildExport(store.library, scope), null, 2); }
  catch (e) { toast(e instanceof DataError ? e.message : 'Nothing to export.', true); return; }
  const team = scope.type === 'all' ? undefined : findTeam(store.library, scope.teamId);
  const filename = scope.type === 'all'
    ? 'vgc-gameplans-all'
    : slug(`${team?.name ?? 'team'}${scope.type === 'plan' ? `-${findPlan(team, scope.planId)?.name ?? 'plan'}` : ''}`);

  await modal<null>({
    title: 'Export JSON', desc: 'Import this file in the tool to restore the teams and gameplans.',
    body: `<textarea class="paste medium" readonly id="exp" aria-label="Exported JSON">${esc(json)}</textarea>`,
    actions: [
      { label: 'Close', value: null },
      {
        label: 'Copy',
        run: () => {
          must<HTMLTextAreaElement>('#exp').select();
          void navigator.clipboard.writeText(json).then(() => toast('Copied to clipboard'), () => toast('Copy failed. Select the text and copy it manually.', true));
          return false;
        },
      },
      {
        label: 'Download .json', cls: 'primary',
        run: () => {
          const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
          const link = document.createElement('a');
          link.href = url; link.download = `${filename}.json`;
          document.body.appendChild(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          toast(`Downloaded ${filename}.json`);
          return false;
        },
      },
    ],
  });
}

function importText(text: string): string {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e) { throw new DataError(`That text isn't valid JSON: ${e instanceof Error ? e.message : ''}`); }
  const summary = mergeImport(store.library, readExport(raw));
  if (summary.focus) {
    Object.assign(store.ui, { teamId: summary.focus.teamId, planId: summary.focus.planId, tabId: null, selectedNode: null });
    store.ui.open[summary.focus.teamId] = true;
  }
  store.persist();
  const t = summary.newTeams; const p = summary.plans;
  return `Imported ${t} new team${t === 1 ? '' : 's'} and ${p} gameplan${p === 1 ? '' : 's'}${summary.regulationWarning ? ` (${summary.regulationWarning})` : ''}.`;
}

export async function showImport(): Promise<void> {
  const message = await modal<string>({
    title: 'Import JSON', desc: 'Choose a file or paste the JSON. Teams with the same name are merged, so gameplans land in the right folder.',
    body: `<input type="file" id="imp-file" aria-label="JSON file" accept=".json,application/json"><textarea class="paste short" id="imp-text" aria-label="JSON text" placeholder="Paste JSON here"></textarea><div class="hint err-text" id="imp-err" role="alert"></div>`,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Import', cls: 'primary',
        run: (ov) => {
          const text = must<HTMLTextAreaElement>('#imp-text', ov).value.trim();
          const error = must('#imp-err', ov);
          if (!text) { error.textContent = 'Choose a file or paste some JSON first.'; return false; }
          try { return importText(text); }
          catch (e) { error.textContent = e instanceof DataError ? e.message : 'Import failed.'; return false; }
        },
      },
    ],
  });
  if (message) { requestRender(); toast(message); }
}

/** Fills the import box from a chosen file. */
export function loadImportFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => { const box = document.querySelector<HTMLTextAreaElement>('#imp-text'); if (box) box.value = String(reader.result); };
  reader.readAsText(file);
}

/* ------------------------------ flowchart ------------------------------ */

export function pickSlot(anchor: HTMLElement, side: Side, kind: SlotKind, index: number): void {
  const team = store.team; const plan = store.sheet;
  if (!team || !plan) return;
  const mons = monsFor(side, team, plan).map((m) => m.species);
  if (!mons.length) { toast(side === 'me' ? "Add your team's paste first." : 'Paste the opponent team first.', true); return; }
  const sel = plan.selection[side];
  const used = new Set([...sel.lead, ...sel.back].filter((n): n is string => !!n));
  const set = (value: string | null): void => { sel[kind][index] = value; store.persist(); rerenderCanvas(); };
  const items: MenuItem[] = mons
    .filter((m) => !used.has(m) || sel[kind][index] === m)
    .map((m) => ({ html: `${monIcon(formOf(null, side, m), 'xs')}<span>${esc(formOf(null, side, m))}</span>`, run: () => set(m) }));
  if (sel[kind][index]) items.push('-', { label: 'Clear slot', run: () => set(null) });
  openMenu(anchor, items);
}

export function addNode(parentId: string | null): void {
  const plan = store.sheet;
  if (!plan) return;
  const parent = parentId ? findNode(plan.children, parentId) : null;
  const before = turnResult(parent?.node.id);
  if (before?.status === 'ready' && before.outcome) { toast('The battle is over in this branch, so no more turns can follow it.', true); return; }
  // Follow the simulated battle when we can (who is on the field, who needs replacing); otherwise repeat the parent's Pokémon.
  const actions = before?.status === 'ready' ? nextActions(before.state) : seedActions(parent?.node ?? null, plan);
  const node = newNode({ actions });
  (parent ? parent.node.children : plan.children).push(node);
  store.ui.selectedNode = node.id;
  store.persist();
  rerenderCanvas();
  renderDrawer();
  revealTurn(node.id);
}

/** "Copy": a copy of the turn right beside it (another branch from the same parent), opened in the editor. */
export function copyNode(nodeId: string): void {
  const plan = store.sheet;
  const found = plan ? findNode(plan.children, nodeId) : null;
  if (!found) return;
  const copy = copyTurn(found.node);
  found.siblings.splice(found.siblings.indexOf(found.node) + 1, 0, copy);
  store.ui.selectedNode = copy.id;
  store.persist();
  rerenderCanvas();
  renderDrawer();
  // The copy can land off screen or under the editor: bring it into view.
  revealTurn(copy.id);
}

export async function deleteNode(): Promise<void> {
  const found = store.currentNode();
  if (!found) return;
  const followUps = countNodes([found.node]) - 1;
  if (followUps > 0 && !await confirmDialog('Delete this turn?', `It has ${followUps} follow-up turn${followUps === 1 ? '' : 's'} that will be deleted too.`)) return;
  found.siblings.splice(found.siblings.indexOf(found.node), 1);
  store.ui.selectedNode = null;
  store.persist();
  must('#drawer').classList.add('hidden');
  rerenderCanvas();
}
