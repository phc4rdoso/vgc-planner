import { monsFor } from '../../domain/model.ts';
import type { BattleState } from '../../domain/simulation/state.ts';
import { bench, canMegaEvolve, fieldAfterReplacements, syncTurnActions } from '../../domain/simulation/state.ts';
import { PIVOT_MOVES } from '../../domain/simulation/tables.ts';
import { toID } from '../../domain/strings.ts';
import type { FlowNode, Side, TurnAction } from '../../domain/types.ts';
import { TARGET_KEYWORDS } from '../../domain/types.ts';
import { store } from '../../state/instance.ts';
import { esc, must } from '../dom.ts';
import { monIcon } from '../icons.ts';
import { formOf } from '../names.ts';
import { startStateOf, turnResult } from '../turn-results.ts';
import { rerenderCanvas } from './plan-view.ts';

/** `label` turns a stored value (a paste name) into what is shown (its current form). */
const options = (list: readonly string[], current: string, blank?: string, label: (v: string) => string = (v) => v): string =>
  (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '')
  + list.map((v) => `<option ${v === current ? 'selected' : ''} value="${esc(v)}">${esc(label(v))}</option>`).join('');

export const isPivotMove = (move: string): boolean => PIVOT_MOVES[toID(move)] !== undefined;

/**
 * The Pokémon one side brought: its lead and back picks at the top of the tree (leads first). Only these can be
 * chosen in a turn. Falls back to the whole team while nothing has been picked yet.
 */
function orderedMons(side: Side): string[] {
  const team = store.team; const plan = store.sheet;
  if (!team || !plan) return [];
  const known = new Set(monsFor(side, team, plan).map((m) => m.species));
  const picked = [...plan.selection[side].lead, ...plan.selection[side].back].filter((n): n is string => !!n && known.has(n));
  return picked.length ? [...new Set(picked)] : [...known];
}

/**
 * Who could come in for `a.mon` (switch, replacement or pivot). Uses the simulated state at the start of the turn
 * when it is known; otherwise the other Pokémon brought (minus the leads on the first turn).
 */
function incomingChoices(a: TurnAction, st: BattleState | null, depth: number, actions: readonly TurnAction[]): string[] {
  let list: string[];
  if (st) {
    // Benched Pokémon given an action this turn come in to replace a fainted one, so they can't be switched to.
    const comingIn = new Set(actions.filter((x) => x !== a && x.side === a.side && x.mon && !st.active[a.side].includes(x.mon)).map((x) => x.mon));
    list = bench(st, a.side).filter((n) => !comingIn.has(n));
  } else {
    const leads = depth === 1 ? (store.tab?.selection[a.side].lead ?? []) : [];
    list = orderedMons(a.side).filter((v) => v !== a.mon && !leads.includes(v));
  }
  const current = a.kind === 'switch' ? a.target : (a.pivot ?? '');
  return current && !list.includes(current) ? [...list, current] : list;
}

/** Without a simulated state: does the item look like a Mega Stone ("Garchompite", "Charizardite X")? */
const looksLikeMegaStone = (item: string): boolean => /ite( [xyz])?$/i.test(item.trim()) && toID(item) !== 'eviolite';

/**
 * Whether "Mega evolve + move" can be offered: the Pokémon holds its Mega Stone and nobody on its side has Mega
 * Evolved earlier in the branch or is set to Mega Evolve in another action of this turn.
 */
function canOfferMega(a: TurnAction, st: BattleState | null, actions: readonly TurnAction[], item: string): boolean {
  if (!a.mon || actions.some((x) => x !== a && x.side === a.side && x.kind === 'mega')) return false;
  return st ? canMegaEvolve(st, a.side, a.mon) : looksLikeMegaStone(item);
}

/**
 * Who a move can target: the Pokémon on the field once this turn's replacements are in (both sides), then the
 * keywords. Without a simulated state, the leads on the first turn or everyone brought later.
 */
