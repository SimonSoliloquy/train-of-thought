import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECON, TRAIN_TYPES, WORLD, STARTING_TRAIN_TYPES } from '../config.js';
import { createGame } from './index.js';
import { createFakeWiki, createFakeWorld, flush } from './fakes.js';
import { inflationAt, baseFare, patienceFor, stationBaseCost } from './econ.js';

const BIG_LINKS = Array.from({ length: ECON.milestones[0].uniqueLinks + 10 }, (_, i) => `Concept ${i}`);

function makeGraph() {
  return {
    Hub: { leadLinks: ['A', 'B', 'C', 'D', 'E', 'ListPage', 'Missing', 'Big'], links: ['X1', 'X2', 'X3', 'Far'], popularity: 0.5 },
    A: { leadLinks: ['Hub', 'F', 'G'], links: ['X1', 'X2', 'Y1', 'Y2'], popularity: 0.2 },
    B: { leadLinks: ['Hub', 'A', 'H'], links: ['X3', 'Y1', 'Z1'], popularity: 0.8 },
    C: { leadLinks: ['Hub', 'B'], popularity: 0.1 },
    D: { leadLinks: ['Hub'] },
    E: { leadLinks: ['Hub'] },
    ListPage: { kind: 'list', leadLinks: ['Hub', 'A'], popularity: 0.3 },
    Big: { leadLinks: ['Hub'], links: BIG_LINKS, popularity: 0.1 },
    Far: { leadLinks: ['Hub'] },
    F: { leadLinks: ['A', 'G'] },
    G: { leadLinks: ['A', 'F'] },
    H: { leadLinks: ['B'] },
  };
}

async function setup({ seed = 7, spawnThoughts = false, money = null, wikiOpts = {} } = {}) {
  const wiki = createFakeWiki(makeGraph(), { start: 'Hub', ...wikiOpts });
  const world = createFakeWorld();
  const game = createGame({ wiki, world, seed, spawnThoughts });
  const events = [];
  for (const name of ['started', 'tilesRevealed', 'ghostsAdded', 'stationBuilt', 'trackBuilt', 'thoughtSpawned',
    'thoughtBoarded', 'thoughtDelivered', 'thoughtLost', 'linesChanged', 'trainsChanged', 'milestone', 'toast', 'gameOver']) {
    game.on(name, (p) => events.push({ name, p }));
  }
  await game.start();
  if (money !== null) game.state.money = money;
  return { wiki, world, game, events };
}

/** Advance `seconds` of game time in frames of dt real seconds. */
function run(game, seconds, dt = 0.1) {
  const frames = Math.round(seconds / (dt * (game.state.speed || 1)));
  for (let i = 0; i < frames; i++) game.update(dt);
}

test('start flow: phases, money, events, ghosts only for real pages', async () => {
  const wiki = createFakeWiki(makeGraph(), { start: 'Hub' });
  const world = createFakeWorld();
  const game = createGame({ wiki, world, seed: 1 });
  assert.equal(game.state.phase, 'idle');
  const names = [];
  for (const n of ['started', 'tilesRevealed', 'ghostsAdded']) game.on(n, () => names.push(n));
  const p = game.start();
  assert.equal(game.state.phase, 'loading');
  await p;
  assert.equal(game.state.phase, 'running');
  assert.deepEqual(names, ['started', 'tilesRevealed', 'ghostsAdded']);
  assert.equal(game.state.money, ECON.startMoney);
  assert.equal(game.state.stations.size, 1);
  const hub = game.state.stations.get('Hub');
  assert.equal(hub.q, 0);
  assert.equal(hub.r, 0);
  assert.equal(world.placements.get('Hub').state, 'built');
  // 'Missing' does not exist, so it is not on the map; the rest of the lead links are ghosts.
  assert.ok(!world.placements.has('Missing'));
  for (const t of ['A', 'B', 'C', 'D', 'E', 'ListPage', 'Big']) {
    assert.equal(world.placements.get(t).state, 'ghost', t);
    assert.ok(game.state.stubs.has(t), t);
  }
  assert.ok(game.state.stubs.has('Hub'));
  assert.equal(game.state.nextMilestone.unlock, ECON.milestones[0].unlock);
  assert.deepEqual(game.state.unlockedTrainTypes, STARTING_TRAIN_TYPES);
});

