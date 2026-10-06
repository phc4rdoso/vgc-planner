/** An in-memory stand-in for the D1 store, with the same behaviour (versions, per-user scoping, cascade). */
import type { Store, User } from '../../server/src/app.ts';
import type { PutResult, StoredPlan, StoredTeam } from '../../server/src/library.ts';

type Scoped<T> = T & { userId: string };

export class MemoryStore implements Store {
  users: User[] = [];
  sessions = new Map<string, { userId: string; expiresAt: number }>();
  teams: Scoped<StoredTeam>[] = [];
  plans: Scoped<StoredPlan>[] = [];

  async upsertUser(provider: User['provider'], providerId: string, name: string, now: number) {
    const found = this.users.find((u) => u.provider === provider && u.providerId === providerId);
    if (found) { found.name = name; return { user: { ...found }, created: false }; }
    const user: User = { id: `u${this.users.length + 1}`, provider, providerId, name, createdAt: now, onboardedAt: null };
    this.users.push(user);
    return { user: { ...user }, created: true };
  }
  async createSession(hash: string, userId: string, expiresAt: number) { this.sessions.set(hash, { userId, expiresAt }); }
  async sessionUser(hash: string, now: number) {
    const s = this.sessions.get(hash);
    const user = s && s.expiresAt > now ? this.users.find((u) => u.id === s.userId) : undefined;
    return user ? { ...user } : null;
  }
  async deleteSession(hash: string) { this.sessions.delete(hash); }
  async markOnboarded(userId: string, now: number) { const u = this.users.find((x) => x.id === userId); if (u) u.onboardedAt ??= now; }

  async loadLibrary(userId: string) {
    const strip = <T extends { userId: string }>(row: T): Omit<T, 'userId'> => { const { userId, ...rest } = row; void userId; return rest; };
    return {
      teams: this.teams.filter((t) => t.userId === userId).map(strip),
      plans: this.plans.filter((p) => p.userId === userId).map(strip),
    };
  }
  async usage(userId: string) {
    const teams = this.teams.filter((t) => t.userId === userId);
    const plans = this.plans.filter((p) => p.userId === userId);
    return { teams: teams.length, plans: plans.length, bytes: [...teams, ...plans].reduce((n, r) => n + r.data.length, 0) };
  }
  private put<T extends { id: string; version: number; userId: string }>(rows: T[], userId: string, next: Omit<T, 'version' | 'userId'>, baseVersion: number): PutResult {
    const existing = rows.find((r) => r.userId === userId && r.id === next.id);
    if (baseVersion === 0 && !existing) { rows.push({ ...next, userId, version: 1 } as T); return { ok: true, version: 1 }; }
    if (!existing || existing.version !== baseVersion) return { ok: false, version: existing?.version ?? null };
    Object.assign(existing, next, { version: existing.version + 1 });
    return { ok: true, version: existing.version };
  }
  async putTeam(userId: string, team: Omit<StoredTeam, 'version'>, baseVersion: number) { return this.put(this.teams, userId, team, baseVersion); }
  async deleteTeam(userId: string, id: string) {
    this.plans = this.plans.filter((p) => !(p.userId === userId && p.teamId === id));
    this.teams = this.teams.filter((t) => !(t.userId === userId && t.id === id));
  }
  async putPlan(userId: string, plan: Omit<StoredPlan, 'version'>, baseVersion: number) {
    if (!this.teams.some((t) => t.userId === userId && t.id === plan.teamId)) return null;
    return this.put(this.plans, userId, plan, baseVersion);
  }
  async deletePlan(userId: string, id: string) { this.plans = this.plans.filter((p) => !(p.userId === userId && p.id === id)); }
}
