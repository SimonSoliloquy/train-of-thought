import test from 'node:test';
import assert from 'node:assert/strict';
import { longestLine } from './line.js';

const t = (from, to, length) => ({ from, to, route: { length } });

test('fewer than two connected stations: no line', () => {
  assert.equal(longestLine([]), null);
  assert.equal(longestLine(null), null);
  assert.equal(longestLine([t('A', 'A', 5)]), null, 'a track to itself joins nothing');
});

test('one track: its two ends', () => {
  assert.deepEqual(longestLine([t('A', 'B', 12)]), { from: 'A', to: 'B', length: 12 });
});

test('measured in track length, not in stops', () => {
  // A-B-C-D in a row, but the single long spur A-E outweighs the three short hops
  const line = longestLine([t('A', 'B', 1), t('B', 'C', 1), t('C', 'D', 1), t('A', 'E', 10)]);
  assert.deepEqual(line, { from: 'D', to: 'E', length: 13 });
  // with a short spur, the far ends of the row win
  const row = longestLine([t('A', 'B', 4), t('B', 'C', 4), t('C', 'D', 4), t('B', 'E', 1)]);
  assert.deepEqual([row.from, row.to, row.length], ['A', 'D', 12]);
});

test('the shortest way between two stations is what counts, so a loop does not stretch a line', () => {
  // a square A-B-C-D-A of sides 5: opposite corners are 10 apart, not 15 the long way round
  const line = longestLine([t('A', 'B', 5), t('B', 'C', 5), t('C', 'D', 5), t('D', 'A', 5)]);
  assert.equal(line.length, 10);
  assert.deepEqual([line.from, line.to], ['A', 'C']);
  // a shortcut across a triangle shortens the far pair
  const tri = longestLine([t('A', 'B', 10), t('B', 'C', 10), t('A', 'C', 3)]);
  assert.deepEqual([tri.from, tri.to, tri.length], ['A', 'B', 10]);
});

test('separate networks: the longest line of any of them', () => {
  const line = longestLine([t('A', 'B', 3), t('X', 'Y', 7), t('Y', 'Z', 2), t('B', 'C', 1)]);
  assert.deepEqual(line, { from: 'X', to: 'Z', length: 9 });
});

test('a tie keeps the pair found first; a track with no length still joins its stations', () => {
  const tie = longestLine([t('A', 'B', 5), t('C', 'D', 5)]);
  assert.deepEqual([tie.from, tie.to], ['A', 'B']);
  const none = longestLine([{ from: 'A', to: 'B' }, { from: 'B', to: 'C', route: { length: NaN } }]);
  assert.deepEqual([none.from, none.to, none.length], ['A', 'B', 0]);
});

test('many stations stay quick', () => {
  const tracks = [];
  for (let i = 1; i < 400; i++) tracks.push(t(`S${i - 1}`, `S${i}`, 1 + (i % 3)));
  for (let i = 0; i < 400; i += 7) tracks.push(t(`S${i}`, `S${(i * 13) % 400}`, 50));
  const t0 = Date.now();
  const line = longestLine(tracks);
  assert.ok(line && line.length > 0);
  assert.ok(Date.now() - t0 < 2000);
});
