import { store } from '../state/instance.ts';
import { registerRenderer } from './bus.ts';
import { must } from './dom.ts';
import { renderPlanView } from './views/plan-view.ts';
import { NAV_BUTTON, renderNav } from './views/sidebar.ts';
import { onMobileChange } from './mobile.ts';
import { renderTeamView } from './views/team-view.ts';
import { extLinksHTML } from './ext-links.ts';

const EMPTY_STATE = (storageNote: string): string => `<div class="topbar bare">${NAV_BUTTON}<span class="spacer"></span>${extLinksHTML()}</div><div class="page"><div class="empty">
  <h2>Plan your matchups</h2>
  <p>Add your team with a Showdown paste, then build a flowchart gameplan for each opponent you expect to face.</p>
  <button class="btn primary" data-act="new-team">New team</button>
  <p class="hint mt">Already have an export? <a href="#" data-act="import">Import JSON</a>.${storageNote}</p></div></div>`;

/** Draws the whole screen from the store: sidebar plus whichever view is selected. */
export function render(): void {
  renderNav();
  const main = must('#main');
  const { team, plan } = store;
  if (store.ui.teamId && !team) { store.ui.teamId = null; store.ui.planId = null; }
  if (!team) {
    main.innerHTML = EMPTY_STATE(store.persistent ? '' : ' Browser storage is unavailable, so changes live only until you close the tab; export to keep them.');
    return;
  }
  if (!plan) renderTeamView(main, team);
  else renderPlanView(main, team, plan);
}

registerRenderer(render);
// Crossing between phone and wider screens swaps the flowchart for the one-line Path view (and back).
onMobileChange(() => { store.ui.navOpen = false; render(); });
