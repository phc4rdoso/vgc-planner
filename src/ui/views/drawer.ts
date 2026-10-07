import { monsFor } from '../../domain/model.ts';
import type { BattleState } from '../../domain/simulation/state.ts';
import { bench, canMegaEvolve, fieldAfterReplacements, syncTurnActions } from '../../domain/simulation/state.ts';
import { CHANCE_EFFECTS, chanceEffects, hasMoveData, PIVOT_MOVES, PROTECT_FAMILY } from '../../domain/simulation/tables.ts';
import { toID } from '../../domain/strings.ts';
import type { FlowNode, Side, TurnAction } from '../../domain/types.ts';
import { TARGET_KEYWORDS } from '../../domain/types.ts';
import { simService, store } from '../../state/instance.ts';
import { esc, must } from '../dom.ts';
import { monIcon } from '../icons.ts';
import { formOf } from '../names.ts';
import { startStateOf, turnResult } from '../turn-results.ts';
import { rerenderCanvas } from './plan-view.ts';
import { lockedAction, mayBeForcedOut, moveLock } from '../../domain/simulation/turn.ts';

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

const CANT_OPTIONS: readonly [string, string][] = [
  ['', 'Moves as expected'], ['par', 'Fully paralysed'], ['slp', 'Still asleep'], ['frz', 'Frozen solid'],
  ['confusion', 'Hit itself in confusion'], ['flinch', 'Flinched'], ['wake', 'Woke up / thawed / snapped out of confusion'],
];
const EFFECT_NAME: Readonly<Record<string, string>> = {
  flinch: 'Flinch', brn: 'Burn', par: 'Paralysis', psn: 'Poison', tox: 'Bad poison', slp: 'Sleep', frz: 'Freeze', confusion: 'Confusion',
};
const STAT_SHORT: Readonly<Record<string, string>> = { atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
/** "spd-1" → "−1 SpD", "atk+1,def+1" → "+1 Atk, +1 Def", "brn" → "Burn". */
const effectLabel = (fx: string): string => EFFECT_NAME[fx]
  ?? fx.split(',').map((p) => { const m = /^(\w+)([+-])(\d)$/.exec(p); return m ? `${m[2] === '+' ? '+' : '−'}${m[3]} ${STAT_SHORT[m[1]!] ?? m[1]}` : p; }).join(', ');
const effectSelect = (kind: 'effect' | 'self', i: number, name: string, options: readonly string[], value: string, label: string): string =>
  `<select class="field sm" data-o="${kind}" data-t="${esc(name)}" data-i="${i}" aria-label="${esc(label)}"><option value="">No added effect</option>${
    options.map((fx) => `<option value="${esc(fx)}" ${fx === value ? 'selected' : ''}>${esc(effectLabel(fx))}</option>`).join('')}</select>`;

/** Who a move's chance results can be about: its target(s), as far as the editor can tell. */
function outcomeTargets(a: TurnAction, st: BattleState | null, depth: number, actions: readonly TurnAction[], target: string): string[] {
  const foe: Side = a.side === 'me' ? 'opp' : 'me';
  const onField = (side: Side): string[] => {
    if (st) return fieldAfterReplacements(st, actions)[side];
    if (depth === 1) return (store.tab?.selection[side].lead ?? []).filter((n): n is string => !!n);
    return [];
  };
  if (target === 'allAdjacentFoes' || a.target === 'Both foes') return onField(foe);
  if (target === 'allAdjacent' || a.target === 'All') return [...onField(foe), ...onField(a.side).filter((n) => n !== a.mon)];
  if (target === 'self' || a.target === 'Self' || !a.target) return [];
  if (a.target === 'Ally') return onField(a.side).filter((n) => n !== a.mon);
  return [a.target];
}

/**
 * "Chance results" for a move action: what kept it from moving (or it woke up), and per target a miss, a critical
 * hit, the chance effect it caused, and the HP left afterwards. Filled in by hand or by a replay import.
 */
function outcomeEditor(a: TurnAction, i: number, st: BattleState | null, depth: number, actions: readonly TurnAction[]): string {
  if (a.kind === 'switch' || !a.mon) return '';
  const info = simService.moveInfo(a.move);
  const o = a.outcome ?? {};
  const cant = o.wake ? 'wake' : o.cant ?? '';
  const damaging = !!info && info.category !== 'Status';
  // The move's own possible chance effects (from the generated move data); any condition or drop if it isn't known.
  const known = chanceEffects(toID(a.move));
  const targetOptions = known.target.length ? known.target : info?.secondaries && !hasMoveData(toID(a.move)) ? CHANCE_EFFECTS : [];
  const sideOf = (name: string): Side => (st?.mons.opp[name] && !st.mons.me[name] ? 'opp' : st?.mons.me[name] && !st.mons.opp[name] ? 'me' : a.side === 'me' ? 'opp' : 'me');
  const rows = a.move ? outcomeTargets(a, st, depth, actions, info?.target ?? '').map((name) => {
    const t = o.targets?.[name] ?? {};
    const effect = t.effects?.[0] ?? '';
    const effects = damaging && targetOptions.length ? effectSelect('effect', i, name, targetOptions, effect, `Added effect on ${name}`) : '';
    const crit = damaging ? `<label class="oc-check"><input type="checkbox" data-o="crit" data-t="${esc(name)}" data-i="${i}" ${t.crit ? 'checked' : ''}>Crit</label>` : '';
    const hp = damaging
      ? `<label class="oc-check" title="HP left after this hit, in percent. Leave empty to use the calculator's average roll.">HP left
          <input class="field sm oc-hp" type="number" min="0" max="100" step="0.1" data-o="hp" data-t="${esc(name)}" data-i="${i}" value="${t.hp ?? ''}" placeholder="avg" aria-label="${esc(`HP of ${name} left after this hit, in percent`)}">%</label>`
      : '';
    return `<div class="oc-row"><span class="oc-name">${esc(formOf(st, sideOf(name), name))}</span>
      <label class="oc-check"><input type="checkbox" data-o="miss" data-t="${esc(name)}" data-i="${i}" ${t.miss ? 'checked' : ''}>Miss</label>${crit}${effects}${hp}</div>`;
  }).join('') : '';
  const hits = info?.multihit ? `<label class="oc-check">Hits <input class="field sm oc-hits" type="number" min="1" max="10" data-o="hits" data-i="${i}" value="${o.hits ?? ''}"></label>` : '';
  const protect = PROTECT_FAMILY.has(toID(a.move))
    ? `<label class="oc-check"><input type="checkbox" data-o="protectWorks" data-i="${i}" ${o.protectWorks ? 'checked' : ''}>Works even right after another Protect</label>` : '';
  const self = damaging && known.self.length
    ? `<label class="oc-check">Self ${effectSelect('self', i, a.mon, known.self, o.self?.[0] ?? '', `Added effect on ${a.mon} itself`)}</label>` : '';
  const set = Object.keys(o).length > 0;
  const cantSelect = `<select class="field sm" data-o="cant" data-i="${i}" aria-label="Before moving">${CANT_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === cant ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return `<details class="outcome"${set ? ' open' : ''}><summary>Chance results${set ? ' <span class="oc-dot" aria-label="set"></span>' : ''}</summary>
    ${cantSelect}${hits}${protect}${self}${rows}
    ${!info && a.move ? '<p class="hint">Move details appear once the calculator has loaded.</p>' : ''}
  </details>`;
}

/**
 * "Speed ties": for each pair of Pokémon whose order came down to equal Speed this turn, who moves first. The game
 * flips a coin; unless picked here, the first action listed is assumed to win.
 */
function tieEditor(n: FlowNode, st: BattleState | null): string {
  const r = turnResult(n.id);
  if (r?.status !== 'ready' || !r.ties.length) return '';
  const label = (key: string): string => {
    const [side, name] = key.split(':') as [Side, string];
    return `${formOf(st, side, name)} (${side === 'me' ? 'you' : 'opp'})`;
  };
  const rows = r.ties.map((t) => {
    const pair = t.keys.join('|');
    const option = (key: string): string => `<option value="${esc(key)}" ${t.first === key ? 'selected' : ''}>${esc(label(key))} moves first${t.picked || t.first !== key ? '' : ' (assumed)'}</option>`;
    return `<div class="oc-row"><span class="oc-name">Speed ${t.speed}</span><select class="field sm" data-tie="${esc(pair)}" aria-label="${esc(`Who wins the speed tie between ${label(t.keys[0])} and ${label(t.keys[1])}`)}">${option(t.keys[0])}${option(t.keys[1])}</select></div>`;
  }).join('');
  return `<div class="tie-edit"><span class="lbl">Speed ties</span><p class="hint">Equal Speed: the game decides with a 50/50. Pick who moves first to plan each case.</p>${rows}</div>`;
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
  // Who comes in after a pivot move, or if an Eject Button / Eject Pack / Red Card / Emergency Exit forces it out.
  const starter = st?.mons[a.side][a.mon];
  const forcible = !!starter && !!st && st.active[a.side].includes(a.mon) && mayBeForcedOut(st, a.side, starter);
  const pivotLabel = isPivotMove(a.move) ? 'Then switch to' : 'If forced out, switch to';
  const pivot = a.kind !== 'switch' && (isPivotMove(a.move) || forcible)
    ? `<div><label class="lbl" for="a-pivot-${i}">${pivotLabel}</label><select class="field" id="a-pivot-${i}" data-a="pivot" data-i="${i}">${options(incoming, a.pivot ?? '', 'Choose…', own)}</select></div>`
    : '';
  const head = `<div class="act-top"><span class="side-tag ${a.side}">${a.side === 'me' ? 'You' : 'Opponent'}</span></div>`;
  // Charging a two-turn move or recharging after Hyper Beam: no move or switch to pick this turn.
  const current = st?.mons[a.side][a.mon];
  const locked = current && st?.active[a.side].includes(a.mon) ? lockedAction(current) : null;
  if (locked) {
    return `<div class="act-edit ${a.side}" data-i="${i}">${head}
    <div class="row2">${monField(a, i, st, actions)}<div><span class="lbl">Action</span><div class="act-locked">${esc(locked)}</div></div></div>
    <div class="hint">It can't choose a move or switch out this turn.</div>
  </div>`;
  }
  // Only the moves in the paste (plus a move already saved that isn't there, so nothing is lost silently).
  // Encore or a Choice item: only that move (it can still switch out).
  const lock = current && st?.active[a.side].includes(a.mon) ? moveLock(st, current) : null;
  const known = lock ? [lock.move] : set?.moves ?? [];
  const moveList = a.move && !known.some((m) => m.toLowerCase() === a.move.toLowerCase()) ? [...known, a.move] : known;
  const lockNote = lock ? `<div class="hint">Locked into ${esc(lock.move)} by ${esc(lock.reason)}: it can use only that move, or switch out.</div>` : '';
  const moveField = known.length
    ? `<select class="field" id="a-move-${i}" data-a="move" data-i="${i}">${options(moveList, a.move, 'Choose…', (v) => (known.includes(v) ? v : `${v} (not in the paste)`))}</select>`
    : `<input class="field" id="a-move-${i}" data-a="move" data-i="${i}" value="${esc(a.move)}" placeholder="Move name">`;
  return `<div class="act-edit ${a.side}" data-i="${i}">
    ${head}
    <div class="row2">
      ${monField(a, i, st, actions)}
      <div><label class="lbl" for="a-kind-${i}">Action</label><select class="field" id="a-kind-${i}" data-a="kind" data-i="${i}">${kindOption('move', 'Move')}${mega}${kindOption('switch', 'Switch')}</select></div>
    </div>
    ${a.kind === 'switch'
      ? `<div><label class="lbl" for="a-target-${i}">Switch to</label><select class="field" id="a-target-${i}" data-a="target" data-i="${i}">${options(incoming, a.target, 'Choose…', own)}</select></div>`
      : `<div class="row2">
      <div><label class="lbl" for="a-move-${i}">Move</label>${moveField}</div>
      <div><label class="lbl" for="a-target-${i}">Target</label><select class="field" id="a-target-${i}" data-a="target" data-i="${i}">${options(targets, a.target, '—', anyone)}</select></div>
    </div>${lockNote}${pivot}${outcomeEditor(a, i, st, depth, actions)}`}
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
    ${tieEditor(n, st)}
    <div><label class="lbl" for="d-note">Notes</label><textarea class="field" id="d-note" data-f="note" rows="4" placeholder="Reasoning, speed tiers, what to watch for…">${esc(n.note)}</textarea></div>
  </div>
  <div class="drawer-foot">${footHTML(n)}</div>`;
}
