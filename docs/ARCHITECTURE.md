# Architecture

## Goals

1. **Deployable as a static site today, and behind a real backend later** without rewriting the application.
2. **One source of truth for rules** (parsing, stats, simulation, validation) that doesn't depend on the browser.
3. **Safe with untrusted input**: pastes, imported files and stored data are all validated.

## Layers

```
ui  ──►  state  ──►  infra  ──►  domain
 │                     ▲           ▲
 └─────────────────────┴───────────┘      (domain imports nothing from the other layers)
```

- **domain**: data model (`types.ts`), Showdown parser, stat formula, tree helpers, the validated JSON codec, and the turn simulation. Plain TypeScript, no DOM. The simulation talks to the damage calculator through a small interface (`CalcLib`, `CalcEngine`), so tests inject a stand-in and a server could inject Node's `@smogon/calc`.
- **infra**: adapters. `LibraryRepository` (persistence), `PrefsStore` (view preferences), the calculator loader, sprite URLs.
- **state**: `AppStore` owns the library and view state and saves through the repository (debounced, errors surfaced). `SimService` owns the calculator's lifecycle and caches results per plan state.
- **ui**: string-template views, one module per screen area, a single delegated event listener (`data-act` attributes), and a render bus so views don't import each other.

## Rendering and safety

- Views build HTML strings. **Every dynamic value goes through `esc()`**; there is no other way text reaches `innerHTML`.
- No inline `<script>`, `style=""` or `on*=` handlers anywhere, so a strict CSP works (`script-src 'self'; style-src 'self'`). Dynamic widths and zoom are applied from script via `data-w` and a CSS variable.
- Imported/stored JSON is read by `domain/codec.ts`: types are checked per field, strings are length-capped, and the number of teams, plans, turns and the nesting depth are bounded.

## Persistence and data versions

- `LibraryRepository { load(): Promise<Library>; save(library): Promise<void> }`. The stored envelope is `{ schemaVersion, teams }`; readers reject newer versions and keep accepting older ones (the pre-restructure shape `{ teams, ui }` is still read).
- Export files have their own `version`. When a format changes, bump the version and add a migration step in `codec.ts` before validation; keep one test per old version.
- Version 2 (both the stored schema and export files): a gameplan holds `tabs`, each with its own `name`, `selection` (leads/backs) and turns. Version 1 gameplans, with one `selection` and one turn tree, are read as a single tab named "Plan 1".
- Ids are UUIDs, so records can be merged or synced later without remapping.

## Moving to a server

The only code that knows where data lives is `infra/repository.ts` and the wiring in `state/instance.ts`.

1. **Add `HttpLibraryRepository`** implementing `LibraryRepository` (`GET /api/library`, `PUT /api/library` with `If-Match` for optimistic concurrency). Change one line in `state/instance.ts`. The UI needs no change, because it already treats saving as asynchronous and reports failures.
2. **Validate on the server with the same code**: import `readLibrary` from `src/domain/codec.ts` in the API (it has no browser dependencies). Keep `LIMITS` as request limits.
3. **Auth and tenancy**: a library per user (OIDC or sessions). Nothing in the client assumes a single user beyond the repository.
4. **Finer-grained API (when whole-library PUT gets heavy)**: `POST /api/teams`, `PATCH /api/plans/:id`, etc. `AppStore.persist()` is the single place that decides when to save, so switching to per-record saves is local.
5. **Calculator on the server (optional)**: `simulatePlan` is pure given a `CalcEngine`; a server can run it with `@smogon/calc` on Node to avoid shipping the calculator to every browser, or to cache results.

## Testing strategy

- **Unit (`npm test`)**: parser, stat formula, codec (round trips, validation, limits, legacy data), repository behaviour (including failure and corruption paths), `SimService` caching/retry, sprite URL rules, and the simulation using `tests/helpers/stub-calc.ts`.
- **E2E (`npm run test:e2e`)**: the real UI in Chromium: create team and gameplan, edit a turn, results, export, reload, import; fails on any console error (including CSP violations).
- The stand-in calculator keeps tests deterministic and offline. Correctness of the damage numbers themselves is the calculator's job; the simulation tests check what this app adds (order, targets, state carried between turns).
