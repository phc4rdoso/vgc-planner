/**
 * A signed-in user's teams and gameplans. The browser does all the planning and simulating; the server only
 * validates and stores what the user typed, one team or gameplan at a time, so requests stay small.
 *
 * Routes (all need a session; the caller has already checked the Origin of PUT/DELETE):
 *   GET    /api/library      everything, in order
 *   PUT    /api/teams/:id    { baseVersion, position, name, paste }
 *   DELETE /api/teams/:id    also deletes its gameplans
 *   PUT    /api/plans/:id    { baseVersion, position, teamId, name, opponent, tabs }
 *   DELETE /api/plans/:id
 * `baseVersion` is the version the client last saw (0 for a new record). If the stored one differs, the write is
 * refused with 409 and the current version, so edits from two devices never silently overwrite each other.
 */
import { DataError, readPlanRecord, readTeamFields } from '../../src/domain/codec.ts';

export interface StoredTeam { id: string; position: number; data: string; version: number }
export interface StoredPlan { id: string; teamId: string; position: number; data: string; version: number }

/** `version` is the new version on success, or the current one (null: no longer exists) on a conflict. */
export type PutResult = { ok: true; version: number } | { ok: false; version: number | null };

export interface LibraryStore {
  loadLibrary(userId: string): Promise<{ teams: StoredTeam[]; plans: StoredPlan[] }>;
  usage(userId: string): Promise<{ teams: number; plans: number; bytes: number }>;
  putTeam(userId: string, team: Omit<StoredTeam, 'version'>, baseVersion: number, now: number): Promise<PutResult>;
  deleteTeam(userId: string, id: string): Promise<void>;
  /** `null` when the gameplan's team doesn't exist (save the team first). */
  putPlan(userId: string, plan: Omit<StoredPlan, 'version'>, baseVersion: number, now: number): Promise<PutResult | null>;
  deletePlan(userId: string, id: string): Promise<void>;
}

/** Per-account limits that keep storage (and abuse) bounded. */
export const QUOTA = { teams: 200, plans: 1000, bytes: 5 * 1024 * 1024, bodyBytes: 512 * 1024 } as const;

const ID = /^[A-Za-z0-9-]{1,64}$/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

/** Reads a JSON body no larger than the per-request limit. */
async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(req.headers.get('Content-Length') ?? 0);
  if (declared > QUOTA.bodyBytes) return json({ error: 'too large' }, 413);
  const text = await req.text();
  if (new TextEncoder().encode(text).length > QUOTA.bodyBytes) return json({ error: 'too large' }, 413);
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ error: 'expected an object' }, 400);
    return body as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
}

const intField = (body: Record<string, unknown>, key: string, max: number): number | null => {
  const v = body[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
};

const conflict = (current: number | null): Response => json({ error: 'conflict', version: current }, 409);

/** Handles the library routes for `userId`; null when the path isn't one of them. */
export async function handleLibrary(req: Request, path: string, userId: string, store: LibraryStore, now: number): Promise<Response | null> {
  if (path === '/api/library') {
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const { teams, plans } = await store.loadLibrary(userId);
    const byTeam = new Map<string, StoredPlan[]>();
    for (const p of [...plans].sort((a, b) => a.position - b.position)) byTeam.set(p.teamId, [...(byTeam.get(p.teamId) ?? []), p]);
    return json({
      teams: [...teams].sort((a, b) => a.position - b.position).map((t) => ({
        ...(JSON.parse(t.data) as object), id: t.id, version: t.version,
        plans: (byTeam.get(t.id) ?? []).map((p) => ({ ...(JSON.parse(p.data) as object), id: p.id, version: p.version })),
      })),
    });
  }

  const match = path.match(/^\/api\/(teams|plans)\/([^/]+)$/);
  if (!match) return null;
  const [, kind, id] = match as unknown as [string, 'teams' | 'plans', string];
  if (!ID.test(id)) return json({ error: 'invalid id' }, 400);

  if (req.method === 'DELETE') {
    await (kind === 'teams' ? store.deleteTeam(userId, id) : store.deletePlan(userId, id));
    return json({ ok: true });
  }
  if (req.method !== 'PUT') return json({ error: 'method not allowed' }, 405);

  const body = await readBody(req);
  if (body instanceof Response) return body;
  const baseVersion = intField(body, 'baseVersion', Number.MAX_SAFE_INTEGER);
  const position = intField(body, 'position', 100_000);
  if (baseVersion === null || position === null) return json({ error: 'baseVersion and position must be whole numbers' }, 400);

  let data: string;
  try {
    if (kind === 'teams') data = JSON.stringify(readTeamFields(body));
    else {
      const plan = readPlanRecord(body, id);
      data = JSON.stringify({ name: plan.name, opponent: plan.opponent, tabs: plan.tabs });
    }
  } catch (e) {
    return json({ error: e instanceof DataError ? e.message : 'invalid data' }, 400);
  }

  const usage = await store.usage(userId);
  if (usage.bytes + data.length > QUOTA.bytes) return json({ error: 'Your account is full (5 MB). Delete some gameplans first.' }, 413);
  if (baseVersion === 0 && (kind === 'teams' ? usage.teams >= QUOTA.teams : usage.plans >= QUOTA.plans)) {
    return json({ error: `Your account can hold up to ${kind === 'teams' ? `${QUOTA.teams} teams` : `${QUOTA.plans} gameplans`}.` }, 413);
  }

  if (kind === 'teams') {
    const result = await store.putTeam(userId, { id, position, data }, baseVersion, now);
    return result.ok ? json({ version: result.version }) : conflict(result.version);
  }
  const teamId = typeof body.teamId === 'string' && ID.test(body.teamId) ? body.teamId : null;
  if (!teamId) return json({ error: 'invalid teamId' }, 400);
  const result = await store.putPlan(userId, { id, teamId, position, data }, baseVersion, now);
  if (!result) return json({ error: 'team not found' }, 409);
  return result.ok ? json({ version: result.version }) : conflict(result.version);
}
