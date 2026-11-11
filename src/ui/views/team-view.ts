import { cleanSelections, countPlanTurns, oppMons, teamMons } from '../../domain/model.ts';
import { REGULATION } from '../../domain/regulation.ts';
import { parseShowdown, teamWarnings } from '../../domain/showdown.ts';
import { spreadText, statPoints } from '../../domain/stats.ts';
import { editMon } from '../../domain/team-edit.ts';
import type { PokemonSet, Team } from '../../domain/types.ts';
import { simService, store } from '../../state/instance.ts';
import { requestRender } from '../bus.ts';
import { applyDynamicStyles, esc, must } from '../dom.ts';
import { itemIcon, monIcon } from '../icons.ts';
import { toast } from '../overlays.ts';
import { PASTE_LINK_HINT } from '../paste-links.ts';
import { NAV_BUTTON, renderNav } from './sidebar.ts';
import { extLinksHTML } from '../ext-links.ts';
import { bindMonEditor, monEditorHTML } from './mon-editor.ts';
import type { MonEdit } from './mon-editor.ts';

/**
 * What the team screen shows besides the team itself: which Pokémon is open in the editor, whether the paste box
 * is open, and when the last edit was saved. Kept for this visit only, not saved.
 */
const view: { teamId: string | null; editing: number | null; pasteOpen: boolean; savedAt: number } = { teamId: null, editing: null, pasteOpen: true, savedAt: 0 };

function monCard(m: PokemonSet, i: number, editing: boolean): string {
  const sp = statPoints(m);
  return `<button type="button" class="mon-card${editing ? ' editing' : ''}" id="mon-card-${i}" data-mon-edit="${i}" aria-expanded="${editing}" aria-controls="mon-editor"
    title="${editing ? 'Close the editor' : `Edit ${esc(m.species)}`}">${monIcon(m.species)}<span class="meta">
    <span class="sp">${esc(m.nickname ? `${m.nickname} (${m.species})` : m.species)}${editing ? ' <span class="chip">Editing</span>' : ''}</span>
    <span class="sub">${m.item ? itemIcon(m.item, 'xs') + esc(m.item) : '<span class="muted">No item</span>'}</span>
    ${m.ability ? `<span class="sub">${esc(m.ability)}</span>` : ''}
    ${sp ? `<span class="sub" title="Champions Stat Points (max 32 per stat, 66 total)">SP ${esc(spreadText(sp.sp))}${sp.converted ? ' (from EVs)' : ''}</span>` : ''}
    ${m.moves.length ? `<span class="moves">${m.moves.map(esc).join(' · ')}</span>` : ''}</span>
    <svg class="edit-mark" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></button>`;
}

/** Saves a new paste for the team: plan selections that no longer match are cleaned, as with "Update team". */
function savePaste(team: Team, paste: string): PokemonSet[] {
  team.paste = paste;
  const parsed = parseShowdown(team.paste);
  cleanSelections(team.plans, 'me', parsed);
  store.persist();
  view.savedAt = Date.now();
  return parsed;
}

/** Redraws the app, keeping focus on the same control (ids are stable across redraws). */
function redrawKeepingFocus(): void {
  const id = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  requestRender();
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  document.body.dataset.restoringFocus = '1';
  try {
    el.focus({ preventScroll: true });
    if (el instanceof HTMLInputElement && el.type === 'text') el.setSelectionRange(el.value.length, el.value.length);
  } finally { delete document.body.dataset.restoringFocus; }
}

