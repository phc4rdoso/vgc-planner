# VGC Gameplan Planner

Plan VGC matchups as flowchart gameplans for Pokémon Champions (Regulation M-C). Teams are folders; each folder holds one gameplan per opponent. A gameplan starts from both teams' leads and branches turn by turn. When both teams have Stat Points (the `EVs:` lines of a Showdown paste), every turn shows the resulting damage, order, stat changes and remaining HP, calculated with the official Smogon damage calculator.

## Quick start

Requires Node 22.12 or newer.

```bash
npm install
npm run dev          # http://localhost:5173
```

Icons load straight from the public sprite repository in development. For production, copy them next to the app (see [Sprites](#sprites)).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Type-check, then build to `dist/` |
| `npm run preview` | Serve the production build on :4173 |
| `npm run typecheck` | Strict TypeScript for the app, and for tests/config |
| `npm run lint` | ESLint |
| `npm run format` | Prettier (write) |
| `npm test` | Unit tests (Node's built-in runner, no extra dependencies) |
| `npm run test:e2e` | Browser smoke test against a running build (`BASE_URL` to change host) |
| `npm run sprites` | Copy Pokémon/item sprites into `public/sprites` |
| `npm run check` | typecheck + lint + tests (what CI runs) |
| `npm run dev:api` | The API Worker locally on :8787 (see [Accounts](#accounts-sign-in-with-discord-or-google)) |
| `npm run db:migrate:local` | Create or update the local database tables |

## Project layout

```
src/
  domain/              Pure logic. No DOM, no browser APIs, so it can also run on a server.
    types.ts             Team / Plan / FlowNode / TurnAction data model
    showdown.ts          Showdown paste parser
    stats.ts             Stat Points and the Champions stat formula
    model.ts             Factories and tree helpers
    codec.ts             Validated reading/writing of stored data and export files, with size limits
    simulation/          Turn simulation (order, damage, boosts, HP carry-over) on top of the calculator
  infra/               Things that touch the outside world
    repository.ts        LibraryRepository interface + localStorage and in-memory implementations
    prefs.ts             View preferences (kept apart from user data)
    calc-loader.ts       Lazy import of @smogon/calc
    sprites.ts           Sprite URL building
  state/               AppStore (library + view state + debounced saving) and SimService (calculator lifecycle, caching)
  ui/                  Rendering and event handling; views/ has one module per screen area
  styles/              Plain CSS split by concern
server/                API Worker: sign-in and sessions (src/app.ts), account library (src/library.ts), D1 store, migrations
tests/                 Unit tests (+ helpers/stub-calc.ts, a deterministic stand-in for the calculator)
e2e/                   Playwright smoke test
deploy/                nginx config and security headers
```

Dependencies point one way: `ui` → `state` → `infra`/`domain`; `domain` imports nothing from the rest. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning and the path to a server backend.

## Data

- **Storage:** the library is saved through a `LibraryRepository` (browser `localStorage` today). Unreadable saved data is never overwritten: a copy is kept under a backup key and the app tells you.
- **Export/import:** JSON with `format: "vgc-gameplan-planner"` and a `version`. Imports are validated field by field and capped (teams, plans, turns, nesting depth, text length). Teams are merged by name, so an exported gameplan lands in the right folder.
- **Compatibility:** data saved by the earlier single-file version is picked up automatically when this app runs on the same origin. Browsers keep storage per origin (a `file://` copy and a server are different origins), so in that case use **Export all** in the old version and **Import JSON** here.

## Turn results

Needs an `EVs:` line on every Pokémon in both pastes. Champions pastes put Stat Points there (max 32 per stat, 66 total); larger numbers are read as real EVs and converted (4 for the first point, 8 for each after). Level is 50, IVs are 31.

Modeled: turn order (switches, priority, speed, Choice Scarf, Tailwind, Trick Room), Protect/Wide Guard/Quick Guard, Fake Out flinch, Helping Hand, Mega Evolution, Intimidate, weather/terrain/screens (from moves and lead abilities), setup moves, always-on stat drops, spread-move reduction, and HP/stat stages carried down each branch.

Not modeled: accuracy, critical hits, recoil, recovery, status conditions, items that trigger mid-turn, abilities with triggers, and anything specific to Champions balance changes that the calculator doesn't know. HP uses the average damage roll; the range is shown next to it.

## Sprites

Icons are third-party artwork. `npm run sprites` copies `pokemon-champions/` and `items/` from `robsonbittencourt/vgc-multicalc` into `public/sprites/` (git-ignored). Check the licence/permission before redistributing them. Without them the app still works and shows letter badges. To use a CDN instead, set `VITE_SPRITE_BASE_URL` at build time and add the origin to `img-src` in `deploy/security-headers.inc`.

## Deployment

The build is a static site (`dist/`): any static host works. Requirements: serve `index.html` for unknown paths, and keep the Content-Security-Policy from `deploy/security-headers.inc` (the app has no inline scripts or styles).

```bash
npm run sprites          # optional but recommended
docker build -t vgc-gameplan-planner .
docker run -p 8080:8080 vgc-gameplan-planner     # http://localhost:8080, health check at /healthz
```

The image runs nginx as a non-root user, fingerprinted assets are cached for a year, `index.html` is never cached. Commit `package-lock.json` (created by the first `npm install`) so `npm ci` gives reproducible builds.

## Accounts (sign in with Discord or Google)

Accounts are optional: without the API the app works on this device only, and the sign-in button is hidden. The API is a Cloudflare Worker (`server/`) with a D1 (SQLite) database. It stores only a provider id and display name per account (no passwords, no e-mail), a hash of each session token, and the account's teams and gameplans.

**How the library syncs.** Signed in, the app loads the whole library in one request and from then on sends only what changed: one small request per edited team or gameplan (about 1.5 s after you stop typing), plus deletions. The sidebar shows "Saving…" / "All changes saved". Damage and turn results are never stored; the browser recomputes them. Each record has a version, so if the same gameplan is edited on two devices, the later save is refused with a message to reload instead of overwriting the other. Signed out, the app uses this device's own library; on the first sign-in from a device that has gameplans, it offers once to add them to the account (merged like an import).

**Share links.** **Share** (top bar of a gameplan, or its ⋯ menu) creates a read-only link, `<APP_URL>/?share=<token>`, with a 256-bit random token. It shows the gameplan as it is now (all tabs, plus its team's name and paste) and the owner's display name, never ids. Opening it signed in (not as the owner) offers to add a copy to your gameplans; signed out, you can save it on this device or sign in first (the link is remembered through sign-in). The copy gets new ids; it joins your team of the same name only if the paste matches, otherwise it gets its own team "Name (from Owner)". **Stop sharing**, or deleting the gameplan or its team, makes the link stop working.

**Limits per account:** 200 teams, 1,000 gameplans, 5 MB in total, 512 KB per request. Every upload is validated with the same rules as JSON imports (`src/domain/codec.ts`).

**Run it locally**

```bash
cp .dev.vars.example .dev.vars   # then fill in what you have (see below)
npm run build                    # the Worker serves dist/ next to the API
npm run db:migrate:local         # creates the tables in a local database (.wrangler/)
npm run dev:api                  # API on :8787
npm run dev                      # app on :5173; /api is proxied to the Worker
```

With `DEV_LOGIN=true` (local addresses only) the sign-in box offers a **local test account** that needs just a name, so you can try accounts and the first-login tour without any OAuth app.

**Discord.** In the [Discord Developer Portal](https://discord.com/developers/applications) create an application. Under OAuth2, copy the Client ID and Client Secret into `.dev.vars` and add the redirect `http://localhost:5173/api/auth/discord/callback`. The app asks for the `identify` scope only.

**Google.** In Google Cloud Console → APIs & Services → Credentials, create an OAuth client ID of type "Web application". Add the redirect `http://localhost:5173/api/auth/google/callback`, configure the consent screen, and copy the Client ID and Client Secret into `.dev.vars`. Scopes: `openid profile`.

**Deploy**

```bash
npx wrangler d1 create vgc-gameplans                        # put the printed database_id in wrangler.toml
npx wrangler d1 migrations apply vgc-gameplans --remote
npx wrangler secret put DISCORD_CLIENT_ID                   # and DISCORD_CLIENT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
npm run build && npx wrangler deploy
```

Set `APP_URL` in `wrangler.toml` to the site's https address and register `<APP_URL>/api/auth/<provider>/callback` with each provider. Never set `DEV_LOGIN` in production; the Worker also refuses it on non-local addresses.

## Status of this repository (read before first use)

Checked in the environment where this was written: strict type-check of the app, 42 unit tests, and a Chromium run of the real UI under the strict CSP using a stand-in calculator.

**Not run there (no network or tools):** `npm install`, `vite build`, ESLint, Prettier, `docker build`, the CI workflow, and the real `@smogon/calc`. In particular:

- `@smogon/calc` is pinned to `^0.12.0`, the version a Champions calculator site documents as containing Champions support. If `npm install` can't find it, check `npm view @smogon/calc versions`. At runtime the app verifies that the loaded build has a Champions mode (generation 0, checked through its stat formula) and shows a banner if not; stats are always computed by this app, so they stay correct either way.
- Some builds of the calculator applied a slightly different stat-stage table in Champions (rounding-level differences). Prefer a recent version.
- Item sprite file names (`items/`) are lowercase and hyphenated (`choice-scarf.webp`); Pokémon files keep Showdown spelling, including spaces (`Mr. Mime.webp`). Missing icons simply don't show.
- Run `npm run format` once, then `npm run check`; the code was written to Prettier's conventions but not run through it.
