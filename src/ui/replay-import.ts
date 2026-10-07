import { oppMons, sheetOf, teamMons } from '../domain/model.ts';
import { parseReplayLog, ReplayError } from '../domain/replay.ts';
import { alwaysEffect, buildReplayBranch, placeReplayBranch } from '../domain/replay-import.ts';
import type { FlowNode, PlanTab } from '../domain/types.ts';
import { fetchReplayLog, parseReplayLink } from '../infra/replay.ts';
import { simService, store } from '../state/instance.ts';
import { requestRender } from './bus.ts';
import { esc, must } from './dom.ts';
import { modal, toast, toastAction } from './overlays.ts';

interface Imported { tabName: string; created: boolean; added: number; merged: number; warnings: string[]; undo: () => void }

/**
 * "Add branch from replay": reads a Pokémon Showdown replay, checks both teams are exactly this gameplan's, and adds
 * what happened as a branch, in the tab with the same leads and backs (or a new one), which then opens.
 */
export async function openReplayImport(): Promise<void> {
  const team = store.team;
  const plan = store.plan;
  if (!team || !plan) return;
  const done = await modal<Imported>({
    title: 'Add branch from replay',
    desc: 'Paste a Pokémon Showdown replay link. Both teams must be exactly this gameplan’s: the same Pokémon, items, abilities and moves.',
    body: `<div><label class="lbl" for="rp-url">Replay link</label><input class="field" id="rp-url" placeholder="https://replay.pokemonshowdown.com/…" autocomplete="off"></div>
      <label class="oc-check mt-s"><input type="checkbox" id="rp-new">Put it in a new plan tab, even if one has the same leads and backs</label>
      <div class="hint" id="rp-status" role="status"></div>
      <div class="hint err-text replay-errors" id="rp-err" role="alert"></div>`,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Add branch', cls: 'primary',
        run: async (ov) => {
          const status = must('#rp-status', ov);
          const err = must('#rp-err', ov);
          err.textContent = '';
          const link = parseReplayLink(must<HTMLInputElement>('#rp-url', ov).value);
          if (!link) { err.textContent = 'That isn’t a Pokémon Showdown replay link (replay.pokemonshowdown.com/…).'; return false; }
          try {
            status.textContent = 'Loading the replay…';
            const [log, engine] = await Promise.all([fetchReplayLog(link), simService.ready()]);
            status.textContent = 'Checking the teams…';
            const moveInfo = (n: string) => engine.moveInfo(n);
            const parsed = parseReplayLog(log, { always: alwaysEffect(moveInfo) });
            const branch = buildReplayBranch(parsed, { team: teamMons(team), opponent: oppMons(plan), moveInfo }, link.url);
            const before = structuredClone(plan.tabs);
            const previousTab = store.ui.tabId;
            const placed = placeReplayBranch(plan, branch, must<HTMLInputElement>('#rp-new', ov).checked);
            Object.assign(store.ui, { tabId: placed.tab.id, selectedNode: null, scrollX: 0, scrollY: 0 });
            store.persist();
            return {
              tabName: placed.tab.name, created: placed.created, added: placed.added, merged: placed.merged,
              warnings: [...branch.warnings, ...checkTurns(placed.tab, branch.turns)],
              undo: () => { plan.tabs = before; store.ui.tabId = previousTab; store.persist(); requestRender(); },
            };
          } catch (e) {
            status.textContent = '';
            err.textContent = e instanceof ReplayError || e instanceof Error ? e.message : String(e);
            return false;
          }
        },
      },
    ],
  });
  if (!done) return;
  requestRender();
  const where = `${done.created ? 'a new tab' : 'the tab'} “${done.tabName}”`;
  const what = done.added ? `Added ${done.added} turn${done.added === 1 ? '' : 's'} to ${where}` : `This replay is already in ${where}`;
  toastAction(done.merged && done.added ? `${what} (${done.merged} already there)` : what, 'Undo', done.undo);
  if (done.warnings.length) toast(done.warnings.slice(0, 3).join(' · ') + (done.warnings.length > 3 ? ` (+${done.warnings.length - 3} more)` : ''), true);
}

/** Turns of the new branch that don't simulate cleanly (they still show, with what's missing). */
function checkTurns(tab: PlanTab, turns: readonly FlowNode[]): string[] {
  const team = store.team;
  const plan = store.plan;
  if (!team || !plan) return [];
  const view = simService.compute(team, sheetOf(plan, tab), true);
  if (!view.enabled || view.status !== 'ready') return [];
  return turns.flatMap((n, i) => {
    const r = view.results.get(n.id);
    if (!r || r.status === 'ready' || r.status === 'blocked') return [];
    return [`Turn ${i + 1}: ${r.status === 'error' ? r.message : r.missing[0] ?? 'incomplete'}`];
  });
}

export const REPLAY_BUTTON = `<button class="btn" data-act="replay-import" title="Add what happened in a Pokémon Showdown replay as a branch">${esc('Add branch from replay')}</button>`;
