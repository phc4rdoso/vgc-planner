import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newNode, newPlan, newTeam, sheetOf } from '../src/domain/model.ts';
import type { CalcLib } from '../src/domain/simulation/calc-types.ts';
import type { TurnResult } from '../src/domain/simulation/log.ts';
import { SimService } from '../src/state/sim-service.ts';
import type { SimView } from '../src/state/sim-service.ts';
import { makeStubCalc } from './helpers/stub-calc.ts';

const paste = (names: string[]): string => names.map((n) => `${n}\nAbility: Pressure\nEVs: 32 HP\n- Protect`).join('\n\n');
const setup = (): { team: ReturnType<typeof newTeam>; plan: ReturnType<typeof sheetOf> } => {
  const team = newTeam('T', paste(['Rillaboom', 'Garchomp']));
  const gameplan = newPlan('p', paste(['Incineroar', 'Kingambit']));
  const plan = sheetOf(gameplan, gameplan.tabs[0]!);
  plan.children.push(newNode());
  return { team, plan };
};
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('stays off, with reasons, until both pastes have EVs', () => {
  const { team, plan } = setup();
  plan.opponent.paste = 'Incineroar\n- Protect';
  const service = new SimService(() => Promise.reject(new Error('should not load')));
  const view = service.compute(team, plan);
  assert.equal(view.enabled, false);
});

test('loads the calculator lazily, notifies once, and caches results until inputs change', async () => {
  const { team, plan } = setup();
  let loads = 0; let notified = 0;
  const service = new SimService(() => { loads++; return Promise.resolve(makeStubCalc().lib); });
  service.onChange = () => { notified++; };

  assert.deepEqual(service.compute(team, plan), { enabled: true, status: 'loading' });
  service.compute(team, plan);
  await tick();
  assert.equal(loads, 1, 'only one load, however often it is asked');
  assert.equal(notified, 1);

  const results = (view: SimView): Map<string, TurnResult> => {
    assert.ok(view.enabled && view.status === 'ready', 'expected a ready view');
    return view.enabled && view.status === 'ready' ? view.results : new Map();
  };
  const first = results(service.compute(team, plan));
  assert.equal(results(service.compute(team, plan)), first, 'same inputs reuse the cached results');
  plan.children[0]!.note = 'changed';
  const third = results(service.compute(team, plan));
  assert.notEqual(third, first, 'edited plan is recomputed');
  assert.notEqual(results(service.compute(team, plan, true)), third, 'force bypasses the cache');
});

test('reports a load failure and retries when forced', async () => {
  const { team, plan } = setup();
  let attempts = 0;
  const service = new SimService((): Promise<CalcLib> => { attempts++; return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(makeStubCalc().lib); });
  service.compute(team, plan);
  await tick();
  const failed = service.compute(team, plan);
  assert.ok(failed.enabled && failed.status === 'error' && /offline/.test(failed.message));
  assert.equal(service.compute(team, plan, true).enabled && 'loading', 'loading', 'retry starts a new load');
  await tick();
  const ok = service.compute(team, plan);
  assert.ok(ok.enabled && ok.status === 'ready');
  assert.equal(attempts, 2);
});
