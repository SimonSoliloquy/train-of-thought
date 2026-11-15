import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECON, TRAIN_TYPES, TRACK_UPGRADES } from '../config.js';
import { createGame } from './index.js';
import { createFakeWiki, createFakeWorld, flush } from './fakes.js';
import { inflationAt, baseFare, patienceFor, stationBaseCost, reputationFareMult } from './econ.js';

const BIG_LINKS = Array.from({ length: 50 }, (_, i) => `Concept ${i}`);

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
    'thoughtBoarded', 'thoughtDelivered', 'thoughtLost', 'trackUpgraded', 'trainsChanged', 'payday', 'toast', 'gameOver']) {
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
  assert.equal(game.state.payday.period, ECON.paydaySeconds);
  assert.equal(game.state.payday.last, null);
  assert.equal(game.state.tracks.length, 0);
  assert.equal(game.state.trains.length, 0);
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
  assert.equal(game.state.money, before - q.cheap.total + ECON.goalRewardBase, 'the first station completes the first goal');
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
  assert.equal(game.state.money, 5000 - total + ECON.goalRewardBase, 'charged once; the first goal paid once');
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
  assert.ok(!events.some((e) => e.name === 'toast'), 'building is not toast-worthy');
  const t = game.state.tracks[0];
  assert.deepEqual([t.level, t.typeId, t.trainId], [0, null, null]);
});

