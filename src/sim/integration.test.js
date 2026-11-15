// The sim against the real world module (src/world) with the fake wiki.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from './index.js';
import { createFakeWiki, flush } from './fakes.js';
import { makeSyntheticGraph } from './bot.mjs';
import { createWorld } from '../world/index.js';

test('integration: real world + fake wiki — build, line, train, delivery', async () => {
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
  for (const g of ghosts.slice(0, 2)) {
    const q = game.quoteBuild('Article 0', g.title);
    assert.equal(q.ok, true, q.reason);
    const before = game.state.money;
    const r = await game.build('Article 0', g.title, 'cheap');
    assert.equal(r.ok, true, r.reason);
    assert.equal(game.state.money, before - q.cheap.total);
    assert.equal(world.placements.get(g.title).state, 'built');
    built.push(g.title);
  }
  const { line } = game.createLine([built[0], 'Article 0', built[1]]);
  const th = game._debug.addThought(built[0], built[1], 2);
  const { train } = game.buyTrain('local', line.id);
  assert.equal(th.state, 'riding');
  game.setSpeed(4);
  const stops = [];
  let prev = train.state;
  for (let i = 0; i < 5000 && game.state.delivered === 0; i++) {
    game.update(0.1);
    await flush(2);
    if (train.state === 'dwelling' && prev === 'moving') stops.push(train.atStation);
    prev = train.state;
  }
  assert.equal(game.state.delivered, 1);
  assert.deepEqual(stops, ['Article 0', built[1]]);
});
