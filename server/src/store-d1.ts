import type { Store, User } from './app.ts';
import type { PutResult, StoredPlan, StoredTeam } from './library.ts';
import type { SharedRecord } from './shares.ts';

interface UserRow { id: string; provider: User['provider']; provider_id: string; name: string; created_at: number; onboarded_at: number | null }

const toUser = (r: UserRow): User => ({
  id: r.id, provider: r.provider, providerId: r.provider_id, name: r.name, createdAt: r.created_at, onboardedAt: r.onboarded_at,
});

/** {@link Store} on Cloudflare D1 (SQLite). Every query is parameterised. */
export class D1Store implements Store {
  private readonly db: D1Database;

  constructor(db: D1Database) { this.db = db; }

  async upsertUser(provider: User['provider'], providerId: string, name: string, now: number): Promise<{ user: User; created: boolean }> {
    const inserted = await this.db
      .prepare('INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider, provider_id) DO NOTHING')
      .bind(crypto.randomUUID(), provider, providerId, name, now)
      .run();
    const created = (inserted.meta.changes ?? 0) > 0;
    // Returning users keep their account; their display name follows the provider.
    if (!created) await this.db.prepare('UPDATE users SET name = ? WHERE provider = ? AND provider_id = ?').bind(name, provider, providerId).run();
    const row = await this.db.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?').bind(provider, providerId).first<UserRow>();
    if (!row) throw new Error('user upsert failed');
    return { user: toUser(row), created };
  }