export function renderTeamView(main: HTMLElement, team: Team): void {
  // Redrawing the same team (an edit, opening the editor) keeps the page where it was scrolled.
  const scrollTop = view.teamId === team.id ? (main.querySelector('.page')?.scrollTop ?? 0) : 0;
  if (view.teamId !== team.id) Object.assign(view, { teamId: team.id, editing: null, pasteOpen: true, savedAt: 0 });
  const mons = teamMons(team);
  if (view.editing !== null && !mons[view.editing]) view.editing = null;
  const editing = view.editing;
  const warnings = teamWarnings(mons);
  // A team with no Pokémon yet is made from a paste, so the box is always open then.
  const pasteOpen = view.pasteOpen || !mons.length;
  const saved = view.savedAt ? `<span class="saved-note" role="status"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Saved</span>` : '';
  main.innerHTML = `
  <div class="topbar">${NAV_BUTTON}<input class="title-input" id="team-name" value="${esc(team.name)}" aria-label="Team name">
    <span class="chip">${esc(REGULATION.label)}</span><span class="spacer"></span>
    <button class="btn" data-act="export-team" data-team="${esc(team.id)}">Export team</button>
    <button class="btn danger" data-act="delete-team" data-team="${esc(team.id)}">Delete</button><div class="d-only">${extLinksHTML()}</div></div>
  <div class="page"><div class="page-inner">
    <div class="section"><div class="section-head"><h3>Team</h3>
        ${mons.length ? '<span class="hint">Click a Pokémon to edit it</span>' : ''}<span class="spacer"></span>${saved}
        ${mons.length ? `<button class="btn sm" id="toggle-paste" aria-expanded="${pasteOpen}" aria-controls="paste-box">${pasteOpen ? 'Hide paste' : 'Edit as text'}</button>` : ''}</div>
      ${warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
      ${mons.length ? `<div class="mon-grid">${mons.map((m, i) => monCard(m, i, i === editing)).join('')}</div>` : '<p class="hint">No Pokémon parsed yet.</p>'}
      ${editing !== null ? monEditorHTML(mons[editing]!) : ''}
      ${pasteOpen ? `<div class="paste-box" id="paste-box">
        <div class="paste-head"><label class="me-label" for="team-paste">Showdown paste</label>
          <span class="hint">${mons.length ? 'Updates as you edit the Pokémon above. To change many at once, edit here and press Update team.' : ''}</span>
          <span class="spacer"></span><button class="btn primary sm" id="save-paste">Update team</button></div>
        <textarea class="paste" id="team-paste" data-team-paste placeholder="Paste your team in Showdown format, ${PASTE_LINK_HINT}">${esc(team.paste)}</textarea></div>` : ''}
    </div>
    <div class="section"><div class="section-head"><h3>Gameplans</h3><button class="btn primary sm" data-act="new-plan" data-team="${esc(team.id)}">New gameplan</button></div>
      ${team.plans.length ? `<div class="plan-list">${team.plans.map((p) => {
        const turns = countPlanTurns(p);
        const tabs = p.tabs.length;
        return `<div class="plan-card" data-act="open-plan" data-team="${esc(team.id)}" data-plan="${esc(p.id)}" tabindex="0" role="button">
          <span class="nm">${esc(p.name)}</span>
          <span class="icon-row">${oppMons(p).map((m) => monIcon(m.species, 'sm')).join('')}</span>
          <span class="muted">${tabs > 1 ? `${tabs} tabs · ` : ''}${turns} turn${turns === 1 ? '' : 's'}</span></div>`;
      }).join('')}</div>` : '<p class="hint">No gameplans yet. Create one for each opponent team you want to prepare for.</p>'}
    </div></div></div>`;
  applyDynamicStyles(main);
  const page = main.querySelector('.page');
  if (page && scrollTop) page.scrollTop = scrollTop;

  must<HTMLInputElement>('#team-name').addEventListener('input', (e) => {
    team.name = (e.target as HTMLInputElement).value;
    store.persist();
    renderNav();
  });

  main.querySelectorAll<HTMLButtonElement>('[data-mon-edit]').forEach((card) => card.addEventListener('click', () => {
    const i = Number(card.dataset.monEdit);
    view.editing = view.editing === i ? null : i;
    requestRender();
    if (view.editing === null) document.getElementById(`mon-card-${i}`)?.focus();
    else {
      document.getElementById('mon-editor')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      // Opening the editor starts loading the names it suggests; redraw once they are in (types, final stats).
      if (!simService.dex()) simService.ready().then(() => { if (view.editing !== null && store.team?.id === team.id) redrawKeepingFocus(); }).catch(() => {});
    }
  }));

  if (editing !== null) {
    const commit = (edit: MonEdit): void => {
      savePaste(team, editMon(team.paste, editing, edit));
      // After the browser has moved focus (Tab out of a field commits it), so the redraw keeps it where it went.
      setTimeout(redrawKeepingFocus, 0);
    };
    const close = (): void => {
      view.editing = null;
      requestRender();
      document.getElementById(`mon-card-${editing}`)?.focus();
    };
    bindMonEditor(main, mons[editing]!, commit, close);
  }

  document.getElementById('toggle-paste')?.addEventListener('click', () => {
    view.pasteOpen = !pasteOpen;
    requestRender();
    document.getElementById('toggle-paste')?.focus();
  });

  document.getElementById('save-paste')?.addEventListener('click', () => {
    const parsed = savePaste(team, must<HTMLTextAreaElement>('#team-paste').value);
    requestRender();
    toast('Team updated');
    teamWarnings(parsed).forEach((w) => toast(w, true));
  });
}
