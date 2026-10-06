/** Opaque unique id. Uses the platform UUID generator (browser and Node). */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Very old runtimes only; ids just need to be unique within one library.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
