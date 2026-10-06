// Stops a deployment that would ship without the Pokémon / item sprites (public/sprites is git-ignored).
import { existsSync, readdirSync } from 'node:fs';

const dirs = ['pokemon-champions', 'items'];
const missing = dirs.filter((d) => !existsSync(`public/sprites/${d}`) || readdirSync(`public/sprites/${d}`).length === 0);
if (missing.length) {
  console.error(`public/sprites/${missing.join(', ')} is missing. Run "npm run sprites" first, so the deployed site has its icons.`);
  process.exit(1);
}
