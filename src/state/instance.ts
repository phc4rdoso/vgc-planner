/** The app's single store and simulation service, wired to browser storage and the real calculator. */
import { LocalStoragePrefs, MemoryPrefs } from '../infra/prefs.ts';
import { loadCalc } from '../infra/calc-loader.ts';
import { LocalStorageRepository, MemoryRepository, usableLocalStorage } from '../infra/repository.ts';
import type { LibraryRepository } from '../infra/repository.ts';
import { config } from '../config.ts';
import { SimService } from './sim-service.ts';
import { AppStore } from './store.ts';

const storage = usableLocalStorage();

/**
 * The library on this device (browser storage, or memory when storage is blocked). Used while signed out; the
 * store switches to the account's library on sign-in and back to this one on sign-out.
 */
export const device: { repo: LibraryRepository; persistent: boolean } = storage
  ? { repo: new LocalStorageRepository(storage, config.storage.libraryKey, config.storage.legacyKey), persistent: true }
  : { repo: new MemoryRepository(), persistent: false };

export const store = new AppStore(
  device.repo,
  storage ? new LocalStoragePrefs(storage, config.storage.prefsKey, config.storage.legacyKey) : new MemoryPrefs(),
  device.persistent,
);

export const simService = new SimService(loadCalc);

/** Small per-device flags (e.g. "already offered to upload this device's gameplans"); best effort. */
export const deviceFlags = {
  get(key: string): boolean { try { return storage?.getItem(`vgc-planner:${key}`) === '1'; } catch { return false; } },
  set(key: string): void { try { storage?.setItem(`vgc-planner:${key}`, '1'); } catch { /* optional */ } },
};
