import type { AccountState } from '../infra/auth.ts';

/** The signed-in account (or why there is none). Loaded once on startup, then updated by sign-in / sign-out. */
export const session: { state: AccountState | null } = { state: null };
