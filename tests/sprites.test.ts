import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpriteUrls, fileStems } from '../src/infra/sprites.ts';

const cfg = { baseUrl: '/sprites', pokemonDir: 'pokemon-champions', itemDir: 'items', extension: 'webp', fileAliases: { Aegislash: 'Aegislash-Shield' } };

test('file names match the sprite folder (Showdown names, hyphenated)', () => {
  const urls = createSpriteUrls(cfg);
  assert.deepEqual(urls.pokemon('Aerodactyl-Mega'), ['/sprites/pokemon-champions/Aerodactyl-Mega.webp']);
  assert.deepEqual(urls.pokemon('Absol-Mega-Z'), ['/sprites/pokemon-champions/Absol-Mega-Z.webp']);
  assert.deepEqual(urls.pokemon('Aegislash'), ['/sprites/pokemon-champions/Aegislash-Shield.webp']);
});

test('names with spaces, accents or punctuation get a second spelling to try', () => {
  assert.deepEqual(fileStems('Mr. Mime'), ['Mr.-Mime', 'Mr-Mime', 'Mr.%20Mime', 'Mr%20Mime']);
  assert.deepEqual(fileStems('Flabébé'), ['Flab%C3%A9b%C3%A9', 'Flabe%CC%81be%CC%81', 'Flabebe']);
  assert.deepEqual(fileStems('Assault Vest'), ['Assault-Vest', 'Assault%20Vest']);
});

test('item icons use their own folder with lowercase file names', () => {
  const urls = createSpriteUrls(cfg);
  assert.equal(urls.item('Choice Scarf')[0], '/sprites/items/choice-scarf.webp');
  assert.equal(urls.item('Never-Melt Ice')[0], '/sprites/items/never-melt-ice.webp');
  assert.equal(urls.item("King's Rock")[0], "/sprites/items/king's-rock.webp");
});
