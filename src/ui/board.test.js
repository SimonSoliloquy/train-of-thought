import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuns, saveRun, BOARD_KEY, BOARD_SIZE } from './board.js';

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    raw: (k) => m.get(k),
  };
}

const run = (score, extra = {}) => ({ score, time: 100, stations: 3, tickets: 1, delivered: 4, start: 'Start', ...extra });

test('an empty store is an empty board', () => {
  assert.deepEqual(loadRuns(fakeStorage()), []);
  assert.deepEqual(loadRuns(null), []);
});

test('corrupt JSON, or JSON that is not a list, gives an empty board', () => {
  assert.deepEqual(loadRuns(fakeStorage({ [BOARD_KEY]: '{not json' })), []);
  assert.deepEqual(loadRuns(fakeStorage({ [BOARD_KEY]: '{"a":1}' })), []);
  assert.deepEqual(loadRuns(fakeStorage({ [BOARD_KEY]: '[null, 3, "x"]' })), []);
  // and a corrupt board is replaced by a good one on the next save
  const s = fakeStorage({ [BOARD_KEY]: '{not json' });
  const res = saveRun(s, run(50), 1);
  assert.equal(res.rank, 1);
  assert.equal(loadRuns(s).length, 1);
});

test('runs are kept best score first, earlier run first on a tie', () => {
  const s = fakeStorage();
  saveRun(s, run(30), 1);
  saveRun(s, run(90), 2);
  saveRun(s, run(60), 3);
  saveRun(s, run(60, { start: 'Later' }), 4);
  const runs = loadRuns(s);
  assert.deepEqual(runs.map((r) => r.score), [90, 60, 60, 30]);
  assert.equal(runs[1].start, 'Start');
  assert.equal(runs[2].start, 'Later');
});

test('the board keeps only the top ten', () => {
  const s = fakeStorage();
  for (let i = 1; i <= 14; i++) saveRun(s, run(i * 10), i);
  const runs = loadRuns(s);
  assert.equal(runs.length, BOARD_SIZE);
  assert.equal(BOARD_SIZE, 10);
  assert.equal(runs[0].score, 140);
  assert.equal(runs[9].score, 50);
  assert.equal(JSON.parse(s.raw(BOARD_KEY)).length, 10);
});

test('rank and best', () => {
  const s = fakeStorage();
  let res = saveRun(s, run(100), 1);
  assert.equal(res.rank, 1);
  assert.equal(res.best, true, 'the first run is a new best');

  res = saveRun(s, run(40), 2);
  assert.equal(res.rank, 2);
  assert.equal(res.best, false);

  res = saveRun(s, run(100), 3);
  assert.equal(res.rank, 2, 'a tie goes below the earlier run');
  assert.equal(res.best, false, 'equalling the best is not a new best');

  res = saveRun(s, run(150), 4);
  assert.equal(res.rank, 1);
  assert.equal(res.best, true);
  assert.equal(res.runs[0].score, 150);

  for (let i = 0; i < 10; i++) saveRun(s, run(500), 10 + i);
  res = saveRun(s, run(1), 99);
  assert.equal(res.rank, null, 'a run below a full board does not make it');
  assert.equal(res.best, false);
});

test('a store that refuses writes still returns the board', () => {
  const s = { getItem: () => null, setItem: () => { throw new Error('full'); } };
  const res = saveRun(s, run(10), 1);
  assert.equal(res.rank, 1);
  assert.equal(res.runs.length, 1);
});
