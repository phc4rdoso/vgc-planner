import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newsToShow } from '../src/state/news.ts';

const IDS = [1, 2, 3];

test('a brand-new visitor sees no news, and everything so far counts as seen', () => {
  assert.deepEqual(newsToShow(IDS, null, 'new'), { show: [], remember: 3 });
});

test('a returning visitor this device never showed news to sees all of it, newest first', () => {
  assert.deepEqual(newsToShow(IDS, null, 'returning'), { show: [3, 2, 1], remember: 3 });
});

test('only items newer than the last one shown; nothing once all are seen', () => {
  assert.deepEqual(newsToShow(IDS, '1', 'returning'), { show: [3, 2], remember: 3 });
  assert.deepEqual(newsToShow(IDS, '1', 'new'), { show: [3, 2], remember: 3 }, 'a device that saw news before gets the rest');
  assert.deepEqual(newsToShow(IDS, '3', 'returning'), { show: [], remember: 3 });
});

test('someone back after a long time sees only the latest few; junk in storage counts as nothing seen', () => {
  assert.deepEqual(newsToShow([1, 2, 3, 4, 5, 6, 7], '0', 'returning', 5).show, [7, 6, 5, 4, 3]);
  assert.deepEqual(newsToShow(IDS, 'junk', 'returning').show, [3, 2, 1]);
  assert.deepEqual(newsToShow(IDS, '9', 'returning'), { show: [], remember: 9 }, 'never goes back');
});
