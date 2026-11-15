import test from 'node:test';
import assert from 'node:assert/strict';
import { streakPitch, createLimiter } from './sound.js';

test('delivery chime rises with the streak and stops rising at the top', () => {
  let prev = 0;
  for (let s = 1; s <= 11; s++) {
    const f = streakPitch(s);
    assert.ok(f > prev, `streak ${s}`);
    prev = f;
  }
  assert.equal(streakPitch(11), streakPitch(40));
  assert.equal(streakPitch(0), streakPitch(1));
  assert.equal(streakPitch(undefined), streakPitch(1));
  assert.ok(Math.abs(streakPitch(6) / streakPitch(1) - 2) < 1e-9); // an octave after five steps
});

test('limiter: per-sound gaps and a short global gap', () => {
  let t = 0;
  const ok = createLimiter({ gaps: { chime: 100 }, defaultGap: 300, globalGap: 20, now: () => t });
  assert.equal(ok('chime'), true);
  t = 10;
  assert.equal(ok('thunk'), false); // global gap
  t = 50;
  assert.equal(ok('thunk'), true);
  assert.equal(ok('chime'), false); // global gap, same instant
  t = 120;
  assert.equal(ok('chime'), true); // its own 100 ms have passed
  t = 200;
  assert.equal(ok('thunk'), false); // default 300 ms not yet
  t = 351;
  assert.equal(ok('thunk'), true);
});
