// The sim against the real world module (src/world) with the fake wiki.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECON } from '../config.js';
import { createGame } from './index.js';
import { createFakeWiki, flush } from './fakes.js';
import { makeSyntheticGraph } from './bot.mjs';
import { createWorld } from '../world/index.js';

test('integration: real world + fake wiki — build, upgrade, transfer, delivery', async () => {
  const graph = makeSyntheticGraph(3, 120);
  const wiki = createFakeWiki(graph, { start: 'Article 0' });
  const world = createWorld({ seed: 3 });
  const game = createGame({ wiki, world, seed: 3, spawnThoughts: false });
  await game.start();
  assert.equal(game.state.phase, 'running');
  const ghosts = [...world.placements.values()].filter((p) => p.state === 'ghost');
  assert.ok(ghosts.length > 0);
  game.state.money = 1e6;

  const built = [];
  for (const [i, g] of ghosts.slice(0, 2).entries()) {
    const q = game.quoteBuild('Article 0', g.title);
    assert.equal(q.ok, true, q.reason);
    const before = game.state.money;
    const r = await game.build('Article 0', g.title, 'cheap');
    assert.equal(r.ok, true, r.reason);
    // The first station completes the first goal, which pays at once.
    assert.equal(game.state.money, before - q.cheap.total + (i === 0 ? ECON.goalRewardBase : 0));
    assert.equal(world.placements.get(g.title).state, 'built');
    built.push(g.title);
  }
  const th = game._debug.addThought(built[0], built[1], 2);
  for (const t of game.state.tracks) assert.equal(game.upgradeTrack(t.id).ok, true);
  const boardedOn = [];
  game.on('thoughtBoarded', (p) => { if (p.thought.id === th.id) boardedOn.push(p.train.trackId); });
  game.setSpeed(4);
  let sawTransfer = false;
  for (let i = 0; i < 6000 && game.state.delivered === 0; i++) {
    game.update(0.1);
    await flush(2);
    if (th.state === 'waiting' && th.at === 'Article 0') sawTransfer = true;
  }
  assert.equal(game.state.delivered, 1);
  assert.equal(game.state.thoughts.length, 0);
  // The trains boarded, in order, are the proof of a change at Article 0 (the second may already be standing there).
  assert.deepEqual(boardedOn, [game.trackBetween(built[0], 'Article 0').id, game.trackBetween(built[1], 'Article 0').id]);
  assert.ok(game.state.payday.last !== null);
});
