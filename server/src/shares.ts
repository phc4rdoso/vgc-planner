/**
 * Read-only links to a gameplan.
 *
 *   GET    /api/plans/:id/share   the link's token for one of your gameplans, or null      (signed in)
 *   POST   /api/plans/:id/share   creates the link (or returns the existing one)          (signed in)
 *   DELETE /api/plans/:id/share   stops sharing: the link stops working                   (signed in)
 *   GET    /api/shares/:token     the shared gameplan with its team, for anyone holding the link
 *
 * A link shows the gameplan as it is now (edits stay visible through the same link). It reveals the gameplan, its
 * team's name and paste, and the owner's display name; never ids of the account or of other records.
 */
import type { StoredPlan } from './library.ts';

export interface SharedRecord {
  ownerId: string;
  ownerName: string;
  planId: string;
  team: { data: string };
  plan: Pick<StoredPlan, 'data'>;
}

export interface ShareStore {
  /** The token of the link to this gameplan, if it is shared. */
  shareToken(userId: string, planId: string): Promise<string | null>;
  /** Creates the link; false when the gameplan isn't in this account (yet). */
  createShare(userId: string, planId: string, token: string, now: number): Promise<boolean>;
  deleteShare(userId: string, planId: string): Promise<void>;
  readShare(token: string): Promise<SharedRecord | null>;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

/**
 * Handles the share routes; null when the path isn't one of them. `userId` is the signed-in user, if any (only
 * reading a link works signed out). `newToken` makes the random link token.
 */
export async function handleShares(req: Request, path: string, userId: string | null, store: ShareStore, now: number, newToken: () => string): Promise<Response | null> {
  const open = path.match(/^\/api\/shares\/([^/]+)$/);
  if (open) {
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const token = open[1]!;
    const shared = TOKEN.test(token) ? await store.readShare(token) : null;
    if (!shared) return json({ error: 'This link doesn’t work any more. Its owner may have stopped sharing it.' }, 404);
    const isOwner = userId === shared.ownerId;
    return json({
      owner: shared.ownerName,
      isOwner,
      // Only the owner needs to know which of their gameplans this is (to open it).
      ...(isOwner ? { planId: shared.planId } : {}),
      team: JSON.parse(shared.team.data) as object,
      plan: JSON.parse(shared.plan.data) as object,
    });
  }

  const own = path.match(/^\/api\/plans\/([^/]+)\/share$/);
  if (!own) return null;
  if (!userId) return json({ error: 'signed out' }, 401);
  const planId = own[1]!;
  if (!ID.test(planId)) return json({ error: 'invalid id' }, 400);

  if (req.method === 'GET') return json({ token: await store.shareToken(userId, planId) });
  if (req.method === 'DELETE') { await store.deleteShare(userId, planId); return json({ ok: true }); }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const existing = await store.shareToken(userId, planId);
  if (existing) return json({ token: existing });
  const token = newToken();
  if (!await store.createShare(userId, planId, token, now)) return json({ error: 'Save the gameplan to your account first, then share it.' }, 409);
  return json({ token });
}
