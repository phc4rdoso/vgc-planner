import { oppMons, teamMons } from '../model.ts';
import type { Plan, Team } from '../types.ts';

export interface Gate { enabled: boolean; reasons: string[] }

/** Turn results need Stat Points: every Pokémon in both pastes must have an "EVs:" line. */
export function turnResultsGate(team: Team, plan: Pick<Plan, 'opponent'>): Gate {
  const reasons: string[] = [];
  const check = (label: 'Your team' | 'Opponent', mons: ReturnType<typeof teamMons>): void => {
    if (!mons.length) { reasons.push(label === 'Your team' ? "add your team's paste" : 'paste the opponent team'); return; }
    const missing = mons.filter((m) => !m.evs).map((m) => m.species);
    if (missing.length) reasons.push(`${label}: add an EVs line for ${missing.join(', ')}`);
  };
  check('Your team', teamMons(team));
  check('Opponent', oppMons(plan));
  return { enabled: reasons.length === 0, reasons };
}
