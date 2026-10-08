import { findNode, findPlan, findTab, findTeam, sheetOf } from '../domain/model.ts';
import type { NodeLocation } from '../domain/model.ts';
import type { Library, Plan, PlanTab, Sheet, Team } from '../domain/types.ts';
import type { PrefsStore } from '../infra/prefs.ts';
import type { LibraryRepository } from '../infra/repository.ts';
import { config } from '../config.ts';

export interface UiState {
  teamId: string | null;
  planId: string | null;
  /** The open tab of the open gameplan (null: its first tab). */
  tabId: string | null;
  /** The turn open in the editor drawer. */
  selectedNode: string | null;
  open: Record<string, boolean>;
  zoom: number;
  /** Turn cards whose battle log is open (kept for the session only). */
  expanded: Record<string, boolean>;
  /** Sidebar folded down to a thin rail. */
  navCollapsed: boolean;
  /** The turn whose named line is highlighted from the legend (others are dimmed); null for none. */
  focusLine?: string | null;
  scrollX: number;
  scrollY: number;
}

/**
 * Holds the library and the view state, and writes changes through the repository. Mutate `library` / `ui`
 * directly, then call {@link persist}; saving is debounced and failures are reported through `onError`.
 */
export class AppStore {
  library: Library = { teams: [] };
  ui: UiState = { teamId: null, planId: null, tabId: null, selectedNode: null, open: {}, expanded: {}, zoom: 1, navCollapsed: false, scrollX: 0, scrollY: 0 };
  /** False when browser storage is unavailable and data only lives until the tab closes. */
  persistent: boolean;
  /** Set when saved data could not be read on startup. */
  loadError: string | null = null;
  onError: (message: string) => void = () => {};
  /** Save progress, for the "Saving… / Saved" hint: `pending` while edits wait to be sent. */
  saveState: 'saved' | 'pending' | 'saving' | 'error' = 'saved';
  onSaveState: (state: AppStore['saveState']) => void = () => {};

  private repo: LibraryRepository;
  private readonly prefs: PrefsStore;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(repo: LibraryRepository, prefs: PrefsStore, persistent = true) {
    this.repo = repo;
    this.prefs = prefs;
    this.persistent = persistent;
  }

  async init(): Promise<void> {
    await this.loadLibrary();
    const p = this.prefs.load();
    this.ui.open = p.open;
    this.ui.navCollapsed = p.navCollapsed;
    this.ui.zoom = Math.max(config.zoom.min, Math.min(config.zoom.max, p.zoom));
    this.restoreSelection(p.teamId, p.planId, p.tabId);
  }

  /**
   * Switches where the library lives (this device, or the signed-in account): pending edits are saved to the old
   * place first, then the library is loaded from the new one. The open team / gameplan stays open if it exists there.
   */
  async useRepository(repo: LibraryRepository, persistent = true): Promise<void> {
    await this.flush();
    this.repo = repo;
    this.persistent = persistent;
    await this.loadLibrary();
    this.restoreSelection(this.ui.teamId, this.ui.planId, this.ui.tabId);
  }

  /** Where the library currently lives. */
  get repository(): LibraryRepository { return this.repo; }

  private async loadLibrary(): Promise<void> {
    this.loadError = null;
    try {
      this.library = await this.repo.load();
    } catch (e) {
      this.library = { teams: [] };
      this.loadError = e instanceof Error ? e.message : String(e);
    }
  }

  private restoreSelection(teamId: string | null, planId: string | null, tabId: string | null): void {
    const team = findTeam(this.library, teamId);
    this.ui.teamId = team?.id ?? null;
    const plan = findPlan(team, planId);
    this.ui.planId = plan?.id ?? null;
    this.ui.tabId = plan ? findTab(plan, tabId).id : null;
    if (!plan) this.ui.selectedNode = null;
  }

  private setSaveState(state: AppStore['saveState']): void {
    this.saveState = state;
    this.onSaveState(state);
  }

  get team(): Team | undefined { return findTeam(this.library, this.ui.teamId); }
  get plan(): Plan | undefined { return findPlan(this.team, this.ui.planId); }
  /** The open tab (the gameplan's first tab if none is chosen). */
  get tab(): PlanTab | undefined { const plan = this.plan; return plan ? findTab(plan, this.ui.tabId) : undefined; }
  /** The open tab together with its gameplan's opponent: what the canvas, editor and simulation work on. */
  get sheet(): Sheet | undefined { const plan = this.plan; const tab = this.tab; return plan && tab ? sheetOf(plan, tab) : undefined; }

  /** The turn currently open in the editor, with its position in the tree. */
  currentNode(): NodeLocation | null {
    const tab = this.tab;
    return tab ? findNode(tab.children, this.ui.selectedNode) : null;
  }

  /** Schedules a save. Call after every change to `library` or the persisted parts of `ui`. */
  persist(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.saveState !== 'pending') this.setSaveState('pending');
    this.timer = setTimeout(() => { void this.flush(); }, this.repo.saveDelayMs ?? config.storage.saveDelayMs);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.prefs.save({ teamId: this.ui.teamId, planId: this.ui.planId, tabId: this.ui.tabId, open: this.ui.open, zoom: this.ui.zoom, navCollapsed: this.ui.navCollapsed });
    this.setSaveState('saving');
    try {
      await this.repo.save(this.library);
      // A newer edit may have been scheduled while this save was in flight.
      if (this.timer === null) this.setSaveState('saved');
    } catch (e) {
      this.setSaveState('error');
      this.onError(e instanceof Error ? e.message : String(e));
    }
  }
}
