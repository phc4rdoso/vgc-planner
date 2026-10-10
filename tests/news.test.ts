import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LATEST_NEWS_ID, NEWS, newsToShow, readSeen } from '../src/domain/news.ts';

const IDS = [1, 2, 3];

test('a brand-new visitor sees no news, and everything so far counts as seen', () => {
  assert.deepEqual(newsToShow(IDS, null, 'new'), { show: [], remember: 3 });
});

test('a returning visitor with nothing remembered sees all of it, newest first', () => {
  assert.deepEqual(newsToShow(IDS, null, 'returning'), { show: [3, 2, 1], remember: 3 });
});

test('only items newer than the last one shown; nothing once all are seen', () => {
  assert.deepEqual(newsToShow(IDS, 1, 'returning'), { show: [3, 2], remember: 3 });
  assert.deepEqual(newsToShow(IDS, 1, 'new'), { show: [3, 2], remember: 3 }, 'someone who saw news before gets the rest');
  assert.deepEqual(newsToShow(IDS, 3, 'returning'), { show: [], remember: 3 });
});

test('someone back after a long time sees only the latest few', () => {
  assert.deepEqual(newsToShow([1, 2, 3, 4, 5, 6, 7], 0, 'returning', 5).show, [7, 6, 5, 4, 3]);
  assert.deepEqual(newsToShow(IDS, 9, 'returning'), { show: [], remember: 9 }, 'never goes back');
});

test('the value kept in the browser: none, a number, or junk (counts as nothing seen)', () => {
  assert.equal(readSeen(null), null);
  assert.equal(readSeen('2'), 2);
  assert.equal(readSeen('junk'), 0);
  assert.equal(readSeen('-4'), 0);
});

test('news ids only go up, and the latest is what new accounts start with', () => {
  const ids = NEWS.map((n) => n.id);
  assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]!), 'each item gets a higher id than the one before');
  assert.equal(LATEST_NEWS_ID, ids.at(-1));
  assert.ok(NEWS.every((n) => /^\d{4}-\d{2}-\d{2}$/.test(n.date)), 'dates are YYYY-MM-DD');
});
