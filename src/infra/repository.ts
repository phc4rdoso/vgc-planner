import { DataError, readLibrary, writeLibrary } from '../domain/codec.ts';
import type { Library } from '../domain/types.ts';

/**
 * Where the user's library lives. The app only talks to this interface, so moving from the browser to a
 * server means adding one class (e.g. `HttpLibraryRepository`) and changing one line in `state/instance.ts`.
 */
export interface LibraryRepository {
  load(): Promise<Library>;
  save(library: Library): Promise<void>;
  /** How long to wait after an edit before saving (default: `config.storage.saveDelayMs`). */
  readonly saveDelayMs?: number;
}

export class RepositoryError extends Error {
  override readonly name = 'RepositoryError';
}

/** The subset of the Web Storage API we use (also easy to fake in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class MemoryRepository implements LibraryRepository {
  private library: Library;
  constructor(initial: Library = { teams: [] }) { this.library = structuredClone(initial); }
  load(): Promise<Library> { return Promise.resolve(structuredClone(this.library)); }
  save(library: Library): Promise<void> { this.library = structuredClone(library); return Promise.resolve(); }
}

export class LocalStorageRepository implements LibraryRepository {
  private readonly storage: StorageLike;
  private readonly key: string;
  private readonly legacyKey: string | null;

  constructor(storage: StorageLike, key: string, legacyKey: string | null = null) {
    this.storage = storage;
    this.key = key;
    this.legacyKey = legacyKey;
  }

  load(): Promise<Library> {
    const raw = this.storage.getItem(this.key) ?? (this.legacyKey ? this.storage.getItem(this.legacyKey) : null);
    if (raw === null) return Promise.resolve({ teams: [] });
    try {
      return Promise.resolve(readLibrary(JSON.parse(raw) as unknown));
    } catch (e) {
      // Never discard what we can't read: keep a copy so it can be recovered by hand.
      const backupKey = `${this.key}:unreadable-${Date.now()}`;
      try { this.storage.setItem(backupKey, raw); } catch { /* storage full: nothing more we can do */ }
      const reason = e instanceof DataError || e instanceof SyntaxError ? e.message : 'unknown error';
      return Promise.reject(new RepositoryError(`Saved data couldn't be read (${reason}). A copy was kept under "${backupKey}".`));
    }
  }

  save(library: Library): Promise<void> {
    try {
      this.storage.setItem(this.key, JSON.stringify(writeLibrary(library)));
      return Promise.resolve();
    } catch {
      return Promise.reject(new RepositoryError("Couldn't save: browser storage is full or unavailable. Export your data to keep it."));
    }
  }
}

/** Returns `localStorage` if it works (it can throw in private modes or when blocked), otherwise null. */
export function usableLocalStorage(): Storage | null {
  try {
    const probe = '__vgc_planner_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch { return null; }
}