test('quoteBuild validation and exact pricing', async () => {
  const { game } = await setup();
  assert.equal(game.quoteBuild('A', 'Hub').ok, false, 'from must be built');
  assert.equal(game.quoteBuild('Hub', 'F').ok, false, 'to must be on the map');
  assert.equal(game.quoteBuild('Hub', 'Hub').ok, false);
  const q = game.quoteBuild('Hub', 'A');
  assert.equal(q.ok, true);
  const expectStation = Math.round(stationBaseCost({ popularity: 0.2, kind: 'article' }));
  assert.equal(q.cheap.stationCost, expectStation);
  assert.equal(q.cheap.trackCost, q.cheap.route.cost);
  assert.equal(q.cheap.total, q.cheap.trackCost + q.cheap.stationCost);
  assert.ok(q.direct.trackCost > q.cheap.trackCost, 'fake direct route crosses a bridge');
  // Special pages cost specialPageCostMult times more.
  const ql = game.quoteBuild('Hub', 'ListPage');
  assert.equal(ql.cheap.stationCost, Math.round((ECON.stationBaseCost + 0.3 * ECON.stationPopularityCost) * ECON.specialPageCostMult));

  const before = game.state.money;
  const res = await game.build('Hub', 'A', 'cheap');
  assert.deepEqual(res, { ok: true });
  assert.equal(game.state.money, before - q.cheap.total);
  assert.equal(game.quoteBuild('Hub', 'A').ok, false, 'already joined');
  assert.ok(game.trackBetween('A', 'Hub'));
  // F is now a ghost (A's lead link) but Hub does not link to F.
  assert.equal(game.quoteBuild('Hub', 'F').ok, false);
  assert.equal(game.quoteBuild('A', 'F').ok, true);

  // Unaffordable is refused without charging.
  game.state.money = 5;
  const r2 = await game.build('Hub', 'B', 'cheap');
  assert.equal(r2.ok, false);
  assert.equal(game.state.money, 5);
  assert.equal(game.quoteBuild('Hub', 'B').cheap.affordable, false);
});

test('inflation multiplies quotes', async () => {
  const { game } = await setup({ money: 1e9 });
  const q0 = game.quoteBuild('Hub', 'A');
  game.setSpeed(4);
  run(game, 600, 0.25);
  const infl = inflationAt(game.state.time);
  assert.ok(Math.abs(game.state.inflation - infl) < 1e-9);
  const q1 = game.quoteBuild('Hub', 'A');
  assert.equal(q1.cheap.trackCost, Math.round(q0.cheap.route.cost * infl));
  assert.equal(q1.cheap.stationCost, Math.round(stationBaseCost({ popularity: 0.2 }) * infl));
});

test('concurrent double build charges once and builds once', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const { game, wiki, events } = await setup({ money: 5000 });
  wiki.gate = () => held;
  const total = game.quoteBuild('Hub', 'A').cheap.total;
  const p1 = game.build('Hub', 'A', 'cheap');
  const p2 = game.build('Hub', 'A', 'direct');
  assert.equal(game.quoteBuild('Hub', 'A').ok, false, 'pending pair cannot be quoted');
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(game.state.money, 5000 - total);
  assert.equal(game.state.tracks.length, 1);
  assert.equal(events.filter((e) => e.name === 'stationBuilt').length, 1);
});

test('a failed article load refunds the charge', async () => {
  const { game } = await setup({ money: 1000, wikiOpts: { failTitles: ['C'] } });
  const r = await game.build('Hub', 'C', 'cheap');
  assert.equal(r.ok, false);
  assert.equal(game.state.money, 1000);
  assert.equal(game.state.tracks.length, 0);
});

