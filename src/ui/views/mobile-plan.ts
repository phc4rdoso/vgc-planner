/**
 * The gameplan on a phone. A flowchart doesn't fit a narrow screen, so it shows one line of play at a time (Path):
 * the turns from the first one down, following one alternative at each fork, with chips to switch between them. The
 * Overview is an outline of every turn; tapping one follows its line in the Path. Turn cards are the same as on the
 * canvas, so the editor, copy, battle log and results all work as on a wide screen.
 */
import type { FlowNode, Sheet, Side } from '../../domain/types.ts';
import type { Outcome } from '../../domain/simulation/state.ts';
import { store } from '../../state/instance.ts';
import { esc } from '../dom.ts';

/** What the plan view supplies: the team and lead boxes, a turn card, and how a turn ended (if the battle did). */
export interface MobileParts {
  setup: string;
  card: (n: FlowNode, depth: number, parent: FlowNode | null) => string;
  outcome: (n: FlowNode) => Outcome | null;
}

interface Step { node: FlowNode; siblings: FlowNode[]; parent: FlowNode | null; key: string }

const ICON_PLUS = '<svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 3v12M3 9h12"/></svg>';
const ICON_FORK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-12 3-12 8"/></svg>';
const ICON_CHEVRON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = { win: 'Win', loss: 'Loss', draw: 'Draw' };

/** The turns on screen: from the first turn down, following the picked alternative at every fork (the first one otherwise). */
function pathOf(sheet: Sheet): Step[] {
  const out: Step[] = [];
  let siblings = sheet.children;
  let parent: FlowNode | null = null;
  let key = sheet.id;
  while (siblings.length) {
    const pick = store.ui.pathPick[key];
    const node = siblings.find((n) => n.id === pick) ?? siblings[0]!;
    out.push({ node, siblings, parent, key });
    parent = node; key = node.id; siblings = node.children;
  }
  return out;
}

/** Picks the alternatives on the way to this turn, so the Path runs through it. */
export function followTo(sheet: Sheet, id: string): void {
  const walk = (list: FlowNode[], key: string): boolean => {
    for (const n of list) {
      if (n.id === id || walk(n.children, n.id)) { store.ui.pathPick[key] = n.id; return true; }
    }
    return false;
  };
  walk(sheet.children, sheet.id);
}

/** Whether a turn is on the Path being shown. */
export function onPath(sheet: Sheet, id: string): boolean {
  return pathOf(sheet).some((s) => s.node.id === id);
}

/** How an alternative is named on its chip: its line's name, its first label, its title, or its place. */
const choiceName = (n: FlowNode, i: number): string => n.line?.name || n.tags[0] || n.title || `Option ${i + 1}`;
const descendants = (n: FlowNode): number => n.children.reduce((sum, c) => sum + 1 + descendants(c), 0);
/** "Kowtow Cleave + Clanging Scales": your side's moves this turn. */
function yourMoves(n: FlowNode): string {
  const mine = n.actions.filter((a) => a.side === 'me' && (a.kind === 'switch' ? a.target : a.move));
  return mine.map((a) => (a.kind === 'switch' ? `Switch to ${a.target}` : a.move)).join(' + ') || 'No moves picked yet';
}

function leadsLine(sheet: Sheet): string {
  const leads = (side: Side): string => sheet.selection[side].lead.filter(Boolean).join(' + ') || '?';
  return `${leads('me')} vs ${leads('opp')}`;
}

