/**
 * Lets views and actions ask for a full redraw without importing the module that owns rendering
 * (which would create circular imports).
 */
let renderer: () => void = () => {};

export const registerRenderer = (fn: () => void): void => { renderer = fn; };
export const requestRender = (): void => { renderer(); };