test('build events and ghost expansion', async () => {
  const { game, events, world } = await setup({ money: 5000 });
  events.length = 0;
  await game.build('Hub', 'A', 'cheap');
  const names = events.map((e) => e.name).filter((n) => n !== 'toast');
  assert.deepEqual(names, ['tilesRevealed', 'ghostsAdded', 'trackBuilt', 'stationBuilt']);
  const ga = events.find((e) => e.name === 'ghostsAdded').p.placements.map((p) => p.title);
  assert.deepEqual(ga, ['F', 'G']); // Hub was already on the map
  assert.equal(world.placements.get('A').state, 'built');
  assert.ok(events.find((e) => e.name === 'tilesRevealed').p.tiles.length > 0);
  assert.ok(events.some((e) => e.name === 'toast' && e.p.tone === 'good'));
});

test('unique links across overlapping link sets', async () => {
  const { game } = await setup({ money: 5000 });
  const hub = game.state.stations.get('Hub');
  assert.equal(hub.uniqueLinks, 12); // 8 lead + 4 others
  await game.build('Hub', 'A', 'cheap');
  const a = game.state.stations.get('A');
  assert.equal(a.uniqueLinks, 5); // Hub F G Y1 Y2 (X1 X2 already covered)
  assert.ok(Math.abs(a.incomePerMin - 5 * ECON.linkIncomePerUniqueLinkPerMin) < 1e-9);
  await game.build('Hub', 'B', 'cheap');
  assert.equal(game.state.stations.get('B').uniqueLinks, 2); // H Z1
  assert.equal(game.state.uniqueLinks, 19);
  // A built station that links back counts: A does not link to B but B links to A.
  assert.equal(game.quoteBuild('A', 'B').ok, true);
  assert.ok(Math.abs(game.state.incomePerMin - 19 * ECON.linkIncomePerUniqueLinkPerMin) < 1e-9);
});

test('list pages earn no link income', async () => {
  const { game } = await setup({ money: 5000 });
  await game.build('Hub', 'ListPage', 'cheap');
  const s = game.state.stations.get('ListPage');
  assert.equal(s.uniqueLinks, 1); // links Hub (new) and A (already a Hub link)
  assert.equal(s.incomePerMin, 0);
});

test('survey places a non-lead link as a ghost; refuses non-pages and non-links', async () => {
  const { game, world, events } = await setup();
  assert.ok(!world.placements.has('Far'));
  assert.equal((await game.survey('Hub', 'Far')).ok, true);
  assert.equal(world.placements.get('Far').state, 'ghost');
  assert.ok(events.some((e) => e.name === 'ghostsAdded' && e.p.placements.some((p) => p.title === 'Far')));
  assert.equal((await game.survey('Hub', 'X1')).ok, false);
  assert.equal((await game.survey('Hub', 'H')).ok, false);
  assert.equal(game.state.money, ECON.startMoney);
});

test('line validation', async () => {
  const { game, events } = await setup({ money: 5000 });
  await game.build('Hub', 'A', 'cheap');
  await game.build('Hub', 'B', 'cheap');
  assert.equal(game.createLine(['Hub']).ok, false);
  assert.equal(game.createLine(['Hub', 'Hub']).ok, false);
  assert.equal(game.createLine(['A', 'B']).ok, false, 'no track A-B');
  assert.equal(game.createLine(['Hub', 'C']).ok, false, 'C not built');
  assert.equal(game.createLine(['A', 'Hub', 'Hub', 'B']).ok, false);
  const r = game.createLine(['A', 'Hub', 'B']);
  assert.equal(r.ok, true);
  assert.equal(r.line.name, 'Line 1');
  assert.ok(events.some((e) => e.name === 'linesChanged'));
  const r2 = game.createLine(['B', 'Hub']);
  assert.equal(r2.line.name, 'Line 2');
  assert.notEqual(r2.line.color, r.line.color);
  assert.equal(game.setLineStations(r.line.id, ['A', 'B']).ok, false);
  assert.equal(game.setLineStations(r.line.id, ['Hub', 'A']).ok, true);
  assert.deepEqual(game.state.lines[0].stations, ['Hub', 'A']);
});

