import { cleanSelections, countPlanTurns, oppMons, teamMons } from '../../domain/model.ts';
import { applyRenames, describeUses, planImpact } from '../../domain/plan-refs.ts';
import type { PlanImpact } from '../../domain/plan-refs.ts';
import { REGULATION } from '../../domain/regulation.ts';
import { parseShowdown, teamWarnings } from '../../domain/showdown.ts';
import { search } from '../../domain/dex.ts';
import { spreadText, statPoints } from '../../domain/stats.ts';
import { teamIssues } from '../../domain/team-check.ts';
import type { MonIssue } from '../../domain/team-check.ts';
import { addMon, blankMon, duplicateMon, editMon, moveMon, removeMon } from '../../domain/team-edit.ts';
import type { PokemonSet, Team } from '../../domain/types.ts';
import { simService, store } from '../../state/instance.ts';
import { requestRender } from '../bus.ts';
import { bindCombobox } from '../combobox.ts';
import { applyDynamicStyles, esc, must } from '../dom.ts';
import { itemIcon, monIcon } from '../icons.ts';
import { modal, openMenu, toast, toastAction } from '../overlays.ts';
import { PASTE_LINK_HINT } from '../paste-links.ts';
import { NAV_BUTTON, renderNav } from './sidebar.ts';
import { extLinksHTML } from '../ext-links.ts';
import { bindMonEditor, monEditorHTML } from './mon-editor.ts';
import type { MonEdit } from './mon-editor.ts';

/** The team as it was before a change: what Undo puts back (gameplans too, since a change can update them). */
interface Snapshot { paste: string; plans: string; editing: number | null }

/**
 * What the team screen shows besides the team itself: which Pokémon is open in the editor, whether the paste box
 * is open, when the last change was saved, and the changes Undo can take back. Kept for this visit only.
 */
const view: { teamId: string | null; editing: number | null; pasteOpen: boolean; savedAt: number; undo: Snapshot[] } = {
  teamId: null, editing: null, pasteOpen: false, savedAt: 0, undo: [],
};
const UNDO_LIMIT = 30;

const ICON_WARN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5"/><path d="M12 18h.01"/></svg>';
const ICON_UP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>';
const ICON_DOWN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg>';
const ICON_MORE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

/** A team member's card, with its ⋯ menu and (on phones, where cards can't be dragged) up/down arrows. */
function monCard(m: PokemonSet, i: number, count: number, editing: boolean, issues: readonly MonIssue[]): string {
  const first = i === 0;
  const last = i === count - 1;
  const sp = statPoints(m);
  const name = m.nickname ? `${m.nickname} (${m.species})` : m.species;
  const shown = issues.slice(0, 2);
  return `<div class="mon-slot" data-slot="${i}" draggable="true">
    <button type="button" class="mon-card${editing ? ' editing' : ''}${issues.length ? ' has-issues' : ''}" id="mon-card-${i}" data-mon-edit="${i}" aria-expanded="${editing}" aria-controls="mon-editor"
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" title="${editing ? 'Close the editor' : `Edit ${esc(m.species)}`} (Alt+arrows move it)">${monIcon(m.species)}<span class="meta">
      <span class="sp">${esc(name)}${editing ? ' <span class="chip">Editing</span>' : ''}</span>
      <span class="sub">${m.item ? itemIcon(m.item, 'xs') + esc(m.item) : '<span class="muted">No item</span>'}</span>
      ${m.ability ? `<span class="sub">${esc(m.ability)}</span>` : ''}
      ${sp ? `<span class="sub" title="Champions Stat Points (max 32 per stat, 66 total)">SP ${esc(spreadText(sp.sp))}${sp.converted ? ' (from EVs)' : ''}</span>` : ''}
      ${m.moves.length ? `<span class="moves">${m.moves.map(esc).join(' · ')}</span>` : ''}
      ${shown.map((x) => `<span class="issue">${ICON_WARN}${esc(x.text)}</span>`).join('')}
      ${issues.length > shown.length ? `<span class="issue more">+${issues.length - shown.length} more</span>` : ''}</span></button>
    <button type="button" class="mon-more" id="mon-more-${i}" data-mon-menu="${i}" aria-label="More actions for ${esc(name)}" aria-haspopup="menu">${ICON_MORE}</button>
    <span class="mon-arrows">
      <button type="button" class="mon-arrow" id="mon-up-${i}" data-mon-move="${i}" data-dir="up" aria-label="Move ${esc(name)} up"${first ? ' disabled' : ''}>${ICON_UP}</button>
      <button type="button" class="mon-arrow" id="mon-down-${i}" data-mon-move="${i}" data-dir="down" aria-label="Move ${esc(name)} down"${last ? ' disabled' : ''}>${ICON_DOWN}</button>
    </span>
  </div>`;
}

