import { esc, must, qs } from './dom.ts';

export function toast(message: string, isError = false): void {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 4500 : 2200);
}

export interface ModalAction<R> {
  label: string;
  cls?: string;
  /** Resolved when clicked (if there is no `run`). */
  value?: R | null;
  /** Runs on click. Return `false` to keep the dialog open, or the value to close with. */
  run?: (overlay: HTMLElement) => R | null | false;
}

export interface ModalOptions<R> {
  title: string;
  /** Plain text; escaped for you. */
  desc?: string;
  /** Trusted HTML built with `esc()`. */
  body?: string;
  actions: ModalAction<R>[];
}

/** Shows a dialog and resolves with the chosen action's value (null when dismissed). */
export function modal<R>(options: ModalOptions<R>): Promise<R | null> {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(options.title)}">
      <div class="modal-head"><h2>${esc(options.title)}</h2>${options.desc ? `<p>${esc(options.desc)}</p>` : ''}</div>
      <div class="modal-body">${options.body ?? ''}</div>
      <div class="modal-foot"></div></div>`;
    const foot = must('.modal-foot', overlay);

    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(null); };
    const close = (value: R | null): void => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
      resolve(value);
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });

    for (const action of options.actions) {
      const button = document.createElement('button');
      button.className = `btn ${action.cls ?? ''}`;
      button.textContent = action.label;
      button.addEventListener('click', () => {
        if (!action.run) { close(action.value ?? null); return; }
        const result = action.run(overlay);
        if (result !== false) close(result);
      });
      foot.appendChild(button);
    }
    must('#layer').appendChild(overlay);
    (qs('input, textarea', overlay) ?? qs('.btn.primary', overlay))?.focus();
  });
}

export async function confirmDialog(title: string, desc: string, label = 'Delete'): Promise<boolean> {
  const result = await modal<boolean>({
    title, desc,
    actions: [{ label: 'Cancel', value: false }, { label, cls: 'primary danger-fill', value: true }],
  });
  return result === true;
}

export type MenuItem = '-' | { label?: string; /** Trusted HTML built with `esc()`. */ html?: string; cls?: string; run: () => void };

let menuCleanup: (() => void) | null = null;

export function closeMenu(): void {
  menuCleanup?.();
  menuCleanup = null;
  qs('#ctx-menu')?.remove();
}

export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.id = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item === '-') { menu.appendChild(document.createElement('hr')); continue; }
    const button = document.createElement('button');
    button.setAttribute('role', 'menuitem');
    button.className = item.cls ?? '';
    button.innerHTML = item.html ?? esc(item.label);
    button.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); item.run(); });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = menu;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
  menu.style.top = `${rect.bottom + h + 12 > window.innerHeight ? Math.max(8, rect.top - h - 4) : rect.bottom + 4}px`;

  const outside = (e: MouseEvent): void => { if (!(e.target instanceof Node) || !menu.contains(e.target)) closeMenu(); };
  const timer = setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  menuCleanup = () => { clearTimeout(timer); document.removeEventListener('mousedown', outside, true); };
}
