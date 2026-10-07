/**
 * A gameplan received through a share link. The server sends it in its stored shape; here it is turned into an
 * export file and read like any import, so it is validated and capped, and gets fresh ids (the copy is the
 * viewer's own, unrelated to the owner's records).
 */
import { DataError, EXPORT_FORMAT, EXPORT_VERSION, readExport } from './codec.ts';
import type { ParsedExport } from './codec.ts';

export interface SharedPlan {
  /** The owner's display name. */
  owner: string;
  /** True when the viewer is the owner; `planId` is then their own gameplan's id. */
  isOwner: boolean;
  planId: string | null;
  /** One team holding the one shared gameplan, ready for `mergeImport`. */
  parsed: ParsedExport;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});

export function readSharedPlan(raw: unknown): SharedPlan {
  const body = obj(raw);
  const team = obj(body.team);
  const plan = obj(body.plan);
  if (!Array.isArray(plan.tabs)) throw new DataError('The shared gameplan is missing its tabs.');
  const parsed = readExport({
    format: EXPORT_FORMAT, version: EXPORT_VERSION,
    teams: [{
      name: team.name, paste: team.paste,
      plans: [{ name: plan.name, opponent: plan.opponent, tabs: plan.tabs.map((t) => ({ name: obj(t).name, selection: obj(t).selection, flow: obj(t).children, ...(t.entryTieOrder ? { entryTieOrder: t.entryTieOrder } : {}) })) }],
    }],
  });
  return {
    owner: typeof body.owner === 'string' && body.owner.trim() ? body.owner.trim().slice(0, 64) : 'Someone',
    isOwner: body.isOwner === true,
    planId: typeof body.planId === 'string' ? body.planId : null,
    parsed,
  };
}
