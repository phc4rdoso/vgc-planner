import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePasteLink, readPokepaste, readVrPaste } from '../src/domain/paste-links.ts';
import { parseShowdown } from '../src/domain/showdown.ts';
import { fetchPasteLink } from '../src/infra/paste-links.ts';

test('recognises pokepast.es and vrpastes.com links, and nothing else', () => {
  assert.deepEqual(parsePasteLink('https://pokepast.es/59ed8cd86a5f2223'), { site: 'pokepaste', id: '59ed8cd86a5f2223', api: 'https://pokepast.es/59ed8cd86a5f2223/json' });
  assert.equal(parsePasteLink(' pokepast.es/59ed8cd86a5f2223/raw ')?.id, '59ed8cd86a5f2223');
  assert.equal(parsePasteLink('https://www.vrpastes.com/hF8qXQe1')?.api, 'https://vrpaste-backend.vercel.app/api/paste/hF8qXQe1?lang=english');
  assert.equal(parsePasteLink('vrpastes.com/hF8qXQe1#team')?.site, 'vrpastes');
  for (const no of ['', 'Rillaboom @ Miracle Seed', 'https://pokepast.es/', 'https://pokepast.es/not-hex!', 'https://evil.example/59ed8cd86a5f2223',
    'https://pokepast.es.evil.example/59ed8cd86a5f2223', 'see https://pokepast.es/59ed8cd86a5f2223', 'javascript:alert(1)', 'https://vrpastes.com/a/b']) {
    assert.equal(parsePasteLink(no), null, no);
  }
});

test('a pokepast.es team keeps its text, with clean line endings', () => {
  const { paste, title } = readPokepaste({ title: 'Closed', author: 'x', notes: '', paste: 'Rillaboom @ Miracle Seed  \r\nAbility: Grassy Surge  \r\n- Fake Out  ' });
  assert.equal(paste, 'Rillaboom @ Miracle Seed\nAbility: Grassy Surge\n- Fake Out');
  assert.equal(title, 'Closed');
  assert.throws(() => readPokepaste({ paste: '' }), /no team/);
});

test('a VR Pastes team becomes a Showdown paste the app can read', () => {
  const { paste, title } = readVrPaste({
    title: 'Untitled Team', is_encrypted: false,
    teams: [
      { name: 'Rillaboom', species: 'Rillaboom', item: 'Miracle Seed', ability: 'Grassy Surge', moves: ['Wood Hammer', 'Fake Out'], nature: 'Adamant', evs: { hp: 21, atk: 17, def: 14, spd: 10, spe: 4 }, level: 50 },
      { name: 'Aero', species: 'Aerodactyl', item: 'Aerodactylite', ability: 'Unnerve', moves: ['Rock Slide'], nature: 'Jolly', evs: { hp: 22, atk: 12, spe: 32 }, gender: 'F' },
    ],
  });
  assert.equal(title, '', 'placeholder titles are dropped');
  assert.equal(paste.split('\n\n')[0], 'Rillaboom @ Miracle Seed\nAbility: Grassy Surge\nLevel: 50\nEVs: 21 HP / 17 Atk / 14 Def / 10 SpD / 4 Spe\nAdamant Nature\n- Wood Hammer\n- Fake Out');
  const mons = parseShowdown(paste);
  assert.deepEqual(mons.map((m) => [m.species, m.item]), [['Rillaboom', 'Miracle Seed'], ['Aerodactyl', 'Aerodactylite']]);
  assert.throws(() => readVrPaste({ is_encrypted: true, teams: [] }), /password/);
  assert.throws(() => readVrPaste({ teams: [] }), /no team/);
});

test('fetching reports missing teams and network trouble in plain words', async () => {
  const link = parsePasteLink('https://pokepast.es/59ed8cd86a5f2223')!;
  const respond = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status });
  assert.equal((await fetchPasteLink(link, respond(200, { paste: 'Garchomp\n- Earthquake' }))).paste, 'Garchomp\n- Earthquake');
  await assert.rejects(fetchPasteLink(link, respond(404, {})), /no team at that link/);
  await assert.rejects(fetchPasteLink(link, (async () => { throw new TypeError('offline'); }) as typeof fetch), /Couldn't reach pokepast\.es/);
});
