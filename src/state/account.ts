import type { AccountState } from '../infra/auth.ts';

/**
 * The signed-in account (or why there is none), loaded once on startup and updated by sign-in / sign-out; and
 * which of its gameplans are shared by link (gameplan id -> link token), so the UI can mark them.
 */
export const session: { state: AccountState | null; shared: Map<string, string> } = { state: null, shared: new Map() };
