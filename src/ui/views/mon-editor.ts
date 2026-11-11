/**
 * The team screen's Pokémon editor: click a card, then change its species, item, ability, nature, moves and Stat
 * Points in fields that suggest names as you type. Every change is written back to the team's Showdown paste at
 * once (see domain/team-edit.ts), so the paste and the cards never disagree.
 */
import { closest, natureText, search } from '../../domain/dex.ts';
import type { Dex } from '../../domain/dex.ts';
import { calcStats, NATURES, STAT_KEYS, STAT_LABEL, statPoints } from '../../domain/stats.ts';
import { toID } from '../../domain/strings.ts';
import { swapSpecies } from '../../domain/team-check.ts';
import type { MonIssue } from '../../domain/team-check.ts';
import { setField, setMove, setSpread, setStatPoints, SP_MAX_STAT, SP_MAX_TOTAL, spOf, spRoom, spTotal } from '../../domain/team-edit.ts';
import type { PokemonSet, StatKey } from '../../domain/types.ts';
import { simService } from '../../state/instance.ts';
import { bindCombobox, typeDot } from '../combobox.ts';
import type { ComboOption } from '../combobox.ts';
import { esc } from '../dom.ts';
import { monIcon } from '../icons.ts';

/** The fields that take a name from the dex. `move0`…`move3` are the four move slots. */
export type EditField = 'species' | 'item' | 'ability' | 'nature' | `move${0 | 1 | 2 | 3}`;

/** One change to the Pokémon being edited. */
export type MonEdit = (mon: PokemonSet) => void;

const FIELD_LABEL: Record<EditField, string> = { species: 'Pokémon', item: 'Item', ability: 'Ability', nature: 'Nature', move0: 'Move 1', move1: 'Move 2', move2: 'Move 3', move3: 'Move 4' };
const KIND_LABEL: Record<EditField, string> = { species: 'Pokémon', item: 'item', ability: 'ability', nature: 'nature', move0: 'move', move1: 'move', move2: 'move', move3: 'move' };

const isMove = (f: string): f is `move${0 | 1 | 2 | 3}` => /^move[0-3]$/.test(f);
const asField = (f: string | undefined): EditField | null => (f && (f in FIELD_LABEL) ? (f as EditField) : null);
const slotOf = (f: `move${0 | 1 | 2 | 3}`): number => Number(f.slice(4));

const valueOf = (mon: PokemonSet, f: EditField): string => (isMove(f) ? mon.moves[slotOf(f)] ?? '' : mon[f]);

/** The change that sets `field` to `value`. A new species keeps what still fits (see swapSpecies). */
export function editFor(field: EditField, value: string): MonEdit {
  return (mon) => {
    if (isMove(field)) setMove(mon, slotOf(field), value);
    else if (field === 'species') swapSpecies(mon, value, simService.dex());
    else setField(mon, field, value);
  };
}

function moveSub(dex: Dex | null, name: string, long = false): string {
  const m = dex?.findMove(name);
  if (!m) return '';
  if (m.category === 'Status') return long ? `${m.type} · Status` : 'Status';
  return long ? `${m.type} · ${m.category} · ${m.bp || '—'}` : `${m.category} ${m.bp || '—'}`;
}

/** The note under a field whose value the dex doesn't know (a typo in the paste), with a fix when one is close. */
function unknownNote(dex: Dex | null, field: EditField, value: string): string {
  if (!dex || !value) return '';
  const known = field === 'species' ? !!dex.findSpecies(value)
    : field === 'item' ? !!dex.findItem(value)
      : field === 'ability' ? dex.hasAbility(value)
        : field === 'nature' ? dex.natures.some((n) => toID(n) === toID(value))
          : !!dex.findMove(value);
  if (known) return '';
  const names = field === 'species' ? dex.species.map((s) => s.name)
    : field === 'item' ? dex.items.map((i) => i.name)
      : field === 'ability' ? dex.abilities
        : field === 'nature' ? dex.natures
          : dex.moves.map((m) => m.name);
  const fix = closest(names, value);
  return `<p class="cb-note">Not a known ${KIND_LABEL[field]}.${fix ? ` Did you mean <button type="button" class="linkish" data-fix="${field}" data-value="${esc(fix)}">${esc(fix)}</button>?` : ''}</p>`;
}

