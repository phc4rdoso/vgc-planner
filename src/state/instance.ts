/** The app's single store and simulation service, wired to browser storage and the real calculator. */
import { LocalStoragePrefs, MemoryPrefs } from '../infra/prefs.ts';
import { loadCalc } from '../infra/calc-loader.ts';
import { LocalStorageRepository, MemoryRepository, usableLocalStorage } from '../infra/repository.ts';
import { config } from '../config.ts';
import { SimService } from './sim-service.ts';
import { AppStore } from './store.ts';

const storage = usableLocalStorage();

export const store = storage
  ? new AppStore(
      new LocalStorageRepository(storage, config.storage.libraryKey, config.storage.legacyKey),
      new LocalStoragePrefs(storage, config.storage.prefsKey, config.storage.legacyKey),
    )
  : new AppStore(new MemoryRepository(), new MemoryPrefs(), false);

export const simService = new SimService(loadCalc);
