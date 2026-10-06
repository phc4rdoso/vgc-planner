import { LIBRARY_SCHEMA_VERSION, readLibrary } from '../domain/codec.ts';
import type { Library, Plan, Team } from '../domain/types.ts';
import type { LibraryRepository } from './repository.ts';
import { RepositoryError } from './repository.ts';

/** What the server last confirmed for one record: its version, and the JSON we sent (to spot changes). */
interface Synced { version: number; json: string }

const teamBody = (team: Team, position: number): string => JSON.stringify({ position, name: team.name, paste: team.paste });
const planBody = (plan: Plan, teamId: string, position: number): string =>
  JSON.stringify({ position, teamId, name: plan.name, opponent: plan.opponent, tabs: plan.tabs });

/** Browsers cap `keepalive` requests (used while the page closes) at 64 KB in flight. */
const KEEPALIVE_LIMIT = 60 * 1024;

/**
 * The signed-in user's library on the server (server/src/library.ts). Loading fetches everything in one request;
 * saving sends only the teams and gameplans that changed since the last confirmed save, then the deletions.
 * Saves run one after another, and a failed save is simply retried with the next one (nothing is marked as saved
 * until the server confirms it).
 */
export class AccountRepository implements LibraryRepository {
  /** Wait a little longer than local saves before sending, so typing doesn't become a stream of requests. */
  readonly saveDelayMs = 1500;
  private readonly http: typeof fetch;
  private teams = new Map<string, Synced>();
  private plans = new Map<string, Synced>();
  private queue: Promise<void> = Promise.resolve();

  constructor(http: typeof fetch = (input, init) => fetch(input, init)) { this.http = http; }

  async load(): Promise<Library> {
    const res = await this.call('GET', '/api/library');
    const body = (await res.json()) as { teams?: unknown };
    let library: Library;
    try {
      library = readLibrary({ schemaVersion: LIBRARY_SCHEMA_VERSION, teams: body.teams });
    } catch (e) {
      throw new RepositoryError(`Your account's data couldn't be read (${e instanceof Error ? e.message : 'unknown error'}).`);
    }
    // Versions come from the server; the JSON is rebuilt the same way saves build it, so unchanged records aren't re-sent.
    const versions = new Map<string, number>();
    for (const t of Array.isArray(body.teams) ? body.teams as { id?: unknown; version?: unknown; plans?: unknown }[] : []) {
      versions.set(`team:${String(t.id)}`, Number(t.version));
      for (const p of Array.isArray(t.plans) ? t.plans as { id?: unknown; version?: unknown }[] : []) versions.set(`plan:${String(p.id)}`, Number(p.version));
    }
    this.teams.clear();
    this.plans.clear();
    library.teams.forEach((team, i) => {
      this.teams.set(team.id, { version: versions.get(`team:${team.id}`) ?? 0, json: teamBody(team, i) });
      team.plans.forEach((plan, j) => this.plans.set(plan.id, { version: versions.get(`plan:${plan.id}`) ?? 0, json: planBody(plan, team.id, j) }));
    });
    return library;
  }

  save(library: Library): Promise<void> {
    const snapshot = structuredClone(library);
    const run = this.queue.then(() => this.sync(snapshot));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sync(library: Library): Promise<void> {
    const teamIds = new Set<string>();
    const planIds = new Set<string>();
    // Teams first: a gameplan can only be stored under a team the server already has.
    for (const [i, team] of library.teams.entries()) {
      teamIds.add(team.id);
      await this.put(this.teams, 'teams', team.id, team.name, teamBody(team, i));
    }
    for (const team of library.teams) {
      for (const [j, plan] of team.plans.entries()) {
        planIds.add(plan.id);
        await this.put(this.plans, 'plans', plan.id, plan.name, planBody(plan, team.id, j));
      }
    }
    for (const id of [...this.plans.keys()].filter((p) => !planIds.has(p))) {
      await this.call('DELETE', `/api/plans/${encodeURIComponent(id)}`);
      this.plans.delete(id);
    }
    for (const id of [...this.teams.keys()].filter((t) => !teamIds.has(t))) {
      await this.call('DELETE', `/api/teams/${encodeURIComponent(id)}`);
      this.teams.delete(id);
    }
  }

  private async put(synced: Map<string, Synced>, kind: 'teams' | 'plans', id: string, name: string, json: string): Promise<void> {
    const before = synced.get(id);
    if (before?.json === json) return;
    const body = JSON.stringify({ ...(JSON.parse(json) as object), baseVersion: before?.version ?? 0 });
    const res = await this.call('PUT', `/api/${kind}/${encodeURIComponent(id)}`, body, name);
    const { version } = (await res.json()) as { version: number };
    synced.set(id, { version, json });
  }

  /** One API call; turns every failure into a message the user can act on. */
  private async call(method: string, path: string, body?: string, name = ''): Promise<Response> {
    let res: Response;
    try {
      res = await this.http(path, {
        method, body, credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        keepalive: body !== undefined && body.length < KEEPALIVE_LIMIT,
      });
    } catch {
      throw new RepositoryError("Couldn't reach the server, so your latest changes aren't in your account yet. They'll be sent with your next change.");
    }
    if (res.ok) return res;
    if (res.status === 401) throw new RepositoryError('You were signed out. Sign in again to keep saving to your account.');
    if (res.status === 409) {
      throw new RepositoryError(`${name ? `“${name}”` : 'Something'} was changed on another device or tab. Reload the page to get the latest version; this edit wasn't saved to your account.`);
    }
    const reason = await res.json().then((b: { error?: unknown }) => (typeof b.error === 'string' ? b.error : ''), () => '');
    throw new RepositoryError(reason && res.status < 500 ? reason : `Your account couldn't save this (error ${res.status}). Try again in a moment.`);
  }
}
