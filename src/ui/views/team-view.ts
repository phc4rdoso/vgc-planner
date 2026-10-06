import { cleanSelections, countPlanTurns, oppMons, teamMons } from '../../domain/model.ts';
import { REGULATION } from '../../domain/regulation.ts';
import { parseShowdown, teamWarnings } from '../../domain/showdown.ts';
import { spreadText, statPoints } from '../../domain/stats.ts';
import type { PokemonSet, Team } from '../../domain/types.ts';
import { store } from '../../state/instance.ts';
import { requestRender } from '../bus.ts';
import { esc, must } from '../dom.ts';
import { itemIcon, monIcon } from '../icons.ts';
import { toast } from '../overlays.ts';
import { PASTE_LINK_HINT } from '../paste-links.ts';
import { renderNav } from './sidebar.ts';

function monCard(m: PokemonSet): string {
  const sp = statPoints(m);
  return `<div class="mon-card">${monIcon(m.species)}<div class="meta">
    <div class="sp">${esc(m.nickname ? `${m.nickname} (${m.species})` : m.species)}</div>
    <div class="sub">${m.item ? itemIcon(m.item, 'xs') + esc(m.item) : '<span class="muted">No item</span>'}</div>
    ${m.ability ? `<div class="sub">${esc(m.ability)}</div>` : ''}
    ${sp ? `<div class="sub" title="Champions Stat Points (max 32 per stat, 66 total)">SP ${esc(spreadText(sp.sp))}${sp.converted ? ' (from EVs)' : ''}</div>` : ''}
    ${m.moves.length ? `<div class="moves">${m.moves.map(esc).join(' · ')}</div>` : ''}</div></div>`;
}

export function renderTeamView(main: HTMLElement, team: Team): void {
  const mons = teamMons(team);
  const warnings = teamWarnings(mons);
  main.innerHTML = `
  <div class="topbar"><input class="title-input" id="team-name" value="${esc(team.name)}" aria-label="Team name">
    <span class="chip">${esc(REGULATION.label)}</span><span class="spacer"></span>
    <button class="btn" data-act="export-team" data-team="${esc(team.id)}">Export team</button>
    <button class="btn danger" data-act="delete-team" data-team="${esc(team.id)}">Delete</button></div>
  <div class="page"><div class="page-inner">
    <div class="section"><div class="section-head"><h3>Team</h3><button class="btn primary sm" id="save-paste">Update team</button></div>
      <textarea class="paste" id="team-paste" data-team-paste placeholder="Paste your team in Showdown format, ${PASTE_LINK_HINT}">${esc(team.paste)}</textarea>
      ${warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
      ${mons.length ? `<div class="mon-grid">${mons.map(monCard).join('')}</div>` : '<p class="hint mt-s">No Pokémon parsed yet.</p>'}
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

  must<HTMLInputElement>('#team-name').addEventListener('input', (e) => {
    team.name = (e.target as HTMLInputElement).value;
    store.persist();
    renderNav();
  });
  must('#save-paste').addEventListener('click', () => {
    team.paste = must<HTMLTextAreaElement>('#team-paste').value;
    const parsed = parseShowdown(team.paste);
    cleanSelections(team.plans, 'me', parsed);
    store.persist();
    requestRender();
    toast('Team updated');
    teamWarnings(parsed).forEach((w) => toast(w, true));
  });
}
