import type { Store, User } from './app.ts';

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
}
