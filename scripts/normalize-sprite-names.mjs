// Renames sprite files whose names aren't plain ASCII (spaces, accents, ’ ' . % ( )) to the spelling the app
// falls back to anyway (src/infra/sprites.ts, fileStems): accents removed, punctuation dropped, spaces as "-".
// e.g. "Mr. Mime.webp" -> "Mr-Mime.webp", "Flabébé.webp" -> "Flabebe.webp", "Zygarde-10%.webp" -> "Zygarde-10.webp".
// Cloudflare's asset upload rejects some of these characters, and plain names are safer in URLs everywhere.
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const root = process.argv[2] ?? 'public/sprites';
const safe = /^[A-Za-z0-9._-]+$/;
const fold = (stem) => stem.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.'’:%()]/g, '').trim().replace(/\s+/g, '-');

let renamed = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (safe.test(entry)) continue;
    const ext = extname(entry);
    const target = `${fold(entry.slice(0, -ext.length))}${ext}`;
    if (!safe.test(target) || !target.slice(0, -ext.length)) { console.warn(`Skipped ${path}: no safe name`); continue; }
    if (existsSync(join(dir, target))) { console.warn(`Skipped ${path}: ${target} already exists`); continue; }
    renameSync(path, join(dir, target));
    renamed++;
  }
};
walk(root);
console.log(`Renamed ${renamed} sprite file(s) to plain names`);
