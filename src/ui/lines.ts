import type { FlowNode, LineColor, PlanLine } from '../domain/types.ts';
import { LINE_COLORS } from '../domain/types.ts';
import { esc } from './dom.ts';

/** How each line colour is called in the editor. */
export const LINE_COLOR_LABEL: Readonly<Record<LineColor, string>> = { teal: 'Teal', sky: 'Sky', amber: 'Amber', pink: 'Pink', lime: 'Lime', orange: 'Orange' };

/** The CSS class that colours a line's cards and connectors; a line with no colour resets to the default ones. */
export const lineClass = (line: PlanLine): string => `lc lc-${line.color ?? 'none'}`;

/** What a line is called in the legend and the editor. */
export const lineLabel = (line: PlanLine, fallback: string): string => line.name || fallback;

export interface LineInfo { id: string; line: PlanLine; depth: number; title: string }

/** Every named line in a tab, in the order they appear going down the tree. */
export function linesOf(nodes: readonly FlowNode[], depth = 1, out: LineInfo[] = []): LineInfo[] {
  for (const n of nodes) {
    if (n.line) out.push({ id: n.id, line: n.line, depth, title: n.title || `Turn ${depth}` });
    linesOf(n.children, depth + 1, out);
  }
  return out;
}

/** The turns lit up when a line is highlighted: the way down to its first turn, and everything after it. */
export function lineFocus(nodes: readonly FlowNode[], startId: string): Set<string> {
  const out = new Set<string>();
  const below = (n: FlowNode): void => { out.add(n.id); n.children.forEach(below); };
  const walk = (list: readonly FlowNode[], path: string[]): boolean => {
    for (const n of list) {
      if (n.id === startId) { path.forEach((id) => out.add(id)); below(n); return true; }
      if (walk(n.children, [...path, n.id])) return true;
    }
    return false;
  };
  walk(nodes, []);
  return out;
}

/** The line a turn belongs to: its own, or the nearest one started above it. */
export function lineAt(nodes: readonly FlowNode[], id: string): { line: PlanLine; startId: string } | null {
  const walk = (list: readonly FlowNode[], current: { line: PlanLine; startId: string } | null): { line: PlanLine; startId: string } | null | undefined => {
    for (const n of list) {
      const here = n.line ? { line: n.line, startId: n.id } : current;
      if (n.id === id) return here;
      const found = walk(n.children, here);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(nodes, null) ?? null;
}

/**
 * Colours the fork bars. A branch's colour must run from the fork (under the parent turn) to its own turn, which CSS
 * alone can't know, so after each redraw this measures each fork and lays a coloured segment over that stretch of
 * the default bar. Branches without a colour, and the "+" boxes, keep the default bar.
 */
export function drawForkColors(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('ul.tree-children, ul.tree.rootlist').forEach((ul) => {
    const items = [...ul.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('tree-item'));
    if (items.length < 2) return;
    const stem = ul.clientWidth / 2;
    items.forEach((li, i) => {
      if (!li.querySelector(':scope > .turn, :scope > .card-row > .turn')) return;
      if (!getComputedStyle(li).getPropertyValue('--lc').trim()) return;
      const center = li.offsetLeft + li.offsetWidth / 2;
      if (Math.abs(center - stem) < 1) return;
      const seg = document.createElement('span');
      const left = center < stem;
      const end = i === 0 || i === items.length - 1;
      seg.className = `fork-seg ${left ? 'left' : 'right'}${end ? ' end' : ''}`;
      seg.setAttribute('aria-hidden', 'true');
      // Same pixels as the connector drawn by CSS: the drop into the turn is 2px wide starting at its centre (left
      // side) or ending at it (right side); the stem under the parent is 2px wide starting at the fork.
      const off = li.offsetLeft;
      seg.style.left = `${(left ? center : stem) - off}px`;
      seg.style.width = `${left ? stem - center + 2 : center - stem}px`;
      li.prepend(seg);
    });
  });
}

/** Chips for the tab's lines; clicking one highlights it. Empty when the tab has none. */
export function legendHTML(nodes: readonly FlowNode[], focus: string | null | undefined): string {
  const lines = linesOf(nodes);
  if (!lines.length) return '';
  const chips = lines.map((l) => {
    const on = focus === l.id;
    return `<button class="line-chip ${lineClass(l.line)} ${on ? 'on' : ''}" data-act="focus-line" data-node="${esc(l.id)}" aria-pressed="${on}" title="${esc(on ? 'Show every branch' : `Highlight this branch (starts at ${l.title})`)}"><span class="dot" aria-hidden="true"></span>${esc(lineLabel(l.line, l.title))}</button>`;
  }).join('');
  return `<span class="lbl-inline">Branches</span>${chips}${focus ? '<button class="line-chip clear" data-act="focus-line" data-node="">Show all</button>' : ''}`;
}

export { LINE_COLORS };
