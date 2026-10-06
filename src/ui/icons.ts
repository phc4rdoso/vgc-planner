import { spriteUrls } from '../infra/sprites.ts';
import { esc } from './dom.ts';

export type IconSize = '' | 'sm' | 'xs';

/** Which sprite URL worked (so redraws don't retry) and which names have no sprite at all. */
const resolved = new Map<string, string>();
const missing = new Set<string>();

const initials = (name: string): string => name.replace(/[^A-Za-z]/g, '').slice(0, 2);

/** Pokémon icon. Falls back to a letter badge when no sprite file matches. */
export function monIcon(species: string, size: IconSize = ''): string {
  if (!species) return `<span class="mon-fallback ${size}">?</span>`;
  const letters = esc(initials(species));
  const key = `mon:${species}`;
  if (missing.has(key)) return `<span class="mon-fallback ${size}" title="${esc(species)}">${letters}</span>`;
  const urls = spriteUrls.pokemon(species);
  return `<img class="mon-icon ${size}" alt="${esc(species)}" title="${esc(species)}" src="${esc(resolved.get(key) ?? urls[0])}"
    data-fb="mon" data-key="${esc(key)}" data-cands="${esc(urls.join('|'))}" data-letters="${letters}" data-size="${size}">`;
}

/** Item icon. Simply hidden when there is no sprite; the item name is always shown as text elsewhere. */
export function itemIcon(item: string, size: IconSize = ''): string {
  if (!item) return '';
  const key = `item:${item}`;
  if (missing.has(key)) return '';
  const urls = spriteUrls.item(item);
  return `<img class="item-icon ${size}" alt="${esc(item)}" title="${esc(item)}" src="${esc(resolved.get(key) ?? urls[0])}"
    data-fb="item" data-key="${esc(key)}" data-cands="${esc(urls.join('|'))}">`;
}

/**
 * Image `load`/`error` events don't bubble, so they are caught in the capture phase on `document`.
 * On error the next candidate file name is tried, then the fallback is shown.
 */
export function installIconFallbacks(): void {
  document.addEventListener('load', (e) => {
    const t = e.target;
    if (t instanceof HTMLImageElement && t.dataset.key) resolved.set(t.dataset.key, t.src);
  }, true);

  document.addEventListener('error', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLImageElement) || !t.dataset.fb) return;
    const candidates = (t.dataset.cands ?? '').split('|').filter(Boolean);
    const next = Number(t.dataset.try ?? 0) + 1;
    const nextUrl = candidates[next];
    if (nextUrl) { t.dataset.try = String(next); t.src = nextUrl; return; }
    if (t.dataset.key) missing.add(t.dataset.key);
    if (t.dataset.fb === 'mon') {
      const badge = document.createElement('span');
      badge.className = `mon-fallback ${t.dataset.size ?? ''}`;
      badge.textContent = t.dataset.letters ?? '?';
      badge.title = t.title;
      t.replaceWith(badge);
    } else {
      t.hidden = true;
    }
  }, true);
}