function targetChoices(a: TurnAction, st: BattleState | null, depth: number, actions: readonly TurnAction[]): string[] {
  const foe: Side = a.side === 'me' ? 'opp' : 'me';
  const onField = (side: Side): string[] => {
    if (st) return fieldAfterReplacements(st, actions)[side];
    if (depth === 1) return (store.tab?.selection[side].lead ?? []).filter((n): n is string => !!n);
    return orderedMons(side);
  };
  const list = [...new Set([...onField(foe), TARGET_KEYWORDS[0], ...onField(a.side).filter((v) => v !== a.mon), ...TARGET_KEYWORDS.slice(1)])];
  // A target chosen earlier that is no longer on the field stays visible; the move hits whoever took its place.
  return a.target && !list.includes(a.target) ? [...list, a.target] : list;
}

/** A Pokémon already on the field acts as itself; only a slot left by a fainted Pokémon lets you pick who comes in. */
function monField(a: TurnAction, i: number, st: BattleState | null, actions: readonly TurnAction[]): string {
  const onField = st ? st.active[a.side].includes(a.mon) && st.mons[a.side][a.mon]?.fainted === false : false;
  if (onField) {
    const form = formOf(st, a.side, a.mon);
    return `<div><span class="lbl">Pokémon</span><div class="act-mon">${monIcon(form, 'xs')}<span>${esc(form)}</span></div></div>`;
  }
  const taken = new Set(actions.filter((x) => x !== a && x.side === a.side && x.mon).map((x) => x.mon));
  const choices = st
    ? bench(st, a.side).filter((v) => v === a.mon || !taken.has(v))
    : orderedMons(a.side).filter((v) => v === a.mon || !taken.has(v));
  const label = st ? 'Replacement' : 'Pokémon';
  return `<div><label class="lbl" for="a-mon-${i}">${label}</label><select class="field" id="a-mon-${i}" data-a="mon" data-i="${i}">${options(choices, a.mon, 'Choose…', (v) => formOf(st, a.side, v))}</select></div>`;
}

function actionEditor(a: TurnAction, i: number, st: BattleState | null, depth: number, actions: readonly TurnAction[]): string {
  const team = store.team; const plan = store.sheet;
  const set = team && plan ? monsFor(a.side, team, plan).find((m) => m.species === a.mon) : undefined;
  const targets = targetChoices(a, st, depth, actions);
  const foe: Side = a.side === 'me' ? 'opp' : 'me';
  const own = (v: string): string => formOf(st, a.side, v);
  // Targets mix both sides (and the keywords, which stay as they are).
  const anyone = (v: string): string => ((TARGET_KEYWORDS as readonly string[]).includes(v) ? v : st?.mons[foe][v] || !st?.mons[a.side][v] ? formOf(st, foe, v) : own(v));
  const kindOption = (value: TurnAction['kind'], label: string): string => `<option value="${value}" ${a.kind === value ? 'selected' : ''}>${label}</option>`;
  const mega = a.kind === 'mega' || canOfferMega(a, st, actions, set?.item ?? '') ? kindOption('mega', 'Mega evolve + move') : '';
  const incoming = incomingChoices(a, st, depth, actions);
  const pivot = a.kind !== 'switch' && isPivotMove(a.move)
    ? `<div><label class="lbl" for="a-pivot-${i}">Then switch to</label><select class="field" id="a-pivot-${i}" data-a="pivot" data-i="${i}">${options(incoming, a.pivot ?? '', 'Choose…', own)}</select></div>`
    : '';
  return `<div class="act-edit ${a.side}" data-i="${i}">
    <div class="act-top"><span class="side-tag ${a.side}">${a.side === 'me' ? 'You' : 'Opponent'}</span></div>
    <div class="row2">
      ${monField(a, i, st, actions)}
      <div><label class="lbl" for="a-kind-${i}">Action</label><select class="field" id="a-kind-${i}" data-a="kind" data-i="${i}">${kindOption('move', 'Move')}${mega}${kindOption('switch', 'Switch')}</select></div>
    </div>
    ${a.kind === 'switch'
      ? `<div><label class="lbl" for="a-target-${i}">Switch to</label><select class="field" id="a-target-${i}" data-a="target" data-i="${i}">${options(incoming, a.target, 'Choose…', own)}</select></div>`
      : `<div class="row2">
      <div><label class="lbl" for="a-move-${i}">Move</label><input class="field" id="a-move-${i}" data-a="move" data-i="${i}" list="mv-${i}" value="${esc(a.move)}" placeholder="Move name"><datalist id="mv-${i}">${(set?.moves ?? []).map((m) => `<option value="${esc(m)}">`).join('')}</datalist></div>
      <div><label class="lbl" for="a-target-${i}">Target</label><select class="field" id="a-target-${i}" data-a="target" data-i="${i}">${options(targets, a.target, '—', anyone)}</select></div>
    </div>${pivot}`}
  </div>`;
}