function fieldHTML(dex: Dex | null, mon: PokemonSet, field: EditField): string {
  const value = valueOf(mon, field);
  const note = unknownNote(dex, field, value);
  const id = `mf-${field}`;
  const move = isMove(field);
  const hint = move ? moveSub(dex, value)
    : field === 'nature' && value ? natureText(value)
      : field === 'species' ? (dex?.findSpecies(value)?.types.join(' / ') ?? '') : '';
  return `<div class="cb${note ? ' unknown' : ''}">
    ${move ? '' : `<label class="me-label" for="${id}">${FIELD_LABEL[field]}</label>`}
    <div class="cb-box">${move ? typeDot(dex?.findMove(value)?.type ?? '') : ''}
      <input id="${id}" class="cb-input" data-field="${field}" value="${esc(value)}" data-orig="${esc(value)}"
        role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list" autocomplete="off" spellcheck="false"
        ${move ? `aria-label="${FIELD_LABEL[field]}" placeholder="Add a move"` : ''}>
      ${hint ? `<span class="cb-hint">${esc(hint)}</span>` : ''}
    </div>
    <div class="cb-list" id="${id}-list" role="listbox" aria-label="${esc(FIELD_LABEL[field])} suggestions" hidden></div>
    ${note}</div>`;
}

function statsHTML(dex: Dex | null, mon: PokemonSet): string {
  const sp = spOf(mon);
  const total = spTotal(sp);
  const left = SP_MAX_TOTAL - total;
  const nat = NATURES[mon.nature];
  const base = dex?.findSpecies(mon.species)?.base;
  const final = base ? calcStats(base, sp, mon.nature) : null;
  const converted = statPoints(mon)?.converted;
  const rows = STAT_KEYS.map((k) => {
    const mark = nat?.[0] === k ? 'up' : nat?.[1] === k ? 'down' : '';
    const room = spRoom(sp, k);
    return `<span class="sp-stat ${mark}">${STAT_LABEL[k]}${mark === 'up' ? ' +' : mark === 'down' ? ' −' : ''}</span>
      <button type="button" class="sp-step" id="sp-dec-${k}" data-sp="${k}" data-delta="-1" aria-label="Remove a point from ${STAT_LABEL[k]}"${sp[k] <= 0 ? ' disabled' : ''}>−</button>
      <input class="sp-num" id="sp-${k}" data-sp-input="${k}" type="number" inputmode="numeric" min="0" max="${SP_MAX_STAT}" value="${sp[k]}" aria-label="${STAT_LABEL[k]} Stat Points" title="Type a number from 0 to ${room}">
      <button type="button" class="sp-step" id="sp-inc-${k}" data-sp="${k}" data-delta="1" aria-label="Add a point to ${STAT_LABEL[k]}"${sp[k] >= room ? ` disabled title="${sp[k] >= SP_MAX_STAT ? 'At most 32 in one stat' : 'All 66 points are used: take one from another stat first'}"` : ''}>+</button>
      <input class="sp-range" id="sp-range-${k}" data-sp-range="${k}" type="range" min="0" max="${SP_MAX_STAT}" step="1" value="${sp[k]}" aria-label="${STAT_LABEL[k]} Stat Points slider">
      <span class="sp-final" id="sp-final-${k}">${final ? final[k] : '—'}</span>`;
  }).join('');
  return `<div class="me-col sp-col">
    <div class="sp-head"><span class="me-label">Stat Points</span><span class="spacer"></span>
      <strong class="sp-total${left === 0 ? ' full' : ''}" id="sp-total">${total} / ${SP_MAX_TOTAL}</strong>
      <span class="hint" id="sp-left">${left === 0 ? 'all points used' : `${left} left`}</span></div>
    <div class="sp-meter${left === 0 ? ' full' : ''}" id="sp-meter"><span data-w="${Math.round((total / SP_MAX_TOTAL) * 100)}"></span></div>
    <div class="sp-grid">
      <span class="sp-colhead">Stat</span><span></span><span class="sp-colhead c">SP</span><span></span><span class="sp-colhead">max ${SP_MAX_STAT} each</span><span class="sp-colhead r">Lv 50</span>
      ${rows}
    </div>
    <div class="sp-presets">
      <button type="button" class="btn sm" data-preset="fast">32 / 32 + 2 HP</button>
      <button type="button" class="btn sm ghost" data-preset="clear">Clear</button>
    </div>
    ${converted ? '<p class="hint">This paste had regular EVs; they are shown as Stat Points. Changing a stat writes Stat Points to the paste.</p>' : ''}
    <p class="hint">${mon.nature ? `${esc(mon.nature)} (${esc(natureText(mon.nature))}). ` : ''}Final stats at level 50 with 31 IVs.</p>
  </div>`;
}

