/**
 * Cloudflare Worker entry point: `/api/*` is handled here, everything else is the static app (Workers assets).
 * Configuration comes from wrangler.toml (`APP_URL`) and secrets (`wrangler secret put …`, or `.dev.vars` locally).
 */
import type { ApiConfig, OAuthClient } from './app.ts';
import { handleApi } from './app.ts';
import { D1Store } from './store-d1.ts';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_URL: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "true" only in local development (.dev.vars). */
  DEV_LOGIN?: string;
}

const client = (id: string | undefined, secret: string | undefined): OAuthClient | undefined =>
  id && secret ? { clientId: id, clientSecret: secret } : undefined;

function configOf(env: Env): ApiConfig {
  return {
    appUrl: env.APP_URL,
    providers: { discord: client(env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET), google: client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET) },
    // The development sign-in is refused on anything but a local address, even if the flag leaks into production.
    devLogin: env.DEV_LOGIN === 'true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.APP_URL),
  };
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return handleApi(request, { store: new D1Store(env.DB), config: configOf(env), fetch: (input, init) => fetch(input, init), now: () => Date.now() });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
