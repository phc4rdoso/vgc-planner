import { config } from '../../config.ts';
import { findNode, monsFor } from '../../domain/model.ts';
import type { FlowNode, Plan, PokemonSet, Sheet, Side, Team, TurnAction } from '../../domain/types.ts';
import { simService, store } from '../../state/instance.ts';
import type { SimView } from '../../state/sim-service.ts';
import { applyDynamicStyles, esc, must, qs } from '../dom.ts';
import { itemIcon, monIcon } from '../icons.ts';
import type { BattleState, Outcome } from '../../domain/simulation/state.ts';
import { formOf } from '../names.ts';
import { isPivotMove, refreshDrawerFoot, renderDrawer } from './drawer.ts';
import { fieldStripHTML, hasDetails, ICON_CHEVRON, ICON_RERUN, noticeHTML, resultHTML, summaryHTML } from './result-card.ts';
import { renderNav } from './sidebar.ts';

const PLUS_ICON = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 3v12M3 9h12"/></svg>';

function selectionBox(side: Side, plan: Sheet): string {
  const sel = plan.selection[side];
  const slot = (kind: 'lead' | 'back', i: number): string => {
    const name = sel[kind][i];
    return `<button class="slot ${name ? 'filled' : ''}" data-act="pick-slot" data-side="${side}" data-kind="${kind}" data-i="${i}" aria-label="${kind} slot ${i + 1}">
      ${name ? `${monIcon(formOf(null, side, name), 'sm')}<span class="nm">${esc(formOf(null, side, name))}</span>` : 'Choose'}</button>`;
  };
  return `<div class="box ${side}"><div class="box-head"><span class="t">${side === 'me' ? 'Your lead and back' : 'Opponent lead and back'}</span></div>
    <div class="slots-label">Lead</div><div class="slots">${slot('lead', 0)}${slot('lead', 1)}</div>
    <div class="slots-label">Back</div><div class="slots">${slot('back', 0)}${slot('back', 1)}</div></div>`;
}

function teamBox(side: Side, title: string, mons: readonly PokemonSet[]): string {
  if (side === 'opp' && !mons.length) {
    return '<div class="box opp"><div class="box-head"><span class="t">Opponent team</span></div><button class="paste-cta" data-act="edit-paste" data-kind="opp">Paste opponent team</button></div>';
  }
  const strip = mons.length
    ? `<div class="team-strip">${mons.slice(0, 6).map((m) => `<div class="cell">${monIcon(m.species)}${itemIcon(m.item, 'xs')}</div>`).join('')}</div>`
    : '';
  return `<div class="box ${side}"><div class="box-head"><span class="t">${esc(title)}</span>
    <button class="btn ghost sm" data-act="edit-paste" data-kind="${side}">Edit</button></div>${strip}</div>`;
}

const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = { win: 'Win', loss: 'Loss', draw: 'Draw' };

/** Win / loss once every Pokémon on one side has fainted in this turn's branch. */
function outcomeOf(n: FlowNode, sim: SimView): Outcome | null {
  if (!sim.enabled || sim.status !== 'ready') return null;
  const r = sim.results.get(n.id);
  return r?.status === 'ready' ? r.outcome : null;
}

/** Pokémon names as shown at the start of a turn: current form (base until it Mega Evolves in the branch). */
function nameAt(start: BattleState | null, side: Side, key: string): string {
  const foe: Side = side === 'me' ? 'opp' : 'me';
  // A target can be on either side; keywords ("Both foes"...) are shown as they are.
  if (start && !start.mons[side][key] && start.mons[foe][key]) return formOf(start, foe, key);
  return formOf(start, side, key);
}