test('build defaults to the cheap route', async () => {
  const { game } = await setup({ money: 5000 });
  const q = game.quoteBuild('Hub', 'A');
  await game.build('Hub', 'A');
  assert.equal(game.state.money, 5000 - q.cheap.total + ECON.goalRewardBase);
  assert.equal(game.state.tracks[0].route.style, 'cheap');
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
  const total = [...game.state.stations.values()].reduce((n, st) => n + st.incomePerMin, 0);
  assert.ok(Math.abs(total - 19 * ECON.linkIncomePerUniqueLinkPerMin) < 1e-9);
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

// ------------------------------------------------------------ track upgrades

async function network(edges, { money = 1e6, seed = 7 } = {}) {
  const ctx = await setup({ money, seed });
  for (const [a, b] of edges) {
    const r = await ctx.game.build(a, b);
    assert.equal(r.ok, true, r.reason);
  }
  return ctx;
}

function trainOn(game, a, b) {
  const tr = game.trackBetween(a, b);
  return game.state.trains.find((t) => t.id === tr.trainId) || null;
}

test('upgrade ladder: bare -> local -> express -> freight or bullet, exact charging', async () => {
  const { game, events } = await network([['Hub', 'A']], { money: 5000 });
  const track = game.state.tracks[0];
  assert.equal(game.quoteUpgrade(999).ok, false);

  let q = game.quoteUpgrade(track.id);
  assert.equal(q.ok, true);
  assert.deepEqual(q.options.map((o) => o.typeId), TRACK_UPGRADES[0]);
  const o = q.options[0];
  assert.equal(o.name, TRAIN_TYPES.local.name);
  assert.equal(o.blurb, TRAIN_TYPES.local.blurb);
  assert.equal(o.cost, Math.round(TRAIN_TYPES.local.cost * game.state.inflation));
  assert.equal(o.affordable, true);

  let m = game.state.money;
  assert.deepEqual(game.upgradeTrack(track.id), { ok: true });
  assert.equal(game.state.money, m - o.cost + ECON.goalRewardBase, 'the first train completes the second goal');
  assert.deepEqual([track.level, track.typeId], [1, 'local']);
  const local = game.state.trains[0];
  assert.equal(track.trainId, local.id);
  assert.equal(local.trackId, track.id);
  assert.equal(local.state, 'dwelling');
  assert.equal(local.atStation, track.from);
  assert.ok(events.some((e) => e.name === 'trackUpgraded' && e.p.track === track && e.p.train === local));
  assert.ok(events.some((e) => e.name === 'trainsChanged'));

  assert.equal(game.upgradeTrack(track.id, 'bullet').ok, false, 'cannot skip express');
  assert.equal(game.state.money, m - o.cost + ECON.goalRewardBase);
  m = game.state.money;
  const qe = game.quoteUpgrade(track.id).options;
  assert.deepEqual(qe.map((x) => x.typeId), ['express']);
  assert.equal(game.upgradeTrack(track.id, 'express').ok, true);
  assert.equal(game.state.money, m - qe[0].cost);
  assert.equal(track.level, 2);

  q = game.quoteUpgrade(track.id);
  assert.deepEqual(q.options.map((x) => x.typeId), ['freight', 'bullet']);
  m = game.state.money;
  const noChoice = game.upgradeTrack(track.id);
  assert.equal(noChoice.ok, false);
  assert.match(noChoice.reason, /Freight or Bullet/);
  assert.equal(game.upgradeTrack(track.id, 'local').ok, false);
  assert.equal(game.state.money, m);
  game.state.money = q.options[0].cost - 1;
  assert.equal(game.quoteUpgrade(track.id).options[0].affordable, false);
  assert.equal(game.upgradeTrack(track.id, 'freight').ok, false, 'unaffordable');
  assert.equal(game.state.money, q.options[0].cost - 1);
  game.state.money = 5000;
  assert.equal(game.upgradeTrack(track.id, 'freight').ok, true);
  assert.equal(game.state.money, 5000 - q.options[0].cost);
  assert.deepEqual([track.level, track.typeId], [3, 'freight']);
  assert.equal(game.state.trains.length, 1, 'still one train per track');

  const done = game.quoteUpgrade(track.id);
  assert.equal(done.ok, false);
  assert.match(done.reason, /fully upgraded/);
  assert.equal(game.upgradeTrack(track.id, 'bullet').ok, false);
});

test('upgrade prices inflate', async () => {
  const { game } = await network([['Hub', 'A']]);
  game.setSpeed(4);
  run(game, 600, 0.25);
  const q = game.quoteUpgrade(game.state.tracks[0].id);
  assert.equal(q.options[0].cost, Math.round(TRAIN_TYPES.local.cost * inflationAt(game.state.time)));
});

test('a bare track carries nobody', async () => {
  const { game } = await network([['Hub', 'A']]);
  const th = game._debug.addThought('Hub', 'A', 1);
  run(game, 60);
  assert.equal(th.state, 'waiting');
  assert.equal(th.at, 'Hub');
  game.upgradeTrack(game.state.tracks[0].id);
  assert.equal(th.state, 'riding', 'boards the new train at once');
});

test('a train shuttles between its two stations, dwelling at each, never skipping at speed 4', async () => {
  const { game } = await network([['Hub', 'A']]);
  const track = game.state.tracks[0];
  game.upgradeTrack(track.id);
  const train = game.state.trains[0];
  game.setSpeed(4);
  const stops = [];
  const dwells = [];
  let prev = train.state, lastT = train.t, dwellStart = 0;
  for (let i = 0; i < 3000; i++) {
    game.update(0.1);
    if (train.state === 'dwelling' && prev === 'moving') { stops.push(train.atStation); dwellStart = game.state.time; }
    if (train.state === 'moving' && prev === 'dwelling' && stops.length) dwells.push(game.state.time - dwellStart);
    if (train.state === 'moving' && prev === 'moving') assert.ok(train.forward ? train.t >= lastT : train.t <= lastT);
    assert.ok(train.t >= 0 && train.t <= 1);
    prev = train.state;
    lastT = train.t;
  }
  assert.ok(stops.length > 20, `${stops.length} stops`);
  stops.forEach((s, i) => assert.equal(s, i % 2 === 0 ? track.to : track.from));
  for (const d of dwells) assert.ok(Math.abs(d - ECON.dwellSeconds) <= 0.4 + 1e-9, `dwell ${d}`);
});

test('capacity, delivery, and fares banked for the next payday', async () => {
  const { game, events } = await network([['Hub', 'A']]);
  const ths = [];
  for (let i = 0; i < 6; i++) ths.push(game._debug.addThought('Hub', 'A', 2));
  game.upgradeTrack(game.state.tracks[0].id);
  const cap = TRAIN_TYPES.local.capacity;
  const train = game.state.trains[0];
  assert.equal(train.passengers.length, cap);
  assert.equal(game.state.stations.get('Hub').waiting.length, 6 - cap);
  const delivered = [];
  game.on('thoughtDelivered', (p) => delivered.push({ ...p, money: game.state.money, banked: game.state.payday.fares }));
  for (let i = 0; i < 2000 && delivered.length < cap; i++) game.update(0.1);
  assert.equal(delivered.length, cap);
  for (const d of delivered) {
    assert.equal(d.station, 'A');
    const base = baseFare(2);
    assert.ok(d.fare < base * reputationFareMult(1) && d.fare > base * ECON.fareMinFraction * reputationFareMult(0));
  }
  // The fares sit in the payday until it pays out.
  const sum = delivered.reduce((n, d) => n + d.fare, 0);
  const pd = [];
  game.on('payday', (p) => pd.push(p));
  const money0 = game.state.money;
  const banked0 = game.state.payday.fares;
  assert.ok(Math.abs(banked0 - sum) < 1e-9 || banked0 < sum, 'fares banked (maybe split across paydays)');
  while (!pd.length) game.update(0.1);
  assert.ok(Math.abs(game.state.money - (money0 + pd[0].amount)) < 1e-9);
  assert.ok(pd[0].fares >= banked0 - 1e-9);
  assert.ok(events.some((e) => e.name === 'thoughtBoarded'));
});

test('upgrading takes over in place and keeps passengers aboard', async () => {
  const { game } = await network([['Hub', 'A']]);
  for (let i = 0; i < 3; i++) game._debug.addThought('Hub', 'A', 1);
  const track = game.state.tracks[0];
  game.upgradeTrack(track.id);
  let train = game.state.trains[0];
  for (let i = 0; i < 400 && !(train.state === 'moving' && train.t > 0.3); i++) game.update(0.1);
  assert.equal(train.state, 'moving');
  const before = { t: train.t, forward: train.forward, atStation: train.atStation, passengers: [...train.passengers] };
  assert.equal(before.passengers.length, 3);
  game.upgradeTrack(track.id); // express
  const exp = game.state.trains[0];
  assert.notEqual(exp, train);
  assert.equal(exp.typeId, 'express');
  assert.equal(track.trainId, exp.id);
  assert.deepEqual({ t: exp.t, forward: exp.forward, atStation: exp.atStation, passengers: exp.passengers }, before);
  for (const id of exp.passengers) assert.equal(game.state.thoughts.find((t) => t.id === id).trainId, exp.id);
  assert.equal(exp.state, 'moving');

  // A smaller final train: anyone who does not fit gets off where the train last stopped.
  const saved = TRAIN_TYPES.bullet.capacity;
  TRAIN_TYPES.bullet.capacity = 1;
  try {
    assert.equal(game.upgradeTrack(track.id, 'bullet').ok, true);
    const bullet = game.state.trains[0];
    assert.equal(bullet.passengers.length, 1);
    assert.equal(bullet.passengers[0], before.passengers[0]);
    const hub = game.state.stations.get(before.atStation);
    for (const id of before.passengers.slice(1)) {
      const th = game.state.thoughts.find((t) => t.id === id);
      assert.deepEqual([th.state, th.at, th.trainId], ['waiting', before.atStation, null]);
      assert.ok(hub.waiting.includes(id));
    }
  } finally {
    TRAIN_TYPES.bullet.capacity = saved;
  }
});

test('routing changes trains across tracks; unserved tracks are not part of the network', async () => {
  const { game, events } = await network([['Hub', 'A'], ['Hub', 'B']]);
  const th = game._debug.addThought('A', 'B', 2);
  const tA = game.trackBetween('Hub', 'A');
  const tB = game.trackBetween('Hub', 'B');
  game.upgradeTrack(tA.id);
  run(game, 30);
  assert.equal(th.state, 'waiting', 'Hub-B is bare, so there is no path yet');
  assert.equal(th.at, 'A');
  game.upgradeTrack(tB.id);
  game.setSpeed(4);
  let sawTransfer = false;
  for (let i = 0; i < 4000 && game.state.delivered === 0; i++) {
    game.update(0.1);
    if (th.state === 'waiting' && th.at === 'Hub') sawTransfer = true;
  }
  assert.equal(game.state.delivered, 1);
  assert.ok(sawTransfer);
  const boards = events.filter((e) => e.name === 'thoughtBoarded' && e.p.thought.id === th.id).map((e) => e.p.train.trackId);
  assert.deepEqual(boards, [tA.id, tB.id]);
});

test('waiting thoughts with no path give up; riders never do and pay the minimum', async () => {
  const { game, events } = await network([['Hub', 'A']]);
  const waiting = game._debug.addThought('Hub', 'C', 1);
  const rider = game._debug.addThought('Hub', 'A', 1);
  game.upgradeTrack(game.state.tracks[0].id);
  assert.equal(rider.state, 'riding');
  rider.patience = 0.05;
  let paid = null;
  let repAtDelivery = null;
  game.on('thoughtDelivered', (p) => { paid = p.fare; repAtDelivery = game.state.reputation; });
  game.setSpeed(4);
  const rep0 = game.state.reputation;
  run(game, waiting.patienceMax + 1);
  assert.ok(paid !== null);
  assert.ok(paid < baseFare(1) * ECON.fareMinFraction * reputationFareMult(1) + 1e-9);
  assert.ok(paid >= baseFare(1) * ECON.fareMinFraction * reputationFareMult(0) - 1e-9);
  assert.ok(repAtDelivery > rep0);
  assert.equal(game.state.lost, 1);
  assert.equal(waiting.state, 'lost');
  assert.ok(game.state.reputation < repAtDelivery, 'losing a thought costs reputation');
  assert.ok(events.some((e) => e.name === 'thoughtLost' && e.p.thought.id === waiting.id));
  assert.ok(events.some((e) => e.name === 'toast' && e.p.tone === 'bad'));
  assert.equal(game.state.thoughts.length, 0);
});

test('fares scale with reputation and decay with patience', async () => {
  const { game } = await setup();
  game.state.reputation = 1;
  const th = game._debug.addThought('Hub', 'A', 3);
  const base = baseFare(3);
  assert.ok(Math.abs(th.fare - base * ECON.reputationFareMax) < 1e-9);
  assert.equal(th.patienceMax, patienceFor(3));
  run(game, th.patienceMax / 2);
  const f = ECON.fareMinFraction + (1 - ECON.fareMinFraction) * th.patience / th.patienceMax;
  assert.ok(Math.abs(th.fare - base * f * reputationFareMult(game.state.reputation)) < 1e-9);
  game.state.reputation = 0;
  game.update(0.1);
  assert.ok(th.fare < base * f * ECON.reputationFareMin + 1e-6);
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

test('better reputation brings more thoughts', async () => {
  const count = async (rep) => {
    const { game, events } = await setup({ spawnThoughts: true, seed: 3 });
    game.state.reputation = rep;
    for (let i = 0; i < 8; i++) { run(game, 7); await flush(); game.state.reputation = rep; }
    return events.filter((e) => e.name === 'thoughtSpawned').length + game.state.lost;
  };
  assert.ok((await count(1)) > (await count(0)));
});

// ------------------------------------------------------------ payday

async function paydayCase(speed) {
  const { game } = await network([['Hub', 'A']], { money: 1000 });
  game.upgradeTrack(game.state.tracks[0].id);
  const money0 = game.state.money;
  game.setSpeed(speed);
  const paydays = [];
  const moneys = new Set();
  game.on('payday', (p) => paydays.push({ ...p, time: game.state.time, money: game.state.money }));
  const forecastAt0 = game.state.payday.forecast;
  let lastPaid = money0;
  while (game.state.time < 30 - 1e-6) {
    game.update(0.1);
    if (paydays.length === 0) moneys.add(game.state.money);
    // Between paydays money never moves.
    const expect = money0 + paydays.reduce((n, p) => n + p.amount, 0);
    assert.ok(Math.abs(game.state.money - expect) < 1e-9);
    lastPaid = expect;
    const p = game.state.payday;
    assert.ok(Math.abs(p.pending - (p.income + p.fares - p.upkeep)) < 1e-9);
    assert.ok(p.in >= 0 && p.in <= ECON.paydaySeconds);
  }
  return { game, paydays, money0, forecastAt0, moneys, lastPaid };
}

test('payday every paydaySeconds of game time at speed 1, money still in between', async () => {
  const { game, paydays, money0, forecastAt0, moneys } = await paydayCase(1);
  assert.equal(moneys.size, 1, 'money did not move before the first payday');
  assert.deepEqual(paydays.map((p) => Math.round(p.time * 1000) / 1000), [10, 20, 30].map((x) => x * ECON.paydaySeconds / 10));
  const hexes = game.state.tracks[0].route.hexes.length;
  const income = [...game.state.stations.values()].reduce((n, s) => n + s.incomePerMin, 0);
  const p0 = paydays[0];
  assert.ok(Math.abs(p0.income - (income * ECON.paydaySeconds) / 60) < 1e-6);
  // Upkeep: (track + train) per minute x inflation, integrated over the period.
  const rate = hexes * ECON.trackUpkeepPerHexPerMin + TRAIN_TYPES.local.upkeepPerMin;
  assert.ok(p0.upkeep > (rate * ECON.paydaySeconds) / 60 && p0.upkeep < (rate * inflationAt(ECON.paydaySeconds) * ECON.paydaySeconds) / 60 + 1e-9);
  assert.equal(p0.fares, 0);
  assert.ok(Math.abs(p0.amount - (p0.income + p0.fares - p0.upkeep)) < 1e-9);
  assert.ok(Math.abs(paydays[0].money - (money0 + p0.amount)) < 1e-9);
  assert.ok(Math.abs(forecastAt0 - p0.amount) < Math.abs(p0.amount) * 0.01 + 1e-6, `forecast ${forecastAt0} vs ${p0.amount}`);
  assert.deepEqual(game.state.payday.last, { amount: paydays[2].amount, income: paydays[2].income, fares: paydays[2].fares, upkeep: paydays[2].upkeep, time: game.state.time });
});

test('paydays land on the same game times at speed 4', async () => {
  const a = await paydayCase(1);
  const b = await paydayCase(4);
  assert.deepEqual(b.paydays.map((p) => Math.round(p.time * 1000)), a.paydays.map((p) => Math.round(p.time * 1000)));
  b.paydays.forEach((p, i) => assert.ok(Math.abs(p.amount - a.paydays[i].amount) < 1e-6));
});

test('forecast includes fares already banked', async () => {
  const { game } = await network([['Hub', 'A']]);
  game.update(0.1);
  const f0 = game.state.payday.forecast;
  game.state.payday.fares += 100; // as if a delivery just happened
  game.update(0.1);
  assert.ok(Math.abs(game.state.payday.forecast - (f0 + 100)) < 1, `${game.state.payday.forecast} vs ${f0 + 100}`);
});

test('bankruptcy: paydays drive money negative, countdown, recovery, game over', async () => {
  const { game, events } = await network([['Hub', 'A']], { money: 1000 });
  game.upgradeTrack(game.state.tracks[0].id);
  game.state.money = 0.01;
  // Upkeep beats link income, so the next payday takes money below zero.
  while (!game.state.payday.last) game.update(0.1);
  assert.ok(game.state.money < 0);
  game.update(0.1);
  assert.ok(game.state.bankruptIn !== null && game.state.bankruptIn <= ECON.bankruptcyGraceSeconds);
  assert.ok(events.some((e) => e.name === 'toast' && /debt/.test(e.p.text)));
  const m = game.state.money;
  run(game, 5);
  assert.equal(game.state.money, m, 'no payday inside those 5 seconds... money is flat');
  assert.ok(game.state.bankruptIn < ECON.bankruptcyGraceSeconds - 4);
  game.state.money = 100;
  game.update(0.1);
  assert.equal(game.state.bankruptIn, null);
  game.state.money = -1;
  game.setSpeed(4);
  run(game, ECON.bankruptcyGraceSeconds + 2);
  assert.equal(game.state.phase, 'over');
  const over = events.find((e) => e.name === 'gameOver');
  assert.equal(over.p.stations, 2);
  const t = game.state.time;
  game.update(0.1);
  assert.equal(game.state.time, t);
  assert.equal(game.upgradeTrack(game.state.tracks[0].id).ok, false);
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
    time: s.time, money: s.money, delivered: s.delivered, lost: s.lost, score: s.score, rep: s.reputation,
    payday: s.payday, uniqueLinks: s.uniqueLinks,
    stations: [...s.stations.values()].map((x) => [x.title, x.waiting, x.uniqueLinks]),
    thoughts: s.thoughts, trains: s.trains, tracks: s.tracks.map((t) => [t.id, t.from, t.to, t.level, t.typeId, t.trainId]),
  });
}

async function scripted(seed) {
  const { game } = await setup({ seed, spawnThoughts: true, money: 5000 });
  game.setSpeed(4);
  for (let i = 0; i < 500; i++) {
    game.update(i % 3 === 0 ? 0.05 : 0.1);
    await flush(5);
    if (i === 20) await game.build('Hub', 'A');
    if (i === 40) await game.build('Hub', 'B', 'direct');
    if (i === 60) { game.upgradeTrack(1); game.upgradeTrack(2); }
    if (i === 200) { await game.build('A', 'F'); game.upgradeTrack(1); }
    if (i === 300) game.upgradeTrack(1, 'bullet');
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
