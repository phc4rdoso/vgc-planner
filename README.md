# VGC Gameplan Planner

Plan VGC matchups as flowchart gameplans for Pokémon Champions (Regulation M-C). Teams are folders; each folder holds one gameplan per opponent. A gameplan starts from both teams' leads and branches turn by turn. When both teams have Stat Points (the `EVs:` lines of a Showdown paste), every turn shows the resulting damage, order, stat changes and remaining HP, calculated with the official Smogon damage calculator.

## Quick start

Requires Node 22.12 or newer.

```bash
npm install
npm run sprites      # once: copies the Pokémon / item sprites into public/sprites (see Sprites)
npm run dev          # http://localhost:5173
```

The app serves every icon itself from `public/sprites`, in development and in production; without the copy it still works and shows letter badges.

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
| `npm run sprites` | Copy the whole vgc-multicalc sprites folder into `public/sprites` |
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

Each branch keeps a full battle state (HP, held item, stat stages, condition, field) and hands it to the calculator for every attack, so damage modifiers (Life Orb, resist berries, Knock Off's power, Multiscale, burn, weather, screens...) come from the calculator itself. The simulator only decides the order things happen in and applies what follows:

- **Order:** switches, then Mega Evolution (fastest first, so a Mega's weather replaces what a switch-in just set), then moves by priority and Speed (Choice Scarf, Unburden, Tailwind, Trick Room, paralysis), then end of turn: weather (Sandstorm, Rain Dish, Dry Skin...), Grassy Terrain and Leftovers / Black Sludge, poison, burn, Speed Boost. Anything that faints in one step is out of the later ones.
- **Items:** used up or removed for the rest of the battle, even after switching (Knock Off, Thief, Trick, Incinerate). Terrain seeds when their terrain comes up, HP berries at their threshold, status berries on the condition, resist berries and Gems when the calculator applied them, Focus Sash, Air Balloon, White Herb, Adrenaline Orb, Rocky Helmet, Life Orb's 10%, weather rocks, Light Clay, Terrain Extender.
- **Abilities:** entry effects (weather, terrain, Intimidate and the abilities that answer it, Hospitality, Download, Intrepid Sword, Costar, Curious Medicine, Screen Cleaner), Defiant / Competitive on any drop from a foe, Contrary and Simple on every stat change, Clear Body and friends, Rough Skin / Iron Barbs, Sturdy, Unburden, Regenerator, Natural Cure, Lightning Rod / Storm Drain and the other absorbing abilities, Sheer Force.
- **Two-turn moves:** Solar Beam / Solar Blade (instant in sun), Electro Shot (+1 Sp. Atk, instant in rain), Meteor Beam, Fly, Dig, Phantom Force and the rest charge on one action and attack on the next, whatever is picked for it; Power Herb skips the charge once, and Fly / Dig / Dive / Phantom Force leave the user out of reach of most moves in between.
- **Moves that fail:** Fake Out after the first turn out, a second Protect in a row, Sucker Punch / Thunderclap when the target isn't attacking or has already moved, Upper Hand without a priority move to answer, Aurora Veil without Snow, Poltergeist, Dream Eater, Focus Punch, Steel Roller, Fling, Burn Up, Snore / Sleep Talk.
- **Power from the battle so far** (passed to the calculator): Last Respects (fainted allies), Rage Fist (hits taken), Stomping Tantrum / Temper Flare (last move failed), Avalanche / Revenge, Assurance, Payback / Bolt Beak / Fishious Rend (by who really moved first). The turn log shows the power used.
- **Moves:** Feint (lifts Protect, Wide Guard and Quick Guard for the rest of the turn), Protect variants (including contact punishment), Wide Guard and Quick Guard, Follow Me / Rage Powder (not on Grass types; a fainted redirector draws nothing), recoil and drain (from the calculator), Fake Out, Helping Hand, setup and stat-lowering moves, status moves, pivots, field moves, spread reduction.

**Speed ties.** When two Pokémon act in the same priority bracket with the same Speed, the game flips a coin. The turn card shows a "Speed tie" tag and the log says who moved first; unless you pick the winner in that Pokémon's "Chance results" in the turn editor, the first action listed (yours, left slot first) is assumed to win. The same goes for Pokémon coming in together: the leads at the start of the battle (picked once per tab) and replacements after a faint, whose entry abilities trigger fastest first; those ties only show when one of them has an entry ability (weather, terrain, Intimidate...). A replay import records the real order instead.

**Chance results.** Accuracy, critical hits and chance effects are not rolled: each move's "Chance results" (in the turn editor) says what happened instead. Per target: a miss, a critical hit, a chance effect (flinch, burn, paralysis, freeze, confusion, a stat drop) and the HP left afterwards; before moving: fully paralysed, still asleep, frozen (in Champions a frozen Pokémon has a 25% chance to thaw each turn and always thaws on its third turn frozen; without a chance result it stays frozen until then), hurt itself in confusion, flinched, or woke up / thawed; the hit count of multi-hit moves; a lucky second Protect. Without them, moves hit, never crit, sleep lasts one turn and nothing else happens by chance. Anything specific to Champions balance changes that the calculator doesn't know isn't modeled. HP uses the average damage roll (the range is shown next to it) unless a turn records it.

## Branches from replays

**Add branch from replay** (top bar of a gameplan) takes a Pokémon Showdown replay link (private ones too, with the full link ending in `pw`) and adds what happened as a branch. Both teams must be exactly the gameplan's: the same six Pokémon and, from the open team sheets, the same items, abilities and moves (a different nature is only a warning); otherwise nothing is added and the differences are listed. The branch goes into the tab with the same leads and backs, or a new tab named after the players (tick the box to always use a new tab), which then opens. Every turn records what the replay shows: switches, Mega Evolution, moves and targets, pivots, the chance results, the order things happened in and each Pokémon's HP (the replay's percentages replace the average rolls, so later turns start from what really happened). A Pokémon that fainted before acting, or couldn't move, gets a move marked "not shown in the replay". Importing the same replay again adds nothing; the toast offers Undo. The browser reads the replay straight from Showdown (no cookies, nothing through our server).

## Sprites

`npm run sprites` makes a local copy of the whole `src/app/assets/sprites` folder of [robsonbittencourt/vgc-multicalc](https://github.com/robsonbittencourt/vgc-multicalc) (`pokemon-champions`, `pokemon-home`, `items`, `types`, `menu`; about 3,000 files, 50 MB) into `public/sprites/`. The app loads icons only from there, never from GitHub. The repository's code is MIT-licensed, but the artwork belongs to Nintendo / The Pokémon Company, so `public/sprites/` is git-ignored: run the script once per checkout and before every deployment build, and check the licence/permission before redistributing the images. Without them the app still works and shows letter badges. To use a CDN instead, set `VITE_SPRITE_BASE_URL` at build time and add the origin to `img-src` in `deploy/security-headers.inc`.

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

**Profile pictures.** Every account has one of 1,025 Pokémon portraits (`public/avatars/<Name>.png`, one per National Dex number). A random one is picked when the account is created and stored with it, so it's the same everywhere you sign in; **Change profile picture** in the account menu picks another (searchable by name or number). The server only accepts names from `src/domain/avatars.ts`. The portraits come from the [PMD Sprite Repository](https://github.com/PMDCollab/SpriteCollab) under **CC BY-NC 4.0** (non-commercial use, with credit): the artists are listed in `public/avatars/CREDITS.md`. `npm run avatars` downloads them again and regenerates the list and credits.

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

**Deploy to Cloudflare** (the static site on Cloudflare's CDN, plus the API Worker and D1, in one deployment):

```bash
npx wrangler login                                          # once: sign in to your Cloudflare account in the browser
npx wrangler d1 create vgc-gameplans                        # once: put the printed database_id in wrangler.toml
npx wrangler d1 migrations apply vgc-gameplans --remote     # creates / updates the tables (again after new migrations)
npm run sprites                                             # once per checkout: the icons ship with the site
npm run deploy                                              # checks the sprites, builds and deploys; prints the URL
```

The site is served at **https://vgcplanner.app** (`routes` in `wrangler.toml`; the domain is on the same Cloudflare account, which creates its DNS record and certificate). The `workers.dev` address and per-version preview URLs are off, so there is one address for sign-ins and share links. The Worker uses whatever address it is served from, so no URL needs configuring. To turn on sign-in, register `<site>/api/auth/discord/callback` and `<site>/api/auth/google/callback` with the providers and store the credentials as secrets: `npx wrangler secret put DISCORD_CLIENT_ID` (and `DISCORD_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Each sign-in button appears once its credentials are set. Security headers and caching come from `public/_headers`. Never set `DEV_LOGIN` in production; the Worker also refuses it on non-local addresses.

## Status of this repository (read before first use)

Checked in the environment where this was written: strict type-check of the app, 42 unit tests, and a Chromium run of the real UI under the strict CSP using a stand-in calculator.

**Not run there (no network or tools):** `npm install`, `vite build`, ESLint, Prettier, `docker build`, the CI workflow, and the real `@smogon/calc`. In particular:

- `@smogon/calc` is pinned to `^0.12.0`, the version a Champions calculator site documents as containing Champions support. If `npm install` can't find it, check `npm view @smogon/calc versions`. At runtime the app verifies that the loaded build has a Champions mode (generation 0, checked through its stat formula) and shows a banner if not; stats are always computed by this app, so they stay correct either way.
- Some builds of the calculator applied a slightly different stat-stage table in Champions (rounding-level differences). Prefer a recent version.
- Item sprite file names (`items/`) are lowercase and hyphenated (`choice-scarf.webp`); Pokémon files keep Showdown spelling, including spaces (`Mr. Mime.webp`). Missing icons simply don't show.
- Run `npm run format` once, then `npm run check`; the code was written to Prettier's conventions but not run through it.

## License

The code is under the [MIT License](LICENSE). Third-party material keeps its own terms (see [NOTICE](NOTICE)): the profile portraits in `public/avatars` are CC BY-NC 4.0 (non-commercial, credited in [`public/avatars/CREDITS.md`](public/avatars/CREDITS.md)), and Pokémon names and artwork belong to Nintendo / The Pokémon Company. This is an unofficial fan project, not affiliated with or endorsed by them.