/** The editor panel for one Pokémon. On phones it shows as a sheet from the bottom (see mobile.css). */
export function monEditorHTML(mon: PokemonSet, issues: readonly MonIssue[] = []): string {
  const dex = simService.dex();
  const types = dex?.findSpecies(mon.species)?.types ?? [];
  const title = mon.nickname ? `${mon.nickname} (${mon.species})` : mon.species;
  // Unknown names are marked on their own field; the rest (missing moves, Mega Stone, limits) are listed here.
  const listed = issues.filter((i) => !i.text.startsWith('Unknown'));
  return `<div class="me-scrim" data-mon-close></div>
  <section class="mon-editor" id="mon-editor" aria-label="Edit ${esc(title)}">
    <div class="me-head">${monIcon(mon.species)}<div class="me-title"><strong>${esc(title)}</strong>
      <span class="hint">${types.length ? esc(types.join(' / ')) : dex ? '' : 'Loading Pokémon data…'}</span></div>
      <span class="spacer"></span><button type="button" class="btn primary sm" id="me-done" data-mon-close>Done</button></div>
    ${listed.length ? `<ul class="me-issues">${listed.map((i) => `<li>${esc(i.text)}</li>`).join('')}</ul>` : ''}
    <div class="me-body">
      <div class="me-col">
        <div class="me-grid">${(['species', 'item', 'ability', 'nature'] as const).map((f) => fieldHTML(dex, mon, f)).join('')}</div>
        <span class="me-label">Moves</span>
        <div class="me-grid">${([0, 1, 2, 3] as const).map((i) => fieldHTML(dex, mon, `move${i}`)).join('')}</div>
      </div>
      ${statsHTML(dex, mon)}
    </div>
  </section>`;
}

function optionsFor(dex: Dex, mon: PokemonSet, field: EditField, query: string): ComboOption[] {
  if (field === 'species') return search(dex.species, query, (s) => s.name).map((s) => ({ value: s.name, sub: s.types.join(' / ') }));
  if (field === 'item') return search(dex.items, query, (i) => i.name).map((i) => ({ value: i.name, sub: i.megaStone ? 'Mega Stone' : i.berry ? 'Berry' : '' }));
  if (field === 'nature') return search(dex.natures, query, (n) => n, 25).map((n) => ({ value: n, sub: natureText(n) }));
  if (field === 'ability') {
    // The species' own abilities first; the data doesn't list every one, so all others follow.
    const own = dex.findSpecies(mon.species)?.abilities ?? [];
    const ordered = [...own, ...dex.abilities.filter((a) => !own.includes(a))];
    return search(ordered, query, (a) => a).map((a) => ({ value: a, sub: own.includes(a) ? 'Default' : '' }));
  }
  const taken = new Set(mon.moves.filter((_, i) => i !== slotOf(field)).map(toID));
  return search(dex.moves.filter((m) => !taken.has(toID(m.name))), query, (m) => m.name)
    .map((m) => ({ value: m.name, sub: moveSub(dex, m.name, true), type: m.type }));
}

/**
 * Wires the editor: the suggestion lists, Stat Point controls and presets. `commit` applies one change and redraws;
 * `close` hides the editor.
 */
