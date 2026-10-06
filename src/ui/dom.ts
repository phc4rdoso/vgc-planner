const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapes text for HTML (including attribute values). Every dynamic value that goes into an
 * `innerHTML` template must pass through this; user-provided text is never inserted raw.
 */
export const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

export function qs<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

/** Like {@link qs} but throws, for elements the markup guarantees. */
export function must<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

/**
 * Sets widths from `data-w="42"` (percent). Done in script rather than with `style="..."` attributes,
 * which a strict Content-Security-Policy would block.
 */
export function applyDynamicStyles(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w ?? 0}%`; });
}