/** `start`: the battle state this turn begins from (null when not known yet). */
function nodeHTML(n: FlowNode, depth: number, sim: SimView, start: BattleState | null, picks: Record<Side, string[]>): string {
  const selected = store.ui.selectedNode === n.id;
  const action = (a: TurnAction): string => {
    const foe: Side = a.side === 'me' ? 'opp' : 'me';
    const what = a.kind === 'switch' ? `Switch to ${esc(a.target ? nameAt(start, a.side, a.target) : '?')}` : `${a.kind === 'mega' ? 'Mega + ' : ''}${esc(a.move || '—')}`;
    const target = a.kind === 'switch' || !a.target ? '' : `→ ${esc(nameAt(start, foe, a.target))}`;
    const pivot = a.kind !== 'switch' && a.pivot && isPivotMove(a.move) ? `then ${esc(nameAt(start, a.side, a.pivot))}` : '';
    const sub = [target, pivot].filter(Boolean).join(' · ');
    const who = a.mon ? nameAt(start, a.side, a.mon) : 'Replacement';
    return `<div class="act ${a.side}" title="${esc(`${who}: ${a.kind === 'switch' ? 'switch' : a.move || 'no move yet'}`)}">${a.mon ? monIcon(who, 'xs') : '<span class="mon-fallback xs">?</span>'}<div class="txt"><div class="mv">${what}</div>${sub ? `<div class="tg">${sub}</div>` : ''}</div></div>`;
  };
  const column = (side: Side): string => n.actions.filter((a) => a.side === side).map(action).join('');
  const title = n.title || `Turn ${depth}`;
  const outcome = outcomeOf(n, sim);
  const tag = outcome ? ` <span class="otag ${outcome}">${OUTCOME_LABEL[outcome]}</span>` : '';
  const open = store.ui.expanded[n.id] === true && hasDetails(n, sim);
  const toggle = hasDetails(n, sim)
    ? `<button class="card-btn expand ${open ? 'open' : ''}" data-act="toggle-result" data-node="${esc(n.id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} the battle log" title="${open ? 'Hide' : 'Show'} the battle log">${ICON_CHEVRON}</button>`
    : '';
  return `<div class="turn ${selected ? 'selected' : ''} ${open ? 'open' : ''} ${outcome ?? ''}" data-act="select-node" data-node="${esc(n.id)}" tabindex="0" role="button" aria-label="Edit ${esc(title)}${outcome ? ` (${OUTCOME_LABEL[outcome]})` : ''}">
    <div class="turn-head">
      ${n.condition ? `<span class="cond" title="${esc(n.condition)}">${esc(n.condition)}</span>` : ''}
      <span class="ttl">${esc(title)}${tag}</span><span class="spacer"></span>
      ${sim.enabled ? `<button class="card-btn" data-act="rerun" aria-label="Rerun turn result" title="Rerun turn result">${ICON_RERUN}</button>` : ''}${toggle}
    </div>
    ${n.actions.length ? `<div class="acts"><div class="col">${column('me')}</div><div class="col">${column('opp')}</div></div>` : '<div class="none">No actions yet</div>'}
    ${n.note ? `<div class="note" title="${esc(n.note)}">${esc(n.note)}</div>` : ''}
    ${summaryHTML(n, sim, start, picks)}${fieldStripHTML(n, sim)}
    ${open ? resultHTML(n, sim, start, picks) : ''}</div>`;
}

/** `canAdd` is false below a turn where the battle ended: no "+" box, so no further turns. */
function listHTML(nodes: FlowNode[], parentId: string | null, depth: number, sim: SimView, start: BattleState | null, picks: Record<Side, string[]>, canAdd = true): string {
  const first = parentId === null && nodes.length === 0;
  return nodes.map((n) => {
    const r = sim.enabled && sim.status === 'ready' ? sim.results.get(n.id) : undefined;
    const children = listHTML(n.children, n.id, depth + 1, sim, r?.status === 'ready' ? r.state : null, picks, outcomeOf(n, sim) === null);
    return `<li class="tree-item">${nodeHTML(n, depth, sim, start, picks)}${children ? `<ul class="tree-children">${children}</ul>` : ''}</li>`;
  }).join('')
    + (canAdd ? `<li class="tree-item"><button class="addbox ${first ? 'first' : ''}" data-act="add-node" data-parent="${esc(parentId ?? '')}" aria-label="${parentId === null ? 'Add first turn' : 'Add turn or branch'}" title="Add a turn">${PLUS_ICON}</button></li>` : '');
}

/** Everyone brought by each side (lead and back picks). */
const picksOf = (plan: Sheet): Record<Side, string[]> => ({
  me: [...plan.selection.me.lead, ...plan.selection.me.back].filter((x): x is string => !!x),
  opp: [...plan.selection.opp.lead, ...plan.selection.opp.back].filter((x): x is string => !!x),
});

function canvasInner(team: Team, plan: Sheet, sim: SimView): string {
  return `<div class="top">
      <div class="col">${teamBox('me', team.name, monsFor('me', team, plan))}<div class="link"></div>${selectionBox('me', plan)}<div class="bracket"></div></div>
      <div class="col">${teamBox('opp', plan.opponent.name || 'Opponent team', monsFor('opp', team, plan))}<div class="link"></div>${selectionBox('opp', plan)}<div class="bracket"></div></div>
    </div>
    <div class="stem"></div>
    <ul class="tree rootlist">${listHTML(plan.children, null, 1, sim, sim.enabled && sim.status === 'ready' ? sim.start : null, picksOf(plan))}</ul>`;
}

/** Tabs along the bottom, like spreadsheet sheets: one per set of leads/backs. Double-click (or ▾ → Rename) renames. */
function tabBarHTML(plan: Plan, activeId: string): string {
  const tabs = plan.tabs.map((t) => {
    const on = t.id === activeId;
    return `<div class="sheet-tab ${on ? 'on' : ''}" role="tab" aria-selected="${on}" tabindex="0" data-act="select-tab" data-tab="${esc(t.id)}" title="${esc(t.name)} · double-click to rename">
      <span class="nm">${esc(t.name)}</span>${on ? `<button class="tab-menu" data-act="tab-menu" data-tab="${esc(t.id)}" aria-label="Options for ${esc(t.name)}">▾</button>` : ''}</div>`;
  }).join('');
  return `<button class="tab-add" data-act="add-tab" aria-label="Add tab" title="Add a tab (another set of leads and backs)">${PLUS_ICON}</button>
    <div class="sheet-tabs" role="tablist" aria-label="Gameplan tabs">${tabs}</div>`;
}