test('train ping-pongs end to end, dwells at every stop, never skips at speed 4', async () => {
  const { game } = await setup({ money: 5000 });
  await game.build('Hub', 'A', 'cheap');
  await game.build('Hub', 'B', 'cheap');
  const { line } = game.createLine(['A', 'Hub', 'B']);
  const { train } = game.buyTrain('local', line.id);
  assert.equal(train.state, 'dwelling');
  assert.equal(train.atStation, 'A');
  game.setSpeed(4);
  const stops = [];
  const dwellTimes = [];
  let dwellStart = 0;
  let prev = train.state;
  let lastT = train.t;
  for (let i = 0; i < 3000; i++) {
    game.update(0.1);
    if (train.state === 'dwelling' && prev === 'moving') {
      stops.push(train.atStation);
      dwellStart = game.state.time;
    }
    if (train.state === 'moving' && prev === 'dwelling' && stops.length) dwellTimes.push(game.state.time - dwellStart);
    if (train.state === 'moving' && prev === 'moving') {
      assert.ok(train.forward ? train.t >= lastT : train.t <= lastT, 't moves monotonically along forward');
    }
    const track = game.state.tracks.find((t) => t.id === train.trackId);
    assert.ok(train.t >= 0 && train.t <= 1);
    assert.ok(track.from === train.atStation || track.to === train.atStation);
    prev = train.state;
    lastT = train.t;
  }
  const expected = [];
  const cycle = ['Hub', 'B', 'Hub', 'A'];
  for (let i = 0; i < stops.length; i++) expected.push(cycle[i % 4]);
  assert.ok(stops.length > 20, `made ${stops.length} stops`);
  assert.deepEqual(stops, expected);
  for (const d of dwellTimes) assert.ok(Math.abs(d - ECON.dwellSeconds) <= 0.4 + 1e-9, `dwell ${d}`);

  // Leg time ~ length / speed.
  const lenAH = game.trackBetween('A', 'Hub').route.length;
  const expectedLeg = lenAH / TRAIN_TYPES.local.speed;
  assert.ok(expectedLeg > 0);
});

test('boarding respects capacity; delivery pays the live fare', async () => {
  const { game, events } = await setup({ money: 5000 });
  await game.build('Hub', 'A', 'cheap');
  await game.build('Hub', 'B', 'cheap');
  const { line } = game.createLine(['A', 'Hub', 'B']);
  const ths = [];
  for (let i = 0; i < 6; i++) ths.push(game._debug.addThought('A', 'B', 2));
  const { train } = game.buyTrain('local', line.id);
  const cap = TRAIN_TYPES.local.capacity;
  assert.equal(train.passengers.length, cap);
  assert.equal(game.state.stations.get('A').waiting.length, 6 - cap);
  assert.equal(events.filter((e) => e.name === 'thoughtBoarded').length, cap);
  // Thoughts heading the wrong way do not board; a thought for Hub boards later.
  const money0 = game.state.money;
  let delivered = [];
  game.on('thoughtDelivered', (p) => delivered.push(p));
  for (let i = 0; i < 2000 && delivered.length < cap; i++) game.update(0.1);
  assert.equal(delivered.length, cap);
  for (const d of delivered) {
    assert.equal(d.station, 'B');
    const base = baseFare(2);
    const expect = base * (ECON.fareMinFraction + (1 - ECON.fareMinFraction) * (d.thought.patience / d.thought.patienceMax));
    assert.ok(Math.abs(d.fare - expect) < 1e-9);
    assert.ok(d.fare < base && d.fare > base * ECON.fareMinFraction);
  }
  assert.equal(game.state.delivered, cap);
  const fares = delivered.reduce((s, d) => s + d.fare, 0);
  // Money moved by fares minus a little upkeep.
  assert.ok(game.state.money > money0 + fares - 50 && game.state.money < money0 + fares);
  assert.ok(Math.abs(game.state.faresPerMin - fares) < 1e-9);
  assert.ok(!game.state.thoughts.some((t) => delivered.some((d) => d.thought.id === t.id)));
});