  async createSession(tokenHash: string, userId: string, expiresAt: number, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(userId, now),
      this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(tokenHash, userId, expiresAt),
    ]);
  }

  async sessionUser(tokenHash: string, now: number): Promise<User | null> {
    const row = await this.db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
      .bind(tokenHash, now)
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }

  async markOnboarded(userId: string, now: number): Promise<void> {
    await this.db.prepare('UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?').bind(now, userId).run();
  }

  /* ------------------------------- library ------------------------------- */

  async loadLibrary(userId: string): Promise<{ teams: StoredTeam[]; plans: StoredPlan[] }> {
    const [teams, plans] = await this.db.batch<Record<string, unknown>>([
      this.db.prepare('SELECT id, position, data, version FROM teams WHERE user_id = ?').bind(userId),
      this.db.prepare('SELECT id, team_id, position, data, version FROM plans WHERE user_id = ?').bind(userId),
    ]);
    return {
      teams: (teams?.results ?? []).map((r) => ({ id: String(r.id), position: Number(r.position), data: String(r.data), version: Number(r.version) })),
      plans: (plans?.results ?? []).map((r) => ({ id: String(r.id), teamId: String(r.team_id), position: Number(r.position), data: String(r.data), version: Number(r.version) })),
    };
  }

  async usage(userId: string): Promise<{ teams: number; plans: number; bytes: number }> {
    const row = await this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM teams WHERE user_id = ?1) AS teams,
        (SELECT COUNT(*) FROM plans WHERE user_id = ?1) AS plans,
        (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM teams WHERE user_id = ?1) + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM plans WHERE user_id = ?1) AS bytes`)
      .bind(userId).first<{ teams: number; plans: number; bytes: number }>();
    return { teams: Number(row?.teams ?? 0), plans: Number(row?.plans ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  /** Insert when new (baseVersion 0), otherwise update only if the stored version still matches. */
  private async put(table: 'teams' | 'plans', userId: string, id: string, baseVersion: number, insert: D1PreparedStatement, update: D1PreparedStatement): Promise<PutResult> {
    const result = await (baseVersion === 0 ? insert : update).run();
    if ((result.meta.changes ?? 0) > 0) return { ok: true, version: baseVersion + 1 };
    const current = await this.db.prepare(`SELECT version FROM ${table} WHERE user_id = ? AND id = ?`).bind(userId, id).first<{ version: number }>();
    return { ok: false, version: current ? Number(current.version) : null };
  }

  putTeam(userId: string, team: Omit<StoredTeam, 'version'>, baseVersion: number, now: number): Promise<PutResult> {
    return this.put('teams', userId, team.id, baseVersion,
      this.db.prepare('INSERT INTO teams (user_id, id, position, data, version, updated_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT (user_id, id) DO NOTHING')
        .bind(userId, team.id, team.position, team.data, now),
      this.db.prepare('UPDATE teams SET position = ?, data = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND id = ? AND version = ?')
        .bind(team.position, team.data, now, userId, team.id, baseVersion));
  }

  async deleteTeam(userId: string, id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM shares WHERE user_id = ? AND plan_id IN (SELECT id FROM plans WHERE user_id = ? AND team_id = ?)').bind(userId, userId, id),
      this.db.prepare('DELETE FROM plans WHERE user_id = ? AND team_id = ?').bind(userId, id),
      this.db.prepare('DELETE FROM teams WHERE user_id = ? AND id = ?').bind(userId, id),
    ]);
  }

  async putPlan(userId: string, plan: Omit<StoredPlan, 'version'>, baseVersion: number, now: number): Promise<PutResult | null> {
    const team = await this.db.prepare('SELECT 1 AS ok FROM teams WHERE user_id = ? AND id = ?').bind(userId, plan.teamId).first();
    if (!team) return null;
    return this.put('plans', userId, plan.id, baseVersion,
      this.db.prepare('INSERT INTO plans (user_id, id, team_id, position, data, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT (user_id, id) DO NOTHING')
        .bind(userId, plan.id, plan.teamId, plan.position, plan.data, now),
      this.db.prepare('UPDATE plans SET team_id = ?, position = ?, data = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND id = ? AND version = ?')
        .bind(plan.teamId, plan.position, plan.data, now, userId, plan.id, baseVersion));
  }

  async deletePlan(userId: string, id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM shares WHERE user_id = ? AND plan_id = ?').bind(userId, id),
      this.db.prepare('DELETE FROM plans WHERE user_id = ? AND id = ?').bind(userId, id),
    ]);
  }

  /* -------------------------------- shares -------------------------------- */

  async shareToken(userId: string, planId: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT token FROM shares WHERE user_id = ? AND plan_id = ?').bind(userId, planId).first<{ token: string }>();
    return row?.token ?? null;
  }

  async createShare(userId: string, planId: string, token: string, now: number): Promise<boolean> {
    const plan = await this.db.prepare('SELECT 1 AS ok FROM plans WHERE user_id = ? AND id = ?').bind(userId, planId).first();
    if (!plan) return false;
    await this.db.prepare('INSERT INTO shares (token, user_id, plan_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, plan_id) DO NOTHING')
      .bind(token, userId, planId, now).run();
    return true;
  }

  async deleteShare(userId: string, planId: string): Promise<void> {
    await this.db.prepare('DELETE FROM shares WHERE user_id = ? AND plan_id = ?').bind(userId, planId).run();
  }

  async listShares(userId: string): Promise<{ planId: string; token: string; createdAt: number }[]> {
    const rows = await this.db.prepare('SELECT plan_id, token, created_at FROM shares WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all<{ plan_id: string; token: string; created_at: number }>();
    return (rows.results ?? []).map((r) => ({ planId: r.plan_id, token: r.token, createdAt: Number(r.created_at) }));
  }

  async readShare(token: string): Promise<SharedRecord | null> {
    const row = await this.db.prepare(`SELECT s.user_id AS owner_id, u.name AS owner_name, p.id AS plan_id, p.data AS plan_data, t.data AS team_data
        FROM shares s JOIN users u ON u.id = s.user_id
        JOIN plans p ON p.user_id = s.user_id AND p.id = s.plan_id
        JOIN teams t ON t.user_id = p.user_id AND t.id = p.team_id
        WHERE s.token = ?`).bind(token).first<{ owner_id: string; owner_name: string; plan_id: string; plan_data: string; team_data: string }>();
    return row ? { ownerId: row.owner_id, ownerName: row.owner_name, planId: row.plan_id, team: { data: row.team_data }, plan: { data: row.plan_data } } : null;
  }
}
