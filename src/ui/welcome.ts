import { applyDynamicStyles, esc, must } from './dom.ts';
import { PREVIEWS } from './welcome-previews.ts';

/** `preview`: a small picture of that part of the app (see welcome-previews.ts). `badge`: a small tag above the title. */
export interface Step { title: string; text: string; icon: string; preview: string; badge?: string }

/**
 * Button labels of a tour: the first step's "next", the last step's, and the one that closes it early. `heading`: a
 * line at the top saying what the box is about (the same on every step).
 */
export interface TourLabels { start: string; finish: string; skip: string; heading?: string }

const svg = (path: string): string =>
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

const ICONS = {
  hello: svg('<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"/><path d="M3 12h6m6 0h6"/><circle cx="12" cy="12" r="3"/>'),
  team: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
  tabs: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 16h18M8 16v4m5-4v4"/>'),
  turns: svg('<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>'),
  results: svg('<path d="M4 19h16M7 16V9m5 7V5m5 11v-4"/>'),
} as const;

const steps = (name: string): Step[] => [
  { icon: ICONS.hello, preview: PREVIEWS.hello, title: `Welcome, ${name}!`, text: 'Plan every VGC matchup as a flowchart of turns, with damage calculated for Pokémon Champions. Here’s a quick look around.' },
  { icon: ICONS.team, preview: PREVIEWS.team, title: 'Start with your team', text: 'Press New team and paste your team in Showdown format. Each team becomes a folder in the sidebar.' },
  { icon: ICONS.tabs, preview: PREVIEWS.tabs, title: 'One gameplan per opponent', text: 'Inside a team, create a gameplan for each opponent you expect. Tabs at the bottom hold different leads and backs for the same matchup.' },
  { icon: ICONS.turns, preview: PREVIEWS.turns, title: 'Build turns and branches', text: 'Pick both sides’ leads and backs, then add turns with +. Click a turn to choose each Pokémon’s move; add sibling turns to plan for different opponent plays.' },
  { icon: ICONS.results, preview: PREVIEWS.results, title: 'Read the results', text: 'Each card shows who’s left after the turn. Open its log with the arrow at the top right for damage rolls, KOs and stat changes. Export JSON to back up or share a plan.' },
];

/** Scales the step's picture so it fits its frame whatever its content (never above 85% of real size). */
function fitPreview(root: HTMLElement): void {
  const frame = root.querySelector<HTMLElement>('.welcome-preview');
  const stage = root.querySelector<HTMLElement>('.pv-stage');
  if (!frame || !stage) return;
  stage.style.zoom = '1';
  const { width, height } = stage.getBoundingClientRect();
  if (!width || !height) return;
  const scale = Math.min(0.85, (frame.clientWidth - 16) / width, (frame.clientHeight - 16) / height);
  stage.style.zoom = String(Math.max(0.4, Math.round(scale * 100) / 100));
}

/** The first-sign-in welcome: walks through the main features. */
export function showWelcome(name: string): Promise<void> {
  return showTour(steps(name), { start: 'Show me around', finish: 'Get started', skip: 'Skip tour' });
}

/**
 * A small centered box that walks through some steps, each with its picture (the welcome, the news). Resolves when
 * it is finished or skipped (Escape or clicking outside also skip).
 */
export function showTour(list: readonly Step[], labels: TourLabels): Promise<void> {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    let index = 0;

    const close = (): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
      resolve();
    };
    const go = (to: number): void => {
      if (to >= list.length) { close(); return; }
      index = Math.max(0, to);
      draw();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') go(index + 1);
      else if (e.key === 'ArrowLeft') go(index - 1);
    };

    const draw = (): void => {
      const step = list[index]!;
      const last = index === list.length - 1;
      overlay.innerHTML = `<div class="modal welcome" role="dialog" aria-modal="true" aria-labelledby="${labels.heading ? 'welcome-heading ' : ''}welcome-title" aria-describedby="welcome-text">
        ${labels.heading ? `<div class="welcome-heading" id="welcome-heading">${esc(labels.heading)}</div>` : ''}
        <div class="welcome-preview" aria-hidden="true" inert><div class="pv-stage">${step.preview}</div></div>
        ${step.badge ? `<span class="welcome-badge">${esc(step.badge)}</span>` : ''}
        <h2 id="welcome-title"><span class="welcome-icon">${step.icon}</span>${esc(step.title)}</h2>
        <p id="welcome-text">${esc(step.text)}</p>
        ${list.length > 1 ? `<div class="welcome-dots" aria-label="Step ${index + 1} of ${list.length}">${list.map((_, i) => `<span class="${i === index ? 'on' : ''}"></span>`).join('')}</div>` : '<div class="welcome-dots"></div>'}
        <div class="modal-foot">
          ${last ? '' : `<button class="btn ghost" data-step="skip">${esc(labels.skip)}</button>`}<span class="spacer"></span>
          ${index > 0 ? '<button class="btn" data-step="back">Back</button>' : ''}
          <button class="btn primary" data-step="next">${esc(last ? labels.finish : index === 0 ? labels.start : 'Next')}</button>
        </div></div>`;
      applyDynamicStyles(overlay);
      fitPreview(overlay);
      must<HTMLButtonElement>('[data-step="next"]', overlay).focus();
    };

    overlay.addEventListener('click', (e) => {
      const button = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-step]') : null;
      if (button?.dataset.step === 'next') go(index + 1);
      else if (button?.dataset.step === 'back') go(index - 1);
      else if (button?.dataset.step === 'skip') close();
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    must('#layer').appendChild(overlay);
    draw();
  });
}