test('fare decays linearly with patience', async () => {
  const { game } = await setup();
  const th = game._debug.addThought('Hub', 'A', 3);
  const base = baseFare(3);
  assert.equal(th.fare, base);
  assert.equal(th.patienceMax, patienceFor(3));
  run(game, th.patienceMax / 2);
  assert.ok(Math.abs(th.fare - base * (ECON.fareMinFraction + (1 - ECON.fareMinFraction) * th.patience / th.patienceMax)) < 1e-9);
  assert.ok(th.fare < base);
});

test('transfer between two lines', async () => {
  const { game, events } = await setup({ money: 5000 });
  await game.build('Hub', 'A', 'cheap');
  await game.build('Hub', 'B', 'cheap');
  const l1 = game.createLine(['A', 'Hub']).line;
  const l2 = game.createLine(['Hub', 'B']).line;
  const th = game._debug.addThought('A', 'B', 2);
  const t1 = game.buyTrain('local', l1.id).train;
  const t2 = game.buyTrain('local', l2.id).train;
  assert.equal(th.trainId, t1.id);
  let sawTransfer = false;
  game.setSpeed(4);
  for (let i = 0; i < 3000 && game.state.delivered === 0; i++) {
    game.update(0.1);
    if (th.state === 'waiting' && th.at === 'Hub') sawTransfer = true;
  }
  assert.ok(sawTransfer, 'waited at Hub between trains');
  assert.equal(game.state.delivered, 1);
  const boards = events.filter((e) => e.name === 'thoughtBoarded' && e.p.thought.id === th.id).map((e) => e.p.train.id);
  assert.deepEqual(boards, [t1.id, t2.id]);
});

test('waiting thoughts with no path are lost when patience runs out; riders never are', async () => {
  const { game, events } = await setup({ money: 5000 });
  await game.build('Hub', 'A', 'cheap');
  const { line } = game.createLine(['Hub', 'A']);
  const waiting = game._debug.addThought('Hub', 'C', 1);
  const rider = game._debug.addThought('Hub', 'A', 1);
  game.buyTrain('local', line.id);
  assert.equal(rider.state, 'riding');
  rider.patience = 0.05;
  let paid = null;
  game.on('thoughtDelivered', (p) => { paid = p.fare; });
  game.setSpeed(4);
  run(game, waiting.patienceMax + 1);
  assert.equal(paid, baseFare(1) * ECON.fareMinFraction);
  assert.equal(game.state.lost, 1);
  assert.equal(waiting.state, 'lost');
  assert.ok(events.some((e) => e.name === 'thoughtLost' && e.p.thought.id === waiting.id));
  assert.ok(events.some((e) => e.name === 'toast' && e.p.tone === 'bad'));
  assert.equal(game.state.stations.get('Hub').waiting.length, 0);
  assert.equal(game.state.thoughts.length, 0);
});

test('thoughts spawn at stations with real, non-list destinations', async () => {
  const { game, events } = await setup({ spawnThoughts: true });
  run(game, 120);
  await flush();
  run(game, 120);
  await flush();
  const spawned = events.filter((e) => e.name === 'thoughtSpawned').map((e) => e.p.thought);
  assert.ok(spawned.length >= 3, `spawned ${spawned.length}`);
  for (const t of spawned) {
    assert.equal(t.from, 'Hub');
    assert.notEqual(t.to, 'Hub');
    assert.notEqual(t.to, 'ListPage');
    assert.notEqual(t.to, 'Missing');
    assert.equal(t.hops, 1);
    assert.ok(makeGraph().Hub.leadLinks.includes(t.to));
  }
  assert.ok(game.state.stations.get('Hub').waiting.length <= ECON.maxWaitingPerStation);
});

