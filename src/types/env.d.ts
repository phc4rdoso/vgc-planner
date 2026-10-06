interface ImportMetaEnv {
  /** Where sprites are served from. Defaults to "/sprites" (self-hosted); see README. */
  readonly VITE_SPRITE_BASE_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