/** Redraws only the tab bar (after a rename). */
export function renderTabBar(): void {
  const bar = qs('#tabbar');
  const plan = store.plan; const tab = store.tab;
  if (bar && plan && tab) bar.innerHTML = tabBarHTML(plan, tab.id);
}

export function renderPlanView(main: HTMLElement, team: Team, plan: Plan): void {
  const sheet = store.sheet;
  if (!sheet) return;
  const sim = simService.compute(team, sheet);
  main.innerHTML = `
  <div class="topbar">
    <span class="crumb">${esc(team.name)} /</span>
    <input class="title-input" id="plan-name" value="${esc(plan.name)}" aria-label="Gameplan name">
    <span class="spacer"></span>
    <div class="zoom-ctl"><button class="btn sm" data-act="zoom" data-d="-1" aria-label="Zoom out">−</button><span class="lvl" id="zlvl">${Math.round(store.ui.zoom * 100)}%</span><button class="btn sm" data-act="zoom" data-d="1" aria-label="Zoom in">+</button></div>
    <button class="btn" data-act="export-plan" data-team="${esc(team.id)}" data-plan="${esc(plan.id)}">Export</button>
  </div>
  <div id="notice">${noticeHTML(sim)}</div>
  <div class="workspace">
    <div class="canvas" id="canvas"><div class="canvas-inner" id="cinner">${canvasInner(team, sheet, sim)}</div></div>
    <aside class="drawer hidden" id="drawer" aria-label="Turn editor"></aside>
  </div>
  <div class="tabbar" id="tabbar">${tabBarHTML(plan, sheet.id)}</div>`;
  const inner = must('#cinner');
  inner.style.setProperty('--zoom', String(store.ui.zoom));
  applyDynamicStyles(inner);
  must<HTMLInputElement>('#plan-name').addEventListener('input', (e) => {
    plan.name = (e.target as HTMLInputElement).value;
    store.persist();
    renderNav();
  });
  setupPan();
  if (store.ui.selectedNode && findNode(sheet.children, store.ui.selectedNode)) renderDrawer();
  else store.ui.selectedNode = null;
}

/** Redraws only the flowchart (keeps scroll position and the open editor). `force` bypasses the result cache. */
export function rerenderCanvas(force = false): void {
  const canvas = qs('#canvas');
  const host = qs('#cinner');
  const team = store.team; const plan = store.sheet;
  if (!canvas || !host || !team || !plan) return;
  const { scrollLeft, scrollTop } = canvas;
  const sim = simService.compute(team, plan, force);
  host.innerHTML = canvasInner(team, plan, sim);
  applyDynamicStyles(host);
  const notice = qs('#notice');
  if (notice) notice.innerHTML = noticeHTML(sim);
  refreshDrawerFoot();
  canvas.scrollLeft = scrollLeft;
  canvas.scrollTop = scrollTop;
}

/* ---- canvas: drag to pan, Ctrl/Cmd + wheel to zoom ---- */

let panCleanup: (() => void) | null = null;

function setupPan(): void {
  panCleanup?.();
  panCleanup = null;
  const canvas = qs('#canvas');
  if (!canvas) return;
  canvas.scrollLeft = store.ui.scrollX;
  canvas.scrollTop = store.ui.scrollY;
  canvas.addEventListener('scroll', () => { store.ui.scrollX = canvas.scrollLeft; store.ui.scrollY = canvas.scrollTop; });

  let drag: { x: number; y: number; left: number; top: number } | null = null;
  canvas.addEventListener('mousedown', (e) => {
    if (e.target instanceof Element && e.target.closest('button, input, textarea, select, .box, .turn')) return;
    drag = { x: e.clientX, y: e.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
    canvas.classList.add('panning');
  });
  const onMove = (e: MouseEvent): void => {
    if (!drag) return;
    canvas.scrollLeft = drag.left - (e.clientX - drag.x);
    canvas.scrollTop = drag.top - (e.clientY - drag.y);
  };
  const onUp = (): void => { drag = null; canvas.classList.remove('panning'); };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  panCleanup = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };

  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(store.ui.zoom + (e.deltaY < 0 ? config.zoom.step : -config.zoom.step));
  }, { passive: false });
}

export function setZoom(value: number): void {
  const { min, max } = config.zoom;
  store.ui.zoom = Math.max(min, Math.min(max, Math.round(value * 10) / 10));
  qs('#cinner')?.style.setProperty('--zoom', String(store.ui.zoom));
  const label = qs('#zlvl');
  if (label) label.textContent = `${Math.round(store.ui.zoom * 100)}%`;
  store.persist();
}
