/**
 * Build-time configuration. Values come from Vite env files (`.env.development`, `.env.production`) or the
 * environment of the build; `import.meta.env` is undefined outside Vite (e.g. in Node tests), hence the guards.
 */
const env = import.meta.env as ImportMetaEnv | undefined;

export const config = {
  sprites: {
    /** Base URL for Pokémon and item icons. The local copy in public/sprites (npm run sprites), unless a CDN is set. */
    baseUrl: (env?.VITE_SPRITE_BASE_URL ?? '/sprites').replace(/\/+$/, ''),
    pokemonDir: 'pokemon-champions',
    itemDir: 'items',
    extension: 'webp',
    /** Showdown species names that have a differently named sprite file. */
    fileAliases: { Aegislash: 'Aegislash-Shield' } as Readonly<Record<string, string>>,
  },
  storage: {
    libraryKey: 'vgc-planner:library',
    prefsKey: 'vgc-planner:prefs',
    /** Key used before the project was restructured; read once so existing data is not lost. */
    legacyKey: 'vgc-gameplan-planner:v1',
    /** Delay before changes are written, so typing doesn't write on every keystroke. */
    saveDelayMs: 200,
  },
  zoom: { min: 0.4, max: 1.6, step: 0.1 },
} as const;
