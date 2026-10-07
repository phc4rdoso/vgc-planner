/** An in-memory stand-in for the D1 store, with the same behaviour (versions, per-user scoping, cascade). */
import type { Store, User } from '../../server/src/app.ts';
import type { PutResult, StoredPlan, StoredTeam } from '../../server/src/library.ts';

type Scoped<T> = T & { userId: string };

export class MemoryStore implements Store {
  users: User[] = [];
  /** Users who picked their own display name (sign-ins keep it). */
  customNames = new Set<string>();
  sessions = new Map<string, { userId: string; expiresAt: number }>();
  teams: Scoped<StoredTeam>[] = [];
  plans: Scoped<StoredPlan>[] = [];

  async upsertUser(provider: User['provider'], providerId: string, name: string, now: number, avatar = 'Pikachu') {
    const found = this.users.find((u) => u.provider === provider && u.providerId === providerId);
    if (found) { if (!this.customNames.has(found.id)) found.name = name; return { user: { ...found }, created: false }; }
    const user: User = { id: `u${this.users.length + 1}`, provider, providerId, name, createdAt: now, onboardedAt: null, avatar };
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
  async setName(userId: string, name: string) { const u = this.users.find((x) => x.id === userId); if (u) { u.name = name; this.customNames.add(userId); } }
  async setAvatar(userId: string, avatar: string) { const u = this.users.find((x) => x.id === userId); if (u) u.avatar = avatar; }
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
    this.dropOrphanShares();
  }
  async putPlan(userId: string, plan: Omit<StoredPlan, 'version'>, baseVersion: number) {
    if (!this.teams.some((t) => t.userId === userId && t.id === plan.teamId)) return null;
    return this.put(this.plans, userId, plan, baseVersion);
  }
  async deletePlan(userId: string, id: string) {
    this.plans = this.plans.filter((p) => !(p.userId === userId && p.id === id));
    this.dropOrphanShares();
  }

  shares: { token: string; userId: string; planId: string; createdAt: number }[] = [];
  /** Like the foreign key: a link ends with its gameplan. */
  private dropOrphanShares() { this.shares = this.shares.filter((s) => this.plans.some((p) => p.userId === s.userId && p.id === s.planId)); }
  async shareToken(userId: string, planId: string) { return this.shares.find((s) => s.userId === userId && s.planId === planId)?.token ?? null; }
  async createShare(userId: string, planId: string, token: string, now = 0) {
    if (!this.plans.some((p) => p.userId === userId && p.id === planId)) return false;
    if (!this.shares.some((s) => s.userId === userId && s.planId === planId)) this.shares.push({ token, userId, planId, createdAt: now });
    return true;
  }
  async listShares(userId: string) {
    return this.shares.filter((s) => s.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map(({ planId, token, createdAt }) => ({ planId, token, createdAt }));
  }
  async deleteShare(userId: string, planId: string) { this.shares = this.shares.filter((s) => !(s.userId === userId && s.planId === planId)); }
  async readShare(token: string) {
    const share = this.shares.find((s) => s.token === token);
    const plan = share && this.plans.find((p) => p.userId === share.userId && p.id === share.planId);
    const team = plan && this.teams.find((t) => t.userId === plan.userId && t.id === plan.teamId);
    const owner = share && this.users.find((u) => u.id === share.userId);
    return share && plan && team && owner ? { ownerId: owner.id, ownerName: owner.name, planId: plan.id, team: { data: team.data }, plan: { data: plan.data } } : null;
  }
}
