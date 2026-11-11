/**
 * A text box that suggests names as you type (the ARIA combobox pattern): a list opens under it, ↑/↓ move through
 * it, Enter or a click picks, Esc closes it (and puts the old value back). Used by the team editor's fields and its
 * "Add Pokémon" box. The markup is the caller's: an `<input>` plus an empty `role="listbox"` element.
 */
import { toID } from '../domain/strings.ts';
import { esc } from './dom.ts';

export interface ComboOption { value: string; sub: string; /** A move's type, shown as a coloured dot. */ type?: string }

export interface ComboConfig {
  /** Suggestions for what was typed ('' when nothing yet); null while the names are still loading. */
  options(query: string): ComboOption[] | null;
  /** Loads the names when `options` returned null; the list refreshes when it settles. */
  load?: () => Promise<unknown>;
  /** Called with the chosen value. */
  pick(value: string): void;
  /** Esc with the list already closed. */
  escape?: () => void;
  /**
   * What leaving the box does: 'value' (the default) keeps what was typed, known or not, or the highlighted
   * suggestion; 'option' only picks a highlighted suggestion and otherwise drops the text.
   */
  onBlur?: 'value' | 'option';
  /** The value marked as current in the list. */
  current?: string;
  /** Show a type dot before each suggestion. */
  dots?: boolean;
}

export const typeDot = (type: string): string => `<span class="type-dot${type ? ` t-${toID(type)}` : ''}" aria-hidden="true"></span>`;

/** Set while focus is being put back after a redraw, so the box doesn't open its list. */
export const restoringFocus = (): boolean => !!document.body.dataset.restoringFocus;

export function bindCombobox(input: HTMLInputElement, list: HTMLElement, cfg: ComboConfig): void {
  let active = -1;
  const orig = (): string => input.dataset.orig ?? '';
  const options = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('[role="option"]')];

  const hide = (): void => {
    list.hidden = true;
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const setActive = (i: number): void => {
    const opts = options();
    if (!opts.length) return;
    active = (i + opts.length) % opts.length;
    opts.forEach((o, j) => o.setAttribute('aria-selected', String(j === active)));
    input.setAttribute('aria-activedescendant', opts[active]!.id);
    opts[active]!.scrollIntoView({ block: 'nearest' });
  };

  const show = (query: string): void => {
    const opts = cfg.options(query);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
    if (!opts) {
      list.innerHTML = '<div class="cb-empty">Loading Pokémon data…</div>';
      cfg.load?.().then(() => { if (document.activeElement === input) show(input.value === orig() ? '' : input.value); }).catch(() => {
        list.innerHTML = '<div class="cb-empty">Suggestions are unavailable right now; you can still type a name.</div>';
      });
      return;
    }
    const current = toID(cfg.current ?? '');
    list.innerHTML = opts.length
      ? opts.map((o, i) => `<div role="option" class="cb-opt${current && toID(o.value) === current ? ' current' : ''}" id="${input.id}-opt-${i}" data-value="${esc(o.value)}" aria-selected="false">
          ${cfg.dots ? typeDot(o.type ?? '') : ''}<span class="nm">${esc(o.value)}</span><span class="sub">${esc(o.sub)}</span></div>`).join('')
      : `<div class="cb-empty">${cfg.onBlur === 'option' ? 'No match.' : `No match. Press Enter to keep “${esc(query)}”.`}</div>`;
    if (query && opts.length) setActive(0);
  };

  const pick = (value: string): void => {
    hide();
    input.value = value;
    if (value.trim() === orig()) return;
    input.dataset.orig = value.trim();
    cfg.pick(value.trim());
  };

  input.addEventListener('focus', () => {
    if (restoringFocus()) return;
    input.select();
    show('');
  });
  input.addEventListener('input', () => show(input.value));
  input.addEventListener('blur', () => {
    const opt = active >= 0 ? options()[active] : null;
    const value = opt?.dataset.value ?? (cfg.onBlur === 'option' ? orig() : input.value);
    hide();
    if (value.trim() !== orig()) pick(value);
    else input.value = orig();
  });
  input.addEventListener('keydown', (e) => {
    const open = !list.hidden;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) show(''); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (!open) show(''); setActive(active - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = active >= 0 ? options()[active] : null;
      // In a box that only takes suggestions, Enter with none highlighted does nothing ("No match" stays up).
      if (opt?.dataset.value) pick(opt.dataset.value);
      else if (cfg.onBlur !== 'option') pick(input.value);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (open) { hide(); input.value = orig(); input.select(); }
      else cfg.escape?.();
    }
  });
  // mousedown, so the box keeps focus (and doesn't take the half-typed text) before the pick.
  list.addEventListener('mousedown', (e) => {
    const opt = e.target instanceof Element ? e.target.closest<HTMLElement>('[role="option"]') : null;
    e.preventDefault();
    if (opt?.dataset.value) pick(opt.dataset.value);
  });
}
