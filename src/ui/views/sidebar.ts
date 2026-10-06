import { store } from '../../state/instance.ts';
import { esc, must } from '../dom.ts';

/** Collapses the sidebar to a thin rail (or expands it), following `store.ui.navCollapsed`. */
export function applyNavCollapsed(): void {
  const collapsed = store.ui.navCollapsed;
  document.querySelector('.app')?.classList.toggle('nav-collapsed', collapsed);
  const toggle = document.querySelector<HTMLElement>('#nav-toggle');
  if (!toggle) return;
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

export function renderNav(): void {
  applyNavCollapsed();
  const nav = must('#nav');
  const { teams } = store.library;
  if (!teams.length) {
    nav.innerHTML = '<p class="hint nav-hint">Teams you add appear here as folders, with a gameplan for each opponent inside.</p>';
    return;
  }
  nav.innerHTML = teams.map((t) => {
    const open = store.ui.open[t.id] === true;
    const plans = open
      ? `<div class="plans">${t.plans.map((p) => `
        <div class="plan-row ${store.ui.planId === p.id ? 'active' : ''}" data-act="open-plan" data-team="${esc(t.id)}" data-plan="${esc(p.id)}" tabindex="0" role="button">
          <span class="name">${esc(p.name)}</span>
          <button class="row-menu" data-act="plan-menu" data-team="${esc(t.id)}" data-plan="${esc(p.id)}" aria-label="Gameplan options">⋯</button>
        </div>`).join('')}
        <button class="add-plan" data-act="new-plan" data-team="${esc(t.id)}">+ New gameplan</button></div>`
      : '';
    return `<div class="folder ${open ? 'open' : ''}">
      <div class="folder-row ${store.ui.teamId === t.id && !store.ui.planId ? 'active' : ''}" data-act="open-team" data-team="${esc(t.id)}" tabindex="0" role="button">
        <span class="caret" data-act="toggle-team" data-team="${esc(t.id)}">▸</span>
        <span class="name">${esc(t.name)}</span><span class="count">${t.plans.length}</span>
        <button class="row-menu" data-act="team-menu" data-team="${esc(t.id)}" aria-label="Team options">⋯</button>
      </div>${plans}
    </div>`;
  }).join('');
}