function pathHTML(sheet: Sheet, parts: MobileParts): string {
  const path = pathOf(sheet);
  const out: string[] = [];
  let forks = 0;
  path.forEach(({ node, siblings, parent, key }, i) => {
    const depth = i + 1;
    if (siblings.length > 1) {
      forks++;
      const chips = siblings.map((s, j) => `<button class="m-chip" data-act="m-pick" data-key="${esc(key)}" data-node="${esc(s.id)}" aria-pressed="${s === node}">${esc(choiceName(s, j))}</button>`).join('');
      out.push(`<div class="m-fork"><div class="m-fork-lbl">${ICON_FORK}Turn ${depth}: ${siblings.length} alternatives</div>
        <div class="m-chips">${chips}<button class="m-chip add" data-act="add-node" data-parent="${esc(parent?.id ?? '')}">${ICON_PLUS}Alternative</button></div></div>`);
    }
    out.push(parts.card(node, depth, parent));
  });
  const last = path.at(-1)?.node;
  const outcome = last ? parts.outcome(last) : null;
  if (!last) out.push(`<button class="m-add" data-act="add-node" data-parent="">${ICON_PLUS}Add the first turn</button>`);
  else if (outcome) out.push(`<p class="m-note">The battle ends here in this line (${OUTCOME_LABEL[outcome].toLowerCase()}).</p>`);
  else out.push(`<button class="m-add" data-act="add-node" data-parent="${esc(last.id)}">${ICON_PLUS}Add turn ${path.length + 1}</button>`);
  if (last && !forks) out.push('<p class="m-note">To plan another reply at a turn, use its copy button: the copy becomes an alternative you can switch to.</p>');
  return `<div class="m-path">${out.join('')}</div>`;
}

function treeHTML(sheet: Sheet, parts: MobileParts): string {
  if (!sheet.children.length) return '<p class="m-note">No turns yet. Add the first one in the Path view.</p>';
  const lit = new Set(pathOf(sheet).map((s) => s.node.id));
  const rows: string[] = [];
  const walk = (list: FlowNode[], depth: number): void => {
    list.forEach((n, i) => {
      const folded = store.ui.folded[n.id] === true;
      const kids = n.children.length;
      const outcome = parts.outcome(n);
      const label = list.length > 1 || n.tags.length || n.line?.name ? `<span class="m-tag">${esc(choiceName(n, i))}</span>` : '';
      rows.push(`<div class="m-row ${lit.has(n.id) ? 'on-path' : ''} ${store.ui.selectedNode === n.id ? 'current' : ''}">
        ${'<span class="m-guide" aria-hidden="true"></span>'.repeat(depth - 1)}
        <button class="m-fold ${kids ? '' : 'leaf'}" data-act="m-fold" data-node="${esc(n.id)}" aria-expanded="${!folded}" aria-label="${folded ? 'Expand' : 'Collapse'} turn ${depth}"${kids ? '' : ' tabindex="-1"'}>${ICON_CHEVRON}</button>
        <button class="m-row-main" data-act="m-goto" data-node="${esc(n.id)}">
          <span class="m-row-top"><span class="m-row-n">T${depth}</span>${label}${outcome ? `<span class="otag ${outcome}">${OUTCOME_LABEL[outcome]}</span>` : ''}${kids ? `<span class="m-count">${descendants(n)} after</span>` : ''}</span>
          <span class="m-row-sum">${esc(yourMoves(n))}</span></button></div>`);
      if (!folded) walk(n.children, depth + 1);
    });
  };
  walk(sheet.children, 1);
  return `<p class="m-note left">Every turn in this plan. Tap one to follow its line; highlighted rows are the line you're on.</p><div class="m-tree">${rows.join('')}</div>`;
}

export function mobilePlanHTML(sheet: Sheet, parts: MobileParts): string {
  // The turn open in the editor (a new or copied one too) is always on the Path.
  if (store.ui.selectedNode) followTo(sheet, store.ui.selectedNode);
  const view = store.ui.mobileView;
  const seg = `<div class="m-seg" role="group" aria-label="View">
    <button data-act="m-view" data-view="path" aria-pressed="${view === 'path'}">Path</button>
    <button data-act="m-view" data-view="tree" aria-pressed="${view === 'tree'}">Overview</button></div>`;
  const ready = sheet.selection.me.lead.some(Boolean) && sheet.selection.opp.lead.some(Boolean);
  const open = store.ui.setupOpen ?? (!sheet.children.length || !ready);
  const setup = `<details class="m-setup" ${open ? 'open' : ''}>
    <summary data-act="m-setup"><span class="m-setup-t">Teams, leads and backs</span><span class="m-setup-sum">${esc(leadsLine(sheet))}</span></summary>
    <div class="m-setup-body">${parts.setup}</div></details>`;
  return `${seg}${setup}${view === 'tree' ? treeHTML(sheet, parts) : pathHTML(sheet, parts)}`;
}