/** Footer buttons; "Add next turn" becomes a disabled "Battle over" once one side has no Pokémon left. */
function footHTML(n: FlowNode): string {
  const result = turnResult(n.id);
  const over = result?.status === 'ready' && result.outcome !== null;
  return `<button class="btn danger" data-act="delete-node">Delete turn${n.children.length ? ' and branches' : ''}</button>${over
    ? '<button class="btn" disabled title="Every Pokémon on one side has fainted">Battle over</button>'
    : '<button class="btn" data-act="add-branch-child">Add next turn</button>'}`;
}

/** Updates only the footer (after an edit changes the turn's result) so focus in the editor isn't lost. */
export function refreshDrawerFoot(): void {
  const foot = document.querySelector('#drawer:not(.hidden) .drawer-foot');
  const found = store.currentNode();
  if (foot && found) foot.innerHTML = footHTML(found.node);
}

/**
 * Keeps a turn's actions in step with the field (see {@link syncTurnActions}); without a simulated state, a first
 * turn at least gets an action for each lead. Returns true when the actions changed.
 */
function syncActions(n: FlowNode, st: BattleState | null, depth: number): boolean {
  let next: TurnAction[];
  if (st) next = syncTurnActions(st, n.actions);
  else if (depth === 1 && store.tab) {
    const tab = store.tab;
    const missing = (['me', 'opp'] as const).flatMap((side) => tab.selection[side].lead
      .filter((m): m is string => !!m && !n.actions.some((a) => a.side === side && a.mon === m))
      .map((mon): TurnAction => ({ side, mon, kind: 'move', move: '', target: '' })));
    next = [...n.actions, ...missing];
  } else return false;
  if (next.length === n.actions.length && next.every((a, i) => a === n.actions[i])) return false;
  n.actions = next;
  return true;
}

export function renderDrawer(): void {
  const drawer = must('#drawer');
  const found = store.currentNode();
  if (!found) { drawer.classList.add('hidden'); return; }
  const n: FlowNode = found.node;
  const st = startStateOf(found.parent?.id);
  if (syncActions(n, st, found.depth)) { store.persist(); rerenderCanvas(); }
  drawer.classList.remove('hidden');
  drawer.innerHTML = `
  <div class="drawer-head"><h3>${esc(n.title || `Turn ${found.depth}`)}</h3><button class="icon-btn" data-act="close-drawer" aria-label="Close editor">✕</button></div>
  <div class="drawer-body">
    <div class="row2">
      <div><label class="lbl" for="d-title">Title</label><input class="field" id="d-title" data-f="title" placeholder="Turn ${found.depth}" value="${esc(n.title)}"></div>
      <div><label class="lbl" for="d-cond">Branch condition</label><input class="field" id="d-cond" data-f="condition" placeholder="e.g. If they Protect" value="${esc(n.condition)}"></div>
    </div>
    <div id="acts">${n.actions.map((a, i) => actionEditor(a, i, st, found.depth, n.actions)).join('') || '<p class="hint">Pick the leads at the top of the plan: each Pokémon on the field gets an action here.</p>'}</div>
    <div><label class="lbl" for="d-note">Notes</label><textarea class="field" id="d-note" data-f="note" rows="4" placeholder="Reasoning, speed tiers, what to watch for…">${esc(n.note)}</textarea></div>
  </div>
  <div class="drawer-foot">${footHTML(n)}</div>`;
}