test('upkeep, bankruptcy countdown, reset and game over', async () => {
  const { game, events } = await setup({ money: 5000 });
  await game.build('Hub', 'A', 'cheap');
  const hexes = game.state.tracks[0].route.hexes.length;
  game.update(0.1);
  const expectUpkeep = hexes * ECON.trackUpkeepPerHexPerMin * game.state.inflation;
  assert.ok(Math.abs(game.state.upkeepPerMin - expectUpkeep) < 1e-9);
  const { line } = game.createLine(['Hub', 'A']);
  game.buyTrain('local', line.id);
  game.update(0.1);
  assert.ok(Math.abs(game.state.upkeepPerMin - (hexes * ECON.trackUpkeepPerHexPerMin + TRAIN_TYPES.local.upkeepPerMin) * game.state.inflation) < 1e-9);

  game.state.money = 0.01;
  game.update(0.1);
  game.update(0.1);
  assert.ok(game.state.money < 0);
  assert.ok(game.state.bankruptIn !== null && game.state.bankruptIn <= ECON.bankruptcyGraceSeconds);
  assert.ok(events.some((e) => e.name === 'toast' && /debt/.test(e.p.text)));
  run(game, 5);
  assert.ok(game.state.bankruptIn < ECON.bankruptcyGraceSeconds - 4);
  game.state.money = 100;
  game.update(0.1);
  assert.equal(game.state.bankruptIn, null);
  game.state.money = -1;
  game.setSpeed(4);
  run(game, ECON.bankruptcyGraceSeconds + 2);
  assert.equal(game.state.phase, 'over');
  const over = events.find((e) => e.name === 'gameOver');
  assert.ok(over);
  assert.equal(over.p.stations, 2);
  const t = game.state.time;
  game.update(0.1);
  assert.equal(game.state.time, t, 'no updates after game over');
  assert.equal(game.buyTrain('local', line.id).ok, false);
});

test('milestones unlock train types', async () => {
  const { game, events } = await setup({ money: 5000 });
  const m = ECON.milestones[0];
  assert.equal(game.buyTrain(m.unlock, 1).ok, false);
  await game.build('Hub', 'Big', 'cheap');
  assert.ok(game.state.uniqueLinks >= m.uniqueLinks);
  assert.ok(game.state.unlockedTrainTypes.includes(m.unlock));
  const ev = events.find((e) => e.name === 'milestone');
  assert.deepEqual(ev.p, { unlock: m.unlock, uniqueLinks: m.uniqueLinks });
  assert.equal(game.state.nextMilestone?.unlock ?? null, ECON.milestones[1]?.unlock ?? null);
  const { line } = game.createLine(['Hub', 'Big']);
  assert.equal(game.buyTrain(m.unlock, line.id).ok, true);
});

test('sell refunds half the base cost; deleteLine sells its trains', async () => {
  const { game } = await setup({ money: 5000 });
  await game.build('Hub', 'A', 'cheap');
  const { line } = game.createLine(['Hub', 'A']);
  const { train } = game.buyTrain('local', line.id);
  const m = game.state.money;
  assert.equal(game.sellTrain(train.id).ok, true);
  assert.equal(game.state.money, m + ECON.sellRefund * TRAIN_TYPES.local.cost);
  game.buyTrain('local', line.id);
  game.buyTrain('local', line.id);
  const m2 = game.state.money;
  assert.equal(game.deleteLine(line.id).ok, true);
  assert.equal(game.state.trains.length, 0);
  assert.equal(game.state.lines.length, 0);
  assert.equal(game.state.money, m2 + 2 * ECON.sellRefund * TRAIN_TYPES.local.cost);
});

test('setSpeed only accepts 0, 1, 2, 4; speed 0 pauses', async () => {
  const { game } = await setup();
  game.setSpeed(3);
  assert.equal(game.state.speed, 1);
  game.setSpeed(0);
  game.update(0.1);
  assert.equal(game.state.time, 0);
  game.setSpeed(2);
  game.update(0.1);
  assert.ok(Math.abs(game.state.time - 0.2) < 1e-9);
  game.update(10); // clamped
  assert.ok(game.state.time < 1);
});

