import type { ActionOutcome, TargetOutcome, TurnAction } from '../domain/types.ts';

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Drops empty parts, so an outcome left as "as expected" disappears from the saved turn. */
function tidy(action: TurnAction): void {
  const o = action.outcome;
  if (!o) return;
  for (const [name, t] of Object.entries(o.targets ?? {})) if (!Object.keys(t).length) delete o.targets![name];
  if (o.targets && !Object.keys(o.targets).length) delete o.targets;
  if (o.self && !o.self.length) delete o.self;
  if (!Object.keys(o).length) delete action.outcome;
}

/**
 * Writes one field of the "Chance results" editor into the action: `kind` is the field (cant, hits, protectWorks,
 * miss, crit, effect, hp), `target` the Pokémon a per-target field is about.
 */
export function setOutcome(action: TurnAction, kind: string, target: string, field: Field): void {
  const o: ActionOutcome = (action.outcome ??= {});
  const checked = field instanceof HTMLInputElement && field.type === 'checkbox' ? field.checked : false;
  const one = (): TargetOutcome => ((o.targets ??= {})[target] ??= {});
  switch (kind) {
    case 'cant': {
      delete o.cant; delete o.wake;
      if (field.value === 'wake') o.wake = true;
      else if (['par', 'slp', 'frz', 'confusion', 'flinch'].includes(field.value)) o.cant = field.value as NonNullable<ActionOutcome['cant']>;
      break;
    }
    case 'hits': {
      const n = Number(field.value);
      if (Number.isInteger(n) && n >= 1 && n <= 10) o.hits = n; else delete o.hits;
      break;
    }
    case 'protectWorks': if (checked) o.protectWorks = true; else delete o.protectWorks; break;
    case 'miss': if (checked) one().miss = true; else delete one().miss; break;
    case 'crit': if (checked) one().crit = true; else delete one().crit; break;
    case 'effect': if (field.value) one().effects = [field.value]; else delete one().effects; break;
    case 'self': if (field.value) o.self = [field.value]; else delete o.self; break;
    case 'hp': {
      const raw = field.value.trim();
      const n = Number(raw);
      if (raw !== '' && Number.isFinite(n)) one().hp = Math.max(0, Math.min(100, n)); else delete one().hp;
      break;
    }
    default: break;
  }
  tidy(action);
}
