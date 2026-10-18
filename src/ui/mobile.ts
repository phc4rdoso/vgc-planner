/** Phone-sized screens (the same width where the layout already stacks): the plan shows one line of play at a time. */
const query = typeof matchMedia === 'function' ? matchMedia('(max-width: 820px)') : null;

export const isMobile = (): boolean => query?.matches === true;

/** Calls `fn` when the screen crosses between phone and wider layouts (rotating a tablet, resizing a window). */
export function onMobileChange(fn: () => void): void {
  query?.addEventListener('change', fn);
}