/** The box that adds a team member; on an empty team it is the first thing to fill, and says so. */
const addSlot = (count: number): string => `<div class="mon-add${count ? '' : ' first'}">
  <label class="me-label" for="add-mon">${count ? 'Add a Pokémon' : 'Add your first Pokémon'}</label>
  <div class="cb-box"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
    <input id="add-mon" class="cb-input" data-orig="" placeholder="Type a name…" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="add-mon-list" autocomplete="off" spellcheck="false"></div>
  <div class="cb-list" id="add-mon-list" role="listbox" aria-label="Pokémon suggestions" hidden></div></div>`;

/** Redraws the app, keeping focus on the same control (ids are stable across redraws). */
function redrawKeepingFocus(focusId?: string): void {
  const id = focusId ?? (document.activeElement instanceof HTMLElement ? document.activeElement.id : '');
  requestRender();
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  document.body.dataset.restoringFocus = '1';
  try {
    el.focus({ preventScroll: true });
    // A name field comes back with its text selected, as when clicked into, so typing replaces it.
    if (el instanceof HTMLInputElement && el.classList.contains('cb-input')) el.select();
  } finally { delete document.body.dataset.restoringFocus; }
}

/**
 * Applies one change to the team (its paste, and the gameplans when asked), after remembering how it was so Undo
 * can put it back. Plan picks of Pokémon no longer on the team are cleared, as with "Update team".
 */
function change(team: Team, apply: () => void): PokemonSet[] {
  view.undo.push({ paste: team.paste, plans: JSON.stringify(team.plans), editing: view.editing });
  if (view.undo.length > UNDO_LIMIT) view.undo.shift();
  apply();
  const parsed = parseShowdown(team.paste);
  cleanSelections(team.plans, 'me', parsed);
  store.persist();
  view.savedAt = Date.now();
  return parsed;
}

function undo(team: Team): void {
  const snap = view.undo.pop();
  if (!snap) return;
  team.paste = snap.paste;
  team.plans.splice(0, team.plans.length, ...(JSON.parse(snap.plans) as Team['plans']));
  store.persist();
  view.savedAt = Date.now();
  // The editor goes back to the Pokémon it was on before the change.
  view.editing = snap.editing !== null && teamMons(team)[snap.editing] ? snap.editing : null;
  redrawKeepingFocus();
  toast('Change undone');
}

type PlanChoice = 'update' | 'keep';

/** One line per thing the gameplans would lose, for the dialog. */
function impactLines(impact: PlanImpact): string[] {
  return [
    ...impact.renames.map((r) => (r.kind === 'mon'
      ? `${r.from} → ${r.to}: used in ${describeUses(r.uses)}`
      : `${r.species}'s ${r.from} → ${r.to}: used in ${describeUses(r.uses)}`)),
    ...impact.losses.map((l) => (l.kind === 'mon'
      ? `${l.name} leaves the team: used in ${describeUses(l.uses)}`
      : `${l.species} no longer has ${l.name}: used in ${describeUses(l.uses)}`)),
  ];
}