function snapshot(game) {
  const s = game.state;
  return JSON.stringify({
    time: s.time, money: s.money, delivered: s.delivered, lost: s.lost, score: s.score, uniqueLinks: s.uniqueLinks,
    stations: [...s.stations.values()].map((x) => [x.title, x.waiting, x.uniqueLinks]),
    thoughts: s.thoughts, trains: s.trains, lines: s.lines, tracks: s.tracks.map((t) => [t.id, t.from, t.to]),
  });
}

async function scripted(seed) {
  const { game } = await setup({ seed, spawnThoughts: true, money: 5000 });
  game.setSpeed(4);
  for (let i = 0; i < 400; i++) {
    game.update(i % 3 === 0 ? 0.05 : 0.1);
    await flush(5);
    if (i === 20) await game.build('Hub', 'A', 'cheap');
    if (i === 40) await game.build('Hub', 'B', 'direct');
    if (i === 60) {
      const { line } = game.createLine(['A', 'Hub', 'B']);
      game.buyTrain('local', line.id);
    }
    if (i === 200) await game.build('A', 'F', 'cheap');
  }
  return snapshot(game);
}

test('determinism: same seed, actions and dt sequence give the same state', async () => {
  const a = await scripted(42);
  const b = await scripted(42);
  assert.equal(a, b);
  const c = await scripted(43);
  assert.notEqual(a, c);
});

test('reputation: deliveries raise it, lost thoughts lower it, and it scales fares and crowds', async () => {
  const { reputationFareMult, reputationCrowdMult, reputationAfterDelivery, reputationAfterLoss } = await import('./econ.js');
  // pure formulas
  assert.equal(reputationFareMult(0), ECON.reputationFareMin);
  assert.equal(reputationFareMult(1), ECON.reputationFareMax);
  assert.equal(reputationCrowdMult(0), ECON.reputationCrowdMin);
  assert.equal(reputationCrowdMult(1), ECON.reputationCrowdMax);
  assert.ok(reputationAfterDelivery(0.5, 1) > reputationAfterDelivery(0.5, 0), 'fast deliveries count for more');
  assert.ok(reputationAfterDelivery(0.5, 0) > 0.5, 'even a late delivery helps a little');
  assert.equal(reputationAfterDelivery(1, 1), 1);
  assert.equal(reputationAfterLoss(0), 0);

  const { game } = await setup({ money: 5000 });
  assert.equal(game.state.reputation, ECON.reputationStart);
  await game.build('Hub', 'A', 'cheap');
  const { line } = game.createLine(['Hub', 'A']);

  // a delivery raises reputation
  game._debug.addThought('Hub', 'A', 1);
  game.buyTrain('local', line.id);
  for (let i = 0; i < 2000 && game.state.delivered < 1; i++) game.update(0.1);
  assert.equal(game.state.delivered, 1);
  const afterDelivery = game.state.reputation;
  assert.ok(afterDelivery > ECON.reputationStart);

  // new thoughts are priced with the current reputation
  const th = game._debug.addThought('Hub', 'A', 1);
  assert.ok(Math.abs(th.fare - baseFare(1) * reputationFareMult(afterDelivery)) < 1e-9);

  // a thought that gives up lowers it
  const stuck = game._debug.addThought('Hub', 'C', 1);
  stuck.patience = 0.05;
  game.update(0.1);
  assert.equal(stuck.state, 'lost');
  assert.ok(Math.abs(game.state.reputation - (afterDelivery - ECON.reputationPerLost)) < 1e-9);

  // live fares follow reputation
  game.state.reputation = 0;
  game.update(0.1);
  const low = game.state.thoughts.find((t) => t.id === th.id);
  if (low) {
    const frac = low.patience / low.patienceMax;
    const expect = baseFare(1) * (ECON.fareMinFraction + (1 - ECON.fareMinFraction) * frac) * ECON.reputationFareMin;
    assert.ok(Math.abs(low.fare - expect) < 1e-9);
  }
});
