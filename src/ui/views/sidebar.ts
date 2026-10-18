import { store } from '../../state/instance.ts';
import { session } from '../../state/account.ts';
import { esc, must } from '../dom.ts';
import { ICON_LINK } from '../share.ts';
import { isMobile } from '../mobile.ts';

/** Phones: the button at the start of the top bar that slides the team menu open. */
export const NAV_BUTTON = `<button class="btn nav-open-btn m-only" data-act="open-nav" aria-controls="nav" aria-label="Teams and gameplans" title="Teams and gameplans">
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 5h12M3 9h12M3 13h12"/></svg></button>`;

/**
 * Collapses the sidebar to a thin rail (or expands it), following `store.ui.navCollapsed`; on phones, slides it in
 * or out as a menu, following `store.ui.navOpen`.
 */
export function applyNavCollapsed(): void {
  const collapsed = store.ui.navCollapsed;
  // Phones have no rail: the sidebar is a menu there, whatever was chosen on a wide screen.
  document.querySelector('.app')?.classList.toggle('nav-collapsed', collapsed && !isMobile());
  document.querySelector('.app')?.classList.toggle('nav-open', store.ui.navOpen);
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
          <span class="name">${esc(p.name)}</span>${session.shared.has(p.id) ? `<span class="link-mark" title="Shared by link" aria-label="Shared by link">${ICON_LINK}</span>` : ""}
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
