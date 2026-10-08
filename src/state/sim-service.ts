import { turnResultsGate } from '../domain/simulation/gate.ts';
import { createEngine } from '../domain/simulation/engine.ts';
import type { CalcEngine, MoveInfo } from '../domain/simulation/engine.ts';
import type { CalcLoader } from '../domain/simulation/calc-types.ts';
import type { TurnResult } from '../domain/simulation/log.ts';
import { simulateSheet } from '../domain/simulation/plan.ts';
import type { BattleState } from '../domain/simulation/state.ts';
import type { Sheet, Team } from '../domain/types.ts';

/** What the UI should show for turn results on the current plan. */
export type SimView =
  | { enabled: false; reasons: string[] }
  | { enabled: true; status: 'loading' }
  | { enabled: true; status: 'error'; message: string }
  /** `start`: the battle as the first turn begins. */
  | { enabled: true; status: 'ready'; results: Map<string, TurnResult>; start: BattleState; native: boolean };

/** Owns the calculator's lifecycle (lazy load, retry) and caches results until the inputs change. */
export class SimService {
  /** Called when the calculator finishes loading or fails, so the view can redraw. */
  onChange: () => void = () => {};

  private readonly loader: CalcLoader;
  private engine: CalcEngine | null = null;
  private state: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private error = '';
  private memo: { key: string; results: Map<string, TurnResult>; start: BattleState } | null = null;

  constructor(loader: CalcLoader) { this.loader = loader; }

  /** Results for one tab of a gameplan (a {@link Sheet}). Pass `force` to skip the cache (and retry a failed load). */
  compute(team: Team, plan: Sheet, force = false): SimView {
    const gate = turnResultsGate(team, plan);
    if (!gate.enabled) return { enabled: false, reasons: gate.reasons };
    if (force && this.state === 'error') this.state = 'idle';
    if (force) this.memo = null;
    this.ensureEngine();
    if (this.state === 'idle' || this.state === 'loading') return { enabled: true, status: 'loading' };
    if (this.state === 'error' || !this.engine) return { enabled: true, status: 'error', message: this.error };
    const key = JSON.stringify([plan.id, team.paste, plan.opponent.paste, plan.selection, plan.children]);
    if (this.memo?.key !== key) {
      try { this.memo = { key, ...simulateSheet(this.engine, team, plan) }; }
      catch (e) { return { enabled: true, status: 'error', message: e instanceof Error ? e.message : String(e) }; }
    }
    return { enabled: true, status: 'ready', results: this.memo.results, start: this.memo.start, native: this.engine.native };
  }

  /** A move's data from the calculator (category, target, flags), or null until the calculator has loaded. */
  moveInfo(name: string): MoveInfo | null {
    return this.engine && name ? this.engine.moveInfo(name) : null;
  }

  /** The calculator, loading it if needed. Rejects if it can't load. */
  async ready(): Promise<CalcEngine> {
    if (this.state === 'error') this.state = 'idle';
    this.ensureEngine();
    await this.loading;
    if (!this.engine) throw new Error(`The damage calculator didn’t load${this.error ? `: ${this.error}` : ''}.`);
    return this.engine;
  }

  private loading: Promise<void> | null = null;

  private ensureEngine(): void {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    this.loading = this.loader()
      .then((lib) => { this.engine = createEngine(lib); this.state = 'ready'; })
      .catch((e: unknown) => { this.state = 'error'; this.error = e instanceof Error ? e.message : String(e); })
      .finally(() => { this.onChange(); });
  }
}