/**
 * Before a change (one edit, removing a Pokémon, or a new paste) leaves the gameplans pointing at something the
 * team no longer has, asks what to do: carry renamed Pokémon and moves over to the plans, change the team only, or
 * cancel. Resolves to the plan update to make (possibly nothing), or null to cancel.
 */
async function confirmPlanImpact(team: Team, before: readonly PokemonSet[], after: readonly PokemonSet[]): Promise<(() => void) | null> {
  const impact = planImpact(before, after, team.plans);
  const count = impact.renames.length + impact.losses.length;
  if (!count) return () => {};
  const [rename] = impact.renames;
  const [loss] = impact.losses;
  const single = count === 1;
  const title = single && rename ? `${rename.from} is in your gameplans`
    : single && loss ? (loss.kind === 'mon' ? `Remove ${loss.name}?` : `${loss.name} is in your gameplans`)
      : 'This changes your gameplans';
  const desc = single && rename ? `${rename.kind === 'move' ? `${rename.species} uses it` : 'It\'s used'} in ${describeUses(rename.uses)}. Should ${rename.kind === 'move' ? 'those turns' : 'those gameplans'} use ${rename.to} instead?`
    : single && loss ? `${loss.kind === 'move' ? `${loss.species} uses it` : 'It\'s used'} in ${describeUses(loss.uses)}. Those turns will keep pointing at ${loss.kind === 'mon' ? 'a Pokémon the team' : 'a move it'} no longer has.`
      : impact.renames.length ? 'Renamed Pokémon and moves can be carried over to the gameplans. Turns that use something removed keep pointing at it.' : 'Turns that use these keep pointing at something the team no longer has.';
  const body = single ? '' : `<ul class="impact-list">${impactLines(impact).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
  const actions = impact.renames.length
    ? [{ label: 'Cancel', value: null }, { label: 'Change the team only', value: 'keep' as const }, { label: single && rename ? `Use ${rename.to} in gameplans` : 'Update gameplans too', cls: 'primary', value: 'update' as const }]
    : [{ label: 'Cancel', value: null }, { label: single && loss?.kind === 'mon' ? 'Remove' : 'Change anyway', cls: 'primary danger-fill', value: 'keep' as const }];
  const choice = await modal<PlanChoice>({ title, desc, body, actions });
  if (!choice) return null;
  return choice === 'update' ? () => applyRenames(team.plans, impact.renames) : () => {};
}

async function removeMember(team: Team, index: number): Promise<void> {
  const mons = teamMons(team);
  const mon = mons[index];
  if (!mon) return;
  const update = await confirmPlanImpact(team, mons, mons.filter((_, i) => i !== index));
  if (!update) return;
  change(team, () => { team.paste = removeMon(team.paste, index); update(); });
  if (view.editing === index) view.editing = null;
  else if (view.editing !== null && view.editing > index) view.editing--;
  requestRender();
  toastAction(`${mon.species} removed`, 'Undo', () => undo(team));
}

/**
 * Moves a team member from one position to another, keeping the editor on the same Pokémon. `focus` says what has
 * focus afterwards: its card, or the arrow that moved it (the other arrow once it reaches the end), or nothing.
 */
function reorder(team: Team, from: number, to: number, focus: 'card' | 'up' | 'down' | null = 'card'): void {
  const count = teamMons(team).length;
  const target = Math.max(0, Math.min(count - 1, to));
  if (target === from) return;
  change(team, () => { team.paste = moveMon(team.paste, from, target); });
  if (view.editing === from) view.editing = target;
  else if (view.editing !== null) {
    if (from < view.editing && target >= view.editing) view.editing--;
    else if (from > view.editing && target <= view.editing) view.editing++;
  }
  const last = count - 1;
  const arrow = focus === 'up' ? (target > 0 ? 'up' : 'down') : focus === 'down' ? (target < last ? 'down' : 'up') : null;
  redrawKeepingFocus(arrow ? `mon-${arrow}-${target}` : focus === 'card' ? `mon-card-${target}` : undefined);
}

let undoKeyInstalled = false;
/** Ctrl+Z / Cmd+Z on the team screen undoes the last change, unless a text box has focus (it has its own undo). */
function installUndoKey(): void {
  if (undoKeyInstalled) return;
  undoKeyInstalled = true;
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'button') return;
    if (t instanceof HTMLTextAreaElement || document.querySelector('.overlay')) return;
    const button = document.getElementById('undo-team');
    if (button instanceof HTMLButtonElement && !button.disabled) { e.preventDefault(); button.click(); }
  });
}

export function renderTeamView(main: HTMLElement, team: Team): void {
  installUndoKey();
  // Redrawing the same team (an edit, opening the editor) keeps the page where it was scrolled.
  const scrollTop = view.teamId === team.id ? (main.querySelector('.page')?.scrollTop ?? 0) : 0;
  if (view.teamId !== team.id) Object.assign(view, { teamId: team.id, editing: null, pasteOpen: false, savedAt: 0, undo: [] });
  const mons = teamMons(team);
  if (view.editing !== null && !mons[view.editing]) view.editing = null;
  const editing = view.editing;
  const issues = teamIssues(mons, simService.dex());
  const tooMany = mons.length > REGULATION.teamSize ? `<div class="warn">This team has ${mons.length} Pokémon; a team has at most ${REGULATION.teamSize}.</div>` : '';
  // A team with no Pokémon yet can still start from a paste, so the box is open then.
  const pasteOpen = view.pasteOpen;
  const size = REGULATION.teamSize;
  // The places still free after the Add box, so an empty or part-built team shows how much room is left.
  const empties = Array.from({ length: Math.max(0, size - mons.length - 1) }, (_, i) => `<div class="mon-empty" aria-hidden="true">Pokémon ${mons.length + i + 2}</div>`).join('');
  const saved = view.savedAt ? `<span class="saved-note" role="status"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Saved</span>` : '';
  main.innerHTML = `
  <div class="topbar">${NAV_BUTTON}<input class="title-input" id="team-name" value="${esc(team.name)}" aria-label="Team name">
    <span class="chip">${esc(REGULATION.label)}</span><span class="spacer"></span>
    <button class="btn" data-act="export-team" data-team="${esc(team.id)}">Export team</button>
    <button class="btn danger" data-act="delete-team" data-team="${esc(team.id)}">Delete</button><div class="d-only">${extLinksHTML()}</div></div>
  <div class="page"><div class="page-inner">
    <div class="section"><div class="section-head"><h3>Team</h3>
        <span class="hint">${mons.length ? `${mons.length} of ${size} · Click a Pokémon to edit it, or drag to reorder` : `Empty: add up to ${size} Pokémon`}</span><span class="spacer"></span>${saved}
        <button class="btn sm ghost" id="undo-team"${view.undo.length ? '' : ' disabled'} title="Undo the last change (Ctrl+Z)">Undo</button>
        <button class="btn sm" id="toggle-paste" aria-expanded="${pasteOpen}" aria-controls="paste-box">${pasteOpen ? 'Hide paste' : mons.length ? 'Edit as text' : '<span class="d-only">Paste a team instead</span><span class="m-only">Paste instead</span>'}</button></div>
      ${tooMany}
      <div class="mon-grid">${mons.map((m, i) => monCard(m, i, mons.length, i === editing, issues[i] ?? [])).join('')}${mons.length < size ? addSlot(mons.length) + empties : ''}</div>
      ${mons.length ? '' : '<p class="hint mt-s">Pick a Pokémon, then click its card to set its item, ability, nature, moves and Stat Points.</p>'}
      ${editing !== null ? monEditorHTML(mons[editing]!, issues[editing]) : ''}
      ${pasteOpen ? `<div class="paste-box" id="paste-box">
        <div class="paste-head"><label class="me-label" for="team-paste">Showdown paste</label>
          <span class="hint">${mons.length ? 'Updates as you edit the Pokémon above. To change many at once, edit here and press Update team.' : `Paste a whole team in Showdown format, ${PASTE_LINK_HINT}.`}</span>
          <span class="spacer"></span><button class="btn primary sm" id="save-paste">Update team</button></div>
        <textarea class="paste" id="team-paste" data-team-paste placeholder="Paste your team in Showdown format, ${PASTE_LINK_HINT}">${esc(team.paste)}</textarea></div>` : ''}
    </div>
    <div class="section"><div class="section-head"><h3>Gameplans</h3>
      <button class="btn primary sm" data-act="new-plan" data-team="${esc(team.id)}"${mons.length ? '' : ' disabled title="Add your Pokémon first"'}>New gameplan</button></div>
      ${team.plans.length ? `<div class="plan-list">${team.plans.map((p) => {
        const turns = countPlanTurns(p);
        const tabs = p.tabs.length;
        return `<div class="plan-card" data-act="open-plan" data-team="${esc(team.id)}" data-plan="${esc(p.id)}" tabindex="0" role="button">
          <span class="nm">${esc(p.name)}</span>
          <span class="icon-row">${oppMons(p).map((m) => monIcon(m.species, 'sm')).join('')}</span>
          <span class="muted">${tabs > 1 ? `${tabs} tabs · ` : ''}${turns} turn${turns === 1 ? '' : 's'}</span></div>`;
      }).join('')}</div>` : `<p class="hint">${mons.length ? 'No gameplans yet. Create one for each opponent team you want to prepare for.' : 'Add your Pokémon first: a gameplan picks its leads and backs from them.'}</p>`}
    </div></div></div>`;
  applyDynamicStyles(main);
  const page = main.querySelector('.page');
  if (page && scrollTop) page.scrollTop = scrollTop;

  // The names behind suggestions, types and checks load in the background; redraw once they are in.
  if (!simService.dex()) simService.ready().then(() => { if (store.team?.id === team.id && !store.plan) redrawKeepingFocus(); }).catch(() => {});

  must<HTMLInputElement>('#team-name').addEventListener('input', (e) => {
    team.name = (e.target as HTMLInputElement).value;
    store.persist();
    renderNav();
  });

  main.querySelectorAll<HTMLButtonElement>('[data-mon-edit]').forEach((card) => {
    const i = Number(card.dataset.monEdit);
    card.addEventListener('click', () => {
      view.editing = view.editing === i ? null : i;
      requestRender();
      if (view.editing === null) document.getElementById(`mon-card-${i}`)?.focus();
      else document.getElementById('mon-editor')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    card.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); reorder(team, i, i - 1); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); reorder(team, i, i + 1); }
    });
  });

  main.querySelectorAll<HTMLButtonElement>('[data-mon-menu]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = Number(btn.dataset.monMenu);
    const full = mons.length >= REGULATION.teamSize;
    openMenu(btn, [
      { label: view.editing === i ? 'Close editor' : 'Edit', run: () => { view.editing = view.editing === i ? null : i; requestRender(); } },
      ...(i > 0 ? [{ label: 'Move earlier', run: () => reorder(team, i, i - 1, null) }] : []),
      ...(i < mons.length - 1 ? [{ label: 'Move later', run: () => reorder(team, i, i + 1, null) }] : []),
      ...(full ? [] : [{ label: 'Duplicate', run: () => { change(team, () => { team.paste = duplicateMon(team.paste, i); }); view.editing = i + 1; requestRender(); } }]),
      '-',
      { label: 'Remove from team', cls: 'danger', run: () => { void removeMember(team, i); } },
    ]);
  }));

  // Phones: the arrows on each card move it up or down.
  main.querySelectorAll<HTMLButtonElement>('[data-mon-move]').forEach((btn) => btn.addEventListener('click', () => {
    const i = Number(btn.dataset.monMove);
    const up = btn.dataset.dir === 'up';
    reorder(team, i, up ? i - 1 : i + 1, up ? 'up' : 'down');
  }));

  // Drag a card onto another to move it there.
  let dragFrom: number | null = null;
  main.querySelectorAll<HTMLElement>('.mon-slot').forEach((slot) => {
    const i = Number(slot.dataset.slot);
    slot.addEventListener('dragstart', (e) => {
      dragFrom = i;
      slot.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', String(i));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    slot.addEventListener('dragend', () => { dragFrom = null; main.querySelectorAll('.mon-slot').forEach((s) => s.classList.remove('dragging', 'drop-target')); });
    slot.addEventListener('dragover', (e) => {
      if (dragFrom === null || dragFrom === i) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      slot.classList.add('drop-target');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('drop-target'));
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragFrom !== null && dragFrom !== i) reorder(team, dragFrom, i, null);
      dragFrom = null;
    });
  });

  const addInput = document.getElementById('add-mon');
  const addList = document.getElementById('add-mon-list');
  if (addInput instanceof HTMLInputElement && addList) {
    bindCombobox(addInput, addList, {
      onBlur: 'option',
      options: (query) => {
        const dex = simService.dex();
        return dex ? search(dex.species, query, (s) => s.name).map((s) => ({ value: s.name, sub: s.types.join(' / ') })) : null;
      },
      load: () => simService.ready(),
      pick: (species) => {
        const ability = simService.dex()?.findSpecies(species)?.abilities[0] ?? '';
        change(team, () => { team.paste = addMon(team.paste, blankMon(species, ability)); });
        view.editing = teamMons(team).length - 1;
        // Straight on to its item; the new card opens in the editor.
        setTimeout(() => redrawKeepingFocus('mf-item'), 0);
      },
      escape: () => addInput.blur(),
    });
  }

  if (editing !== null) {
    const commit = (edit: MonEdit): void => {
      void (async () => {
        const current = teamMons(team);
        if (!current[editing]) return;
        const next = structuredClone(current);
        edit(next[editing]!);
        const updatePlans = await confirmPlanImpact(team, current, next);
        if (!updatePlans) { redrawKeepingFocus(); return; }
        change(team, () => {
          team.paste = editMon(team.paste, editing, edit);
          updatePlans();
        });
        // After the browser has moved focus (Tab out of a field commits it), so the redraw keeps it where it went.
        setTimeout(redrawKeepingFocus, 0);
      })();
    };
    const close = (): void => {
      view.editing = null;
      requestRender();
      document.getElementById(`mon-card-${editing}`)?.focus();
    };
    bindMonEditor(main, mons[editing]!, commit, close);
  }

  document.getElementById('undo-team')?.addEventListener('click', () => undo(team));

  document.getElementById('toggle-paste')?.addEventListener('click', () => {
    view.pasteOpen = !pasteOpen;
    requestRender();
    document.getElementById('toggle-paste')?.focus();
    if (view.pasteOpen) document.getElementById('paste-box')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  document.getElementById('save-paste')?.addEventListener('click', () => void (async () => {
    const paste = must<HTMLTextAreaElement>('#team-paste').value;
    if (paste === team.paste) { toast('No changes in the paste'); return; }
    // Same check as an edit in the cards; Cancel leaves the typed paste in the box to fix.
    const updatePlans = await confirmPlanImpact(team, teamMons(team), parseShowdown(paste));
    if (!updatePlans) return;
    const parsed = change(team, () => { team.paste = paste; updatePlans(); });
    requestRender();
    toast('Team updated');
    teamWarnings(parsed).forEach((w) => toast(w, true));
  })());
}
