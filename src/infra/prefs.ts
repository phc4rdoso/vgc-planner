import type { StorageLike } from './repository.ts';

/** View preferences. Kept apart from the library so they never end up in exports or on a server. */
export interface UiPrefs {
  teamId: string | null;
  planId: string | null;
  tabId: string | null;
  open: Record<string, boolean>;
  zoom: number;
  navCollapsed: boolean;
}

export const defaultPrefs = (): UiPrefs => ({ teamId: null, planId: null, tabId: null, open: {}, zoom: 1, navCollapsed: false });

export interface PrefsStore {
  load(): UiPrefs;
  save(prefs: UiPrefs): void;
}

export class LocalStoragePrefs implements PrefsStore {
  private readonly storage: StorageLike | null;
  private readonly key: string;
  private readonly legacyKey: string | null;

  constructor(storage: StorageLike | null, key: string, legacyKey: string | null = null) {
    this.storage = storage;
    this.key = key;
    this.legacyKey = legacyKey;
  }

  load(): UiPrefs {
    const prefs = defaultPrefs();
    if (!this.storage) return prefs;
    try {
      const raw = this.storage.getItem(this.key);
      // The old single-key format kept `ui` next to the teams.
      const parsed: unknown = raw !== null ? JSON.parse(raw) : this.legacyUi();
      if (typeof parsed !== 'object' || parsed === null) return prefs;
      const p = parsed as Record<string, unknown>;
      if (typeof p.teamId === 'string') prefs.teamId = p.teamId;
      if (typeof p.planId === 'string') prefs.planId = p.planId;
      if (typeof p.tabId === 'string') prefs.tabId = p.tabId;
      if (typeof p.zoom === 'number' && Number.isFinite(p.zoom)) prefs.zoom = p.zoom;
      if (p.navCollapsed === true) prefs.navCollapsed = true;
      if (typeof p.open === 'object' && p.open !== null) {
        for (const [k, v] of Object.entries(p.open)) if (v === true) prefs.open[k] = true;
      }
    } catch { /* unreadable preferences just reset to defaults */ }
    return prefs;
  }

  save(prefs: UiPrefs): void {
    try { this.storage?.setItem(this.key, JSON.stringify(prefs)); } catch { /* preferences are optional */ }
  }

  private legacyUi(): unknown {
    if (!this.legacyKey || !this.storage) return null;
    const raw = this.storage.getItem(this.legacyKey);
    if (raw === null) return null;
    const legacy = JSON.parse(raw) as { ui?: unknown };
    return legacy.ui ?? null;
  }
}

export class MemoryPrefs implements PrefsStore {
  private prefs: UiPrefs = defaultPrefs();
  load(): UiPrefs { return structuredClone(this.prefs); }
  save(prefs: UiPrefs): void { this.prefs = structuredClone(prefs); }
}