export function bindMonEditor(root: HTMLElement, mon: PokemonSet, commit: (edit: MonEdit) => void, close: () => void): void {
  const editor = root.querySelector<HTMLElement>('#mon-editor');
  if (!editor) return;
  root.querySelectorAll<HTMLElement>('[data-mon-close]').forEach((el) => el.addEventListener('click', close));

  editor.querySelectorAll<HTMLInputElement>('.cb-input').forEach((input) => {
    const field = asField(input.dataset.field);
    const list = root.querySelector<HTMLElement>(`#${input.id}-list`);
    if (!field || !list) return;
    const current = valueOf(mon, field);
    bindCombobox(input, list, {
      current,
      dots: isMove(field),
      options: (query) => {
        const dex = simService.dex();
        if (!dex) return null;
        const opts = optionsFor(dex, mon, field, query);
        // Before anything is typed the list is a long alphabetical one: start it with the current value.
        if (query || !current) return opts;
        const cur = optionsFor(dex, mon, field, current).find((o) => toID(o.value) === toID(current));
        return cur ? [cur, ...opts.filter((o) => toID(o.value) !== toID(current))] : opts;
      },
      load: () => simService.ready(),
      // Leaving a field takes the highlighted suggestion ("stone e" + Tab -> Stone Edge); with none it keeps what was
      // typed, known or not, so a typo never deletes anything.
      pick: (value) => commit(editFor(field, value)),
      escape: close,
    });
  });

  editor.querySelectorAll<HTMLButtonElement>('[data-fix]').forEach((btn) => btn.addEventListener('click', () => {
    const field = asField(btn.dataset.fix);
    if (field && btn.dataset.value) commit(editFor(field, btn.dataset.value));
  }));

  editor.querySelectorAll<HTMLButtonElement>('[data-sp]').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.dataset.sp as StatKey;
    commit((m) => setStatPoints(m, key, spOf(m)[key] + Number(btn.dataset.delta)));
  }));
  /**
   * Shows `value` points in `key` while a slider is dragged or a number typed, before it is saved: the other
   * control, the total and the final stat follow. Returns the value clamped to what fits (32, or the points left).
   */
  const preview = (key: StatKey, value: number, from: 'range' | 'number'): number => {
    const sp = spOf(mon);
    const v = Math.max(0, Math.min(spRoom(sp, key), Math.round(Number.isFinite(value) ? value : 0)));
    sp[key] = v;
    const range = editor.querySelector<HTMLInputElement>(`#sp-range-${key}`);
    const num = editor.querySelector<HTMLInputElement>(`#sp-${key}`);
    if (range && (from === 'number' || Number(range.value) !== v)) range.value = String(v);
    if (num && from === 'range') num.value = String(v);
    const total = spTotal(sp);
    const left = SP_MAX_TOTAL - total;
    const totalEl = editor.querySelector('#sp-total');
    if (totalEl) { totalEl.textContent = `${total} / ${SP_MAX_TOTAL}`; totalEl.classList.toggle('full', left === 0); }
    const leftEl = editor.querySelector('#sp-left');
    if (leftEl) leftEl.textContent = left === 0 ? 'all points used' : `${left} left`;
    const meter = editor.querySelector<HTMLElement>('#sp-meter');
    if (meter) {
      meter.classList.toggle('full', left === 0);
      const bar = meter.querySelector<HTMLElement>('span');
      if (bar) bar.style.width = `${Math.round((total / SP_MAX_TOTAL) * 100)}%`;
    }
    const base = simService.dex()?.findSpecies(mon.species)?.base;
    const finalEl = editor.querySelector(`#sp-final-${key}`);
    if (base && finalEl) finalEl.textContent = String(calcStats(base, sp, mon.nature)[key]);
    return v;
  };

  editor.querySelectorAll<HTMLInputElement>('[data-sp-range]').forEach((range) => {
    const key = range.dataset.spRange as StatKey;
    // While dragging: the thumb stops where the points run out. On release (or each arrow key): saved.
    range.addEventListener('input', () => { preview(key, Number(range.value), 'range'); });
    range.addEventListener('change', () => {
      const v = preview(key, Number(range.value), 'range');
      commit((m) => setStatPoints(m, key, v));
    });
  });

  editor.querySelectorAll<HTMLInputElement>('[data-sp-input]').forEach((input) => {
    const key = input.dataset.spInput as StatKey;
    const save = (): void => {
      if (input.value.trim() === '') input.value = '0';
      const v = preview(key, Number(input.value), 'number');
      input.value = String(v);
      // Enter then leaving the box would save twice: only a new value is saved.
      if (v === Number(input.dataset.saved ?? spOf(mon)[key])) return;
      input.dataset.saved = String(v);
      commit((m) => setStatPoints(m, key, v));
    };
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => { if (input.value.trim() !== '') preview(key, Number(input.value), 'number'); });
    input.addEventListener('change', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  });

  editor.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.preset === 'clear') { commit((m) => setSpread(m, {})); return; }
    const base = simService.dex()?.findSpecies(mon.species)?.base;
    const attack: StatKey = base && base.spa > base.atk ? 'spa' : 'atk';
    commit((m) => setSpread(m, { hp: 2, [attack]: 32, spe: 32 }));
  }));

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement && e.target.classList.contains('cb-input'))) close();
  });
}
