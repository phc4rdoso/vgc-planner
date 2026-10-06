import { PASTE_SITE_LABEL, parsePasteLink } from '../domain/paste-links.ts';
import { fetchPasteLink } from '../infra/paste-links.ts';

/** Placeholder hint for every team-paste box. */
export const PASTE_LINK_HINT = 'or paste a pokepast.es / vrpastes.com link';

/** The status line under a paste box, created on first use. */
function statusFor(box: HTMLTextAreaElement): HTMLElement {
  const next = box.nextElementSibling;
  if (next instanceof HTMLElement && next.classList.contains('paste-link-status')) return next;
  const el = document.createElement('div');
  el.className = 'hint paste-link-status';
  el.setAttribute('role', 'status');
  box.insertAdjacentElement('afterend', el);
  return el;
}

/** Only the latest link typed into a box counts, if the user pastes another one while the first is loading. */
const pending = new WeakMap<HTMLTextAreaElement, string>();

async function loadLink(box: HTMLTextAreaElement): Promise<void> {
  const link = parsePasteLink(box.value);
  if (!link) return;
  const status = statusFor(box);
  const asked = box.value;
  pending.set(box, asked);
  status.classList.remove('err-text');
  status.textContent = `Loading the team from ${PASTE_SITE_LABEL[link.site]}…`;
  try {
    const { paste, title } = await fetchPasteLink(link);
    if (pending.get(box) !== asked || box.value !== asked) return;
    box.value = paste;
    status.textContent = `Team loaded from ${PASTE_SITE_LABEL[link.site]}${title ? ` (“${title}”)` : ''}.`;
    // A name field left empty in the same form takes the paste's title.
    const nameField = box.dataset.nameField ? document.querySelector<HTMLInputElement>(box.dataset.nameField) : null;
    if (nameField && !nameField.value.trim() && title) nameField.value = title.slice(0, 80);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  } catch (e) {
    if (pending.get(box) !== asked) return;
    status.classList.add('err-text');
    status.textContent = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Any textarea marked `data-team-paste` accepts a pokepast.es or vrpastes.com link in place of the team text: the
 * team is fetched and replaces the link, ready to save.
 */
export function installPasteLinks(): void {
  document.addEventListener('input', (e) => {
    const box = e.target;
    if (!(box instanceof HTMLTextAreaElement) || !('teamPaste' in box.dataset) || box.readOnly) return;
    if (parsePasteLink(box.value)) void loadLink(box);
  });
}
