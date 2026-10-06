import { config } from '../config.ts';

export interface SpriteConfig {
  baseUrl: string;
  pokemonDir: string;
  itemDir: string;
  extension: string;
  fileAliases: Readonly<Record<string, string>>;
}

/**
 * A name can map to a few file spellings (accents, punctuation). Returns URL-safe file stems in the order
 * they should be tried: hyphenated spellings first (as written, decomposed accents, accent/punctuation-free),
 * then the same with spaces kept. `npm run sprites` stores unusual names in the accent/punctuation-free form ("Mr-Mime.webp").
 */
export function fileStems(name: string, aliases: Readonly<Record<string, string>> = {}): string[] {
  const base = (aliases[name] ?? name).trim().normalize('NFC');
  const folded = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.'’:%()]/g, '');
  const spellings = [base, base.normalize('NFD'), folded];
  const stems = [...spellings.map((n) => n.replace(/\s+/g, '-')), ...spellings];
  return [...new Set(stems)].map(encodeURIComponent);
}

export function createSpriteUrls(cfg: SpriteConfig): { pokemon(species: string): string[]; item(item: string): string[] } {
  const url = (dir: string, stem: string): string => `${cfg.baseUrl}/${dir}/${stem}.${cfg.extension}`;
  return {
    pokemon: (species) => fileStems(species, cfg.fileAliases).map((s) => url(cfg.pokemonDir, s)),
    // Item files are lowercase ("Choice Scarf" -> choice-scarf.webp, "King's Rock" -> king's-rock.webp).
    item: (item) => fileStems(item.toLowerCase()).map((s) => url(cfg.itemDir, s)),
  };
}

export const spriteUrls = createSpriteUrls(config.sprites);
