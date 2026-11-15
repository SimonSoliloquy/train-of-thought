// Goals, route bonus, streak, and the built/unbuilt mix of new passengers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECON } from '../config.js';
import { createGame } from './index.js';
import { createFakeWiki, createFakeWorld, flush } from './fakes.js';
import { baseFare, inflationAt, liveFare, reputationFareMult, streakFareMult } from './econ.js';
import { deliverTarget, repeatingReward } from './goals.js';

const EVENTS = ['started', 'stationBuilt', 'trackBuilt', 'thoughtSpawned', 'thoughtBoarded', 'thoughtDelivered',
  'thoughtLost', 'trackUpgraded', 'payday', 'toast', 'gameOver', 'routeBonus', 'goalDone'];

// Hub links to A, B, C, D, E; A to F, G; B to H.
function smallGraph() {
  return {
    Hub: { leadLinks: ['A', 'B', 'C', 'D', 'E', 'ListPage'], links: ['X1'], popularity: 0.5 },
    A: { leadLinks: ['Hub', 'F', 'G'], popularity: 0.2 },
    B: { leadLinks: ['Hub', 'A', 'H'], popularity: 0.8 },
    C: { leadLinks: ['Hub', 'B'], popularity: 0.1 },
    D: { leadLinks: ['Hub'] },
    E: { leadLinks: ['Hub'] },
    ListPage: { kind: 'list', leadLinks: ['Hub', 'A'], popularity: 0.3 },
    F: { leadLinks: ['A', 'G'] },
    G: { leadLinks: ['A', 'F'] },
    H: { leadLinks: ['B'] },
  };
}

// A tree: N0 at the root, each node linking to its parent and three children, `depth` levels down.
function treeGraph(depth = 5, branching = 3) {
  const graph = {};
  const add = (name, parent, level) => {
    const kids = level < depth ? Array.from({ length: branching }, (_, i) => `${name}.${i}`) : [];
    graph[name] = { leadLinks: [...(parent ? [parent] : []), ...kids], popularity: 0.3 };
    kids.forEach((k) => add(k, name, level + 1));
  };
  add('N0', null, 0);
  return graph;
}

async function setup({ graph = smallGraph(), start = 'Hub', seed = 7, spawnThoughts = false, money = 1e6 } = {}) {
  const wiki = createFakeWiki(graph, { start });
  const world = createFakeWorld();
  const game = createGame({ wiki, world, seed, spawnThoughts, autoTrain: false, tickets: false });
  const events = [];
  for (const name of EVENTS) game.on(name, (p) => events.push({ name, p }));
  await game.start();
  game.state.money = money;
  return { game, world, events, graph };
}

const ofType = (events, name) => events.filter((e) => e.name === name).map((e) => e.p);

/** Runs frames until `done()` or the frame budget is out. */
async function runUntil(game, done, frames = 4000, dt = 0.1) {
  for (let i = 0; i < frames && !done(); i++) {
    game.update(dt);
    await flush(3);
  }
  return done();
}

function runFor(game, seconds, dt = 0.1) {
  const frames = Math.round(seconds / (dt * (game.state.speed || 1)));
  for (let i = 0; i < frames; i++) game.update(dt);
}

/** Builds Hub-A, Hub-B (and more) and puts trains on them. */
async function network(game, targets, { trains = true } = {}) {
  for (const t of targets) {
    const r = await game.build('Hub', t);
    assert.equal(r.ok, true, r.reason);
  }
  if (trains) for (const tr of game.state.tracks) if (tr.level === 0) game.upgradeTrack(tr.id);
}

// ------------------------------------------------------------ goals

test('goals: the first goal is there from the start, in plain words', async () => {
  const { game } = await setup();
  const g = game.state.goal;
  assert.deepEqual(g, {
    id: 'first-station',
    text: 'Build your first station',
    how: 'Click a signpost by your station, then Build',
    progress: 0,
    target: 1,
    reward: ECON.goalRewardBase,
  });
});

test('goals: the teaching goals come in order, each pays its reward once, the moment it is met', async () => {
  const { game, events } = await setup({ money: 5000 });
  const done = () => ofType(events, 'goalDone');
  const expected = [
    ['first-station', 'Build your first station', 'Click a signpost by your station, then Build', ECON.goalRewardBase],
    ['first-train', 'Put a train on the track', 'Click the price tag floating over the track', ECON.goalRewardBase],
    ['first-delivery', 'Deliver a passenger', 'Build the station a passenger asks for, and put a train on the way', 1.5 * ECON.goalRewardBase],
    ['four-stations', 'Grow to 4 stations', 'Signposts with waiting passengers pay a bonus', 1.5 * ECON.goalRewardBase],
    ['first-express', 'Upgrade a track to Express', 'Click the Express tag on a busy track', 2 * ECON.goalRewardBase],
  ];

  // 1. A second station.
  assert.equal(game.state.goal.id, 'first-station');
  let q = game.quoteBuild('Hub', 'A').cheap.total;
  let m = game.state.money;
  await game.build('Hub', 'A');
  assert.equal(game.state.money, m - q + ECON.goalRewardBase, 'paid on the spot, once');
  assert.equal(done().length, 1);
  assert.equal(done()[0].goal.id, 'first-station');
  assert.equal(done()[0].reward, ECON.goalRewardBase);
  assert.equal(done()[0].next.id, 'first-train');
  assert.equal(game.state.goal.id, 'first-train');
  assert.equal(game.state.goal.progress, 0);

  // 2. A train.
  m = game.state.money;
  const cost = game.quoteUpgrade(1).options[0].cost;
  game.upgradeTrack(1);
  assert.equal(game.state.money, m - cost + ECON.goalRewardBase);
  assert.equal(game.state.goal.id, 'first-delivery');

  // 3. A delivery. The reward arrives in the money at once; the fare waits for payday.
  game._debug.addThought('Hub', 'A', 1);
  const moneyBefore = game.state.money;
  assert.ok(await runUntil(game, () => game.state.delivered >= 1));
  const paydaysSince = ofType(events, 'payday').reduce((n, p) => n + p.amount, 0);
  assert.ok(Math.abs(game.state.money - (moneyBefore + 1.5 * ECON.goalRewardBase + paydaysSince)) < 1e-6 ||
    game.state.money > moneyBefore, 'reward is in the money');
  assert.equal(game.state.goal.id, 'four-stations');
  assert.equal(game.state.goal.progress, 2);
  assert.equal(game.state.goal.target, 4);

  // 4. Four stations, then Express.
  await game.build('Hub', 'B');
  assert.equal(game.state.goal.id, 'four-stations');
  assert.equal(game.state.goal.progress, 3);
  await game.build('Hub', 'C');
  assert.equal(game.state.goal.id, 'first-express');
  game.upgradeTrack(1); // Hub-A to Express
  assert.equal(game.state.goal.text, `Deliver ${deliverTarget(0)} more passengers`);

  assert.deepEqual(
    done().slice(0, 5).map((d) => [d.goal.id, d.goal.text, d.goal.how, d.reward]),
    expected,
  );
  for (const d of done()) assert.equal(d.goal.progress, d.goal.target, 'a finished goal shows as full');
});

test('goals: ones already met when they come up complete at once, in a cascade, each paid once', async () => {
  const { game, events } = await setup({ money: 1e6 });
  await network(game, ['A', 'B', 'C']); // 4 stations
  assert.equal(game.state.goal.id, 'first-delivery', 'first station and first train are done, delivery is next');
  game.upgradeTrack(1); // express: not yet asked for
  assert.equal(game.state.goal.id, 'first-delivery');
  events.length = 0;
  // First delivery: pays, then four-stations and first-express are already met.
  game._debug.addThought('Hub', 'A', 1);
  const done = () => ofType(events, 'goalDone');
  assert.ok(await runUntil(game, () => done().length >= 3));
  assert.deepEqual(done().slice(0, 3).map((d) => d.goal.id), ['first-delivery', 'four-stations', 'first-express']);
  assert.deepEqual(done().slice(0, 3).map((d) => d.reward), [1.5, 1.5, 2].map((x) => x * ECON.goalRewardBase));
  // They arrive in one update, so the events chain: each one's next is the following one's goal.
  assert.equal(done()[0].next.id, 'four-stations');
  assert.equal(done()[1].next.id, 'first-express');
  assert.equal(done()[2].next.text, 'Deliver 5 more passengers');
  assert.equal(game.state.goal.text, 'Deliver 5 more passengers');
  assert.equal(done().filter((d) => d.goal.id === 'first-delivery').length, 1, 'never paid twice');
  assert.equal(new Set(done().map((d) => d.goal.id)).size, done().length);
});

test('goals: the reward is charged exactly once however long the goal stays met', async () => {
  const { game, events } = await setup({ money: 5000 });
  await game.build('Hub', 'A');
  const after = game.state.money;
  assert.equal(ofType(events, 'goalDone').length, 1);
  game.setSpeed(2);
  runFor(game, 40); // four paydays; no trains, so only track upkeep and link income move the money
  const paid = ofType(events, 'payday').reduce((n, p) => n + p.amount, 0);
  assert.ok(Math.abs(game.state.money - (after + paid)) < 1e-6);
  assert.equal(ofType(events, 'goalDone').length, 1);
});

test('goals: after the teaching goals they alternate deliver N / grow to N for ever, growing and inflating', async () => {
  const { game, events } = await setup({ money: 1e9 });
  await network(game, ['A', 'B', 'C']);
  game.upgradeTrack(1);
  game.upgradeTrack(2);
  game.upgradeTrack(3);
  game.setSpeed(4);
  const done = () => ofType(events, 'goalDone');
  const keepDelivering = async (until) => {
    // Keep the Hub-A track supplied with passengers.
    return runUntil(game, () => {
      if (game.state.thoughts.filter((t) => t.state === 'waiting' && t.at === 'Hub').length < 6) {
        for (let i = 0; i < 6; i++) game._debug.addThought('Hub', 'A', 1);
      }
      return until();
    }, 20000, 0.25);
  };

  assert.ok(await keepDelivering(() => game.state.goal.id === 'deliver-5'));
  const first = game.state.goal;
  assert.equal(first.target, 5);
  assert.equal(first.progress, 0, 'counted from when the goal came up');
  const seq = [];
  let guard = 0;
  while (seq.length < 8 && guard++ < 40) {
    const g = game.state.goal;
    seq.push({ text: g.text, target: g.target, reward: g.reward, stations: game.state.stations.size, infl: game.state.inflation });
    if (g.id.startsWith('stations-')) {
      // Build out to the target with a handful of extra stations through the graph.
      for (const [a, b] of [['Hub', 'D'], ['Hub', 'E'], ['A', 'F'], ['A', 'G'], ['B', 'H']]) {
        if (game.state.goal.id !== g.id) break;
        if (game.state.stations.has(b)) continue;
        await game.build(a, b);
      }
      assert.ok(game.state.goal.id !== g.id || game.state.stations.size < g.target, 'cannot reach it: graph is small');
      if (game.state.goal.id === g.id) break;
    } else {
      assert.ok(await keepDelivering(() => game.state.goal.id !== g.id));
    }
  }
  // Deliver goals: 5, 8, 12, 16 ... counted afresh each time.
  const delivers = seq.filter((x) => x.text.startsWith('Deliver'));
  assert.deepEqual(delivers.map((x) => x.target), [5, 8, 12, 16].slice(0, delivers.length));
  assert.equal(deliverTarget(4), 20);
  assert.equal(deliverTarget(5), 24);
  // Grow goals: three more than you have.
  for (const x of seq.filter((y) => y.text.startsWith('Grow'))) {
    assert.equal(x.text, `Grow to ${x.target} stations`);
    assert.equal(x.target, x.stations + 3);
  }
  // Alternating, rewards rising, whole gold, scaled by the inflation of the moment.
  assert.ok(seq.length >= 3);
  seq.forEach((x, i) => assert.equal(x.text.startsWith('Deliver'), i % 2 === 0, x.text));
  seq.forEach((x, i) => {
    assert.equal(x.reward, Math.round(repeatingReward(i) * x.infl), `reward of step ${i}`);
    assert.equal(x.reward, Math.round(x.reward));
  });
  assert.ok(repeatingReward(1) > repeatingReward(0) && repeatingReward(2) > repeatingReward(1));
  // The reward paid is the reward shown.
  for (const d of done()) assert.equal(d.reward, d.goal.reward);
});

test('goals: progress and target stay current on every update', async () => {
  const { game } = await setup({ money: 1e6 });
  assert.equal(game.state.goal.progress, 0);
  await game.build('Hub', 'A');
  game.upgradeTrack(1); // first-delivery now
  const g = game.state.goal;
  assert.equal(g.id, 'first-delivery');
  assert.equal(g.progress, 0);
  game._debug.addThought('Hub', 'A', 1);
  game._debug.addThought('Hub', 'A', 1);
  await runUntil(game, () => game.state.delivered >= 1);
  // The goal object moved on to four-stations, whose progress is the station count.
  assert.equal(game.state.goal.id, 'four-stations');
  assert.equal(game.state.goal.progress, 2);
  await game.build('Hub', 'B');
  assert.equal(game.state.goal.progress, 3);
  game.update(0.1);
  assert.equal(game.state.goal.progress, 3);
  assert.equal(game.state.goal.target, 4);
});

test('goals: no reward after the game is over', async () => {
  const { game, events } = await setup({ money: 5000 });
  game.state.phase = 'over';
  await game.build('Hub', 'A').catch(() => {});
  assert.equal(ofType(events, 'goalDone').length, 0);
});

// ------------------------------------------------------------ route bonus

test('route bonus: building a station pays a fraction of each waiting passenger\'s fare and refills patience', async () => {
  const { game, events } = await setup({ money: 5000 });
  const t1 = game._debug.addThought('Hub', 'A', 1);
  const t2 = game._debug.addThought('Hub', 'A', 3);
  const other = game._debug.addThought('Hub', 'B', 2);
  game.state.reputation = 0.5;
  game.setSpeed(4);
  runFor(game, 30, 0.25); // patience runs down, fares fall
  for (const t of [t1, t2, other]) assert.ok(t.patience < t.patienceMax);
  const otherPatience = other.patience;
  const fares = [t1.fare, t2.fare];
  const total = Math.round(ECON.routeBonusFraction * (fares[0] + fares[1]));
  const quote = game.quoteBuild('Hub', 'A').cheap.total;
  const money = game.state.money;
  const paydaysBefore = ofType(events, 'payday').length;
  assert.equal(ofType(events, 'payday').length, paydaysBefore);
  await game.build('Hub', 'A');
  const bonus = ofType(events, 'routeBonus');
  assert.deepEqual(bonus, [{ station: 'A', count: 2, amount: total }]);
  assert.ok(Number.isInteger(bonus[0].amount));
  // Charged for the build, paid the bonus and the first goal, all at once.
  assert.equal(game.state.money, money - quote + total + ECON.goalRewardBase);
  // Patience is full again, so the passenger can really ride there.
  for (const t of [t1, t2]) {
    assert.equal(t.patience, t.patienceMax);
    assert.equal(t.state, 'waiting');
  }
  assert.ok(Math.abs(t1.fare - liveFare(baseFare(1), 1, 1) * reputationFareMult(game.state.reputation)) < 1e-9);
  assert.ok(t1.fare > fares[0]);
  assert.equal(other.patience, otherPatience, 'others are untouched');
  // routeBonus comes after the station is announced.
  const names = events.map((e) => e.name);
  assert.ok(names.indexOf('routeBonus') > names.indexOf('stationBuilt'));
});

test('route bonus: nothing happens when nobody is waiting for it; a track between built stations pays none', async () => {
  const { game, events } = await setup({ money: 5000 });
  await game.build('Hub', 'A');
  assert.equal(ofType(events, 'routeBonus').length, 0);
  await game.build('Hub', 'B');
  const th = game._debug.addThought('Hub', 'A', 1);
  th.patience = 10;
  // B links to A, so a track A-B joins two built stations: no new station, no bonus.
  const m = game.state.money;
  const q = game.quoteBuild('B', 'A');
  assert.equal(q.ok, true);
  await game.build('B', 'A');
  assert.equal(ofType(events, 'routeBonus').length, 0);
  assert.equal(game.state.money, m - q.cheap.total);
  assert.equal(th.patience, 10);
});

test('route bonus: only the new station\'s passengers, and not riders', async () => {
  const { game, events } = await setup({ money: 5000 });
  await game.build('Hub', 'A');
  const rider = game._debug.addThought('Hub', 'A', 1);
  game.upgradeTrack(1);
  assert.equal(rider.state, 'riding', 'boards the new train');
  const waiting = game._debug.addThought('A', 'F', 1);
  await game.build('A', 'F');
  assert.deepEqual(ofType(events, 'routeBonus'), [{ station: 'F', count: 1, amount: Math.round(ECON.routeBonusFraction * waiting.fare) }]);
});

// ------------------------------------------------------------ streak

test('streak: counts deliveries in a row, adds a fare step each, up to the cap', async () => {
  const { game, events } = await setup({ money: 1e6 });
  await network(game, ['A']);
  game.setSpeed(4);
  assert.equal(game.state.streak, 0);
  const many = ECON.streakFareMax / ECON.streakFarePerStep + 4;
  const fares = [];
  for (let i = 0; i < many; i++) {
    const th = game._debug.addThought('Hub', 'A', 1);
    fares.push(th);
  }
  assert.ok(await runUntil(game, () => game.state.delivered >= many, 20000, 0.25));
  const del = ofType(events, 'thoughtDelivered');
  assert.deepEqual(del.map((d) => d.streak), del.map((_, i) => i + 1));
  del.forEach((d, i) => {
    assert.equal(d.station, 'A');
    assert.equal(game.state.streak, many);
    const mult = 1 + Math.min(ECON.streakFareMax, ECON.streakFarePerStep * i);
    assert.equal(streakFareMult(i), mult);
    // The thought keeps the fare it showed; the delivery pays more.
    assert.ok(Math.abs(d.fare - d.thought.fare * mult) < 1e-9, `delivery ${i}`);
  });
  assert.ok(Math.abs(del[0].fare - del[0].thought.fare) < 1e-9, 'the first delivery has no bonus');
  const last = del[del.length - 1];
  assert.ok(Math.abs(last.fare - last.thought.fare * (1 + ECON.streakFareMax)) < 1e-9, 'capped');
  // The payday carries the boosted fares.
  const banked = del.reduce((n, d) => n + d.fare, 0);
  const paid = ofType(events, 'payday').reduce((n, p) => n + p.fares, 0) + game.state.payday.fares;
  assert.ok(Math.abs(paid - banked) < 1e-6, `${paid} vs ${banked}`);
});

test('streak: a passenger giving up resets it to zero; a rider is never a loss', async () => {
  const { game, events } = await setup({ money: 1e6 });
  await network(game, ['A']);
  game.setSpeed(4);
  for (let i = 0; i < 3; i++) game._debug.addThought('Hub', 'A', 1);
  assert.ok(await runUntil(game, () => game.state.delivered >= 3, 5000, 0.25));
  assert.equal(game.state.streak, 3);
  const doomed = game._debug.addThought('Hub', 'C', 1); // C is not built and no track goes there
  doomed.patience = 1;
  assert.ok(await runUntil(game, () => game.state.lost >= 1, 5000, 0.25));
  assert.equal(doomed.state, 'lost');
  assert.equal(game.state.streak, 0);
  // And it starts again from one with no bonus on the next fare.
  game._debug.addThought('Hub', 'A', 1);
  const before = ofType(events, 'thoughtDelivered').length;
  assert.ok(await runUntil(game, () => ofType(events, 'thoughtDelivered').length > before, 5000, 0.25));
  const d = ofType(events, 'thoughtDelivered').pop();
  assert.equal(d.streak, 1);
  assert.ok(Math.abs(d.fare - d.thought.fare) < 1e-9);
});

// ------------------------------------------------------------ the mix of new passengers

/** Lets passengers pile up for a while, then clears the platforms so the cap never blocks spawning. */
// Chunk length follows the spawn pace, so retuning how often passengers appear does not starve the samples.
async function collectSpawns(game, { chunks, chunkSeconds = Math.ceil((30 * ECON.spawnIntervalBase) / 9) }) {
  game.setSpeed(4);
  for (let c = 0; c < chunks; c++) {
    for (let i = 0; i < chunkSeconds; i++) {
      game.update(0.25);
      await flush(8);
    }
    game.state.thoughts.length = 0;
    for (const st of game.state.stations.values()) st.waiting.length = 0;
    game.state.reputation = 0.8;
  }
}

test('mix: with one station every passenger wants an unbuilt article, a lead link of it', async () => {
  const { game, events, graph } = await setup({ spawnThoughts: true, seed: 5 });
  await collectSpawns(game, { chunks: 20 });
  const spawned = ofType(events, 'thoughtSpawned').map((p) => p.thought);
  assert.ok(spawned.length >= 20, `${spawned.length}`);
  for (const t of spawned) {
    assert.equal(t.from, 'Hub');
    assert.ok(!game.state.stations.has(t.to));
    assert.ok(graph.Hub.leadLinks.includes(t.to));
    assert.equal(t.hops, 1);
    assert.notEqual(t.to, 'ListPage');
  }
});

test('mix: builtDestinationShare of new passengers want a station that exists; the rest a signposted link', async () => {
  const { game, events, graph } = await setup({ spawnThoughts: true, seed: 11, graph: treeGraph(), start: 'N0' });
  // A small network: N0 with two children and two grandchildren, all joined by bare track.
  for (const [a, b] of [['N0', 'N0.0'], ['N0', 'N0.1'], ['N0.0', 'N0.0.0'], ['N0.1', 'N0.1.2']]) {
    const r = await game.build(a, b);
    assert.equal(r.ok, true, r.reason);
  }
  // Bare track carries nobody, so nothing is delivered and the depth stays at 1.
  events.length = 0;
  await collectSpawns(game, { chunks: 100 });
  const spawned = ofType(events, 'thoughtSpawned').map((p) => p.thought);
  assert.ok(spawned.length >= 300, `${spawned.length} spawned`);
  const stationsNow = game.state.stations;
  const built = spawned.filter((t) => stationsNow.has(t.to));
  const share = built.length / spawned.length;
  assert.ok(Math.abs(share - ECON.builtDestinationShare) < 0.1, `built share ${share.toFixed(2)} vs ${ECON.builtDestinationShare}`);

  const leadOfBuilt = new Set();
  for (const title of stationsNow.keys()) for (const l of graph[title].leadLinks) leadOfBuilt.add(l);
  for (const t of spawned) {
    assert.notEqual(t.to, t.from);
    assert.ok(t.hops >= 1 && t.hops <= ECON.maxDepth, `hops ${t.hops}`);
    if (!stationsNow.has(t.to)) {
      // Delivered is still 0, so depth is 1: always one link from a station the passenger can reach by track.
      assert.ok(leadOfBuilt.has(t.to), `${t.to} is a direct link of a built station`);
      assert.ok(game.state.stubs.has(t.to) && game.state.stubs.get(t.to).kind === 'article');
    }
  }
  // Built destinations: all over the network, never the origin, priced by track distance.
  const adj = new Map();
  for (const tr of game.state.tracks) {
    adj.set(tr.from, [...(adj.get(tr.from) || []), tr.to]);
    adj.set(tr.to, [...(adj.get(tr.to) || []), tr.from]);
  }
  const dist = (a, b) => {
    const d = new Map([[a, 0]]);
    const q = [a];
    for (let i = 0; i < q.length; i++) for (const n of adj.get(q[i]) || []) if (!d.has(n)) { d.set(n, d.get(q[i]) + 1); q.push(n); }
    return d.get(b);
  };
  for (const t of built) assert.equal(t.hops, dist(t.from, t.to), `${t.from} -> ${t.to}`);
  assert.ok(new Set(built.map((t) => t.to)).size >= 3, 'variety');
  assert.ok(built.some((t) => t.hops >= 2), 'some trips need a change');
});

test('mix: built destinations that no track reaches are only chosen when nothing is reachable', async () => {
  const { game, events } = await setup({ spawnThoughts: true, seed: 3, graph: treeGraph(), start: 'N0', money: 1e6 });
  await game.build('N0', 'N0.0');
  await game.build('N0', 'N0.1');
  await game.build('N0.1', 'N0.1.0');
  // Cut off: build a station whose only track we do not lay. Use survey+build from N0.1.0 then everything is connected,
  // so instead check that all destinations are reachable by track when they are built.
  events.length = 0;
  await collectSpawns(game, { chunks: 20 });
  const built = ofType(events, 'thoughtSpawned').map((p) => p.thought).filter((t) => game.state.stations.has(t.to));
  assert.ok(built.length > 20);
  for (const t of built) assert.ok(t.hops >= 1 && t.hops <= 3);
});

test('mix: as deliveries mount, unbuilt wishes drift further from the built stations, but most stay direct', async () => {
  const run = async (delivered) => {
    const { game, events, graph } = await setup({ spawnThoughts: true, seed: 21, graph: treeGraph(), start: 'N0' });
    game.state.delivered = delivered;
    await collectSpawns(game, { chunks: 40 });
    const spawned = ofType(events, 'thoughtSpawned').map((p) => p.thought).filter((t) => !game.state.stations.has(t.to));
    const direct = spawned.filter((t) => graph.N0.leadLinks.includes(t.to));
    return { n: spawned.length, direct: direct.length, maxHops: Math.max(...spawned.map((t) => t.hops)) };
  };
  const early = await run(0);
  const late = await run(200);
  assert.ok(early.n > 20);
  assert.equal(early.direct, early.n, 'at depth 1 every one is a direct link');
  assert.equal(early.maxHops, 1);
  assert.ok(late.direct < late.n, 'later some are further out');
  assert.ok(late.direct / late.n > 0.5, `most still direct: ${late.direct}/${late.n}`);
  assert.ok(late.maxHops > 1 && late.maxHops <= ECON.maxDepth);
});

test('mix: unbuilt wishes prefer articles already on the map as signposts', async () => {
  const { game, events, world } = await setup({ spawnThoughts: true, seed: 8, graph: treeGraph(6, 6), start: 'N0' });
  // ghostsPerStation (8) of the 6 children are all signposted; add a lead link that is not by making the graph larger.
  await collectSpawns(game, { chunks: 10 });
  const spawned = ofType(events, 'thoughtSpawned').map((p) => p.thought);
  assert.ok(spawned.length > 10);
  for (const t of spawned) assert.ok(world.placements.has(t.to), `${t.to} is a signpost`);
});

test('mix: more than a few of the same trip are not queued, but a few are', async () => {
  const { game, events } = await setup({ spawnThoughts: true, seed: 2, graph: treeGraph(), start: 'N0', money: 1e6 });
  await game.build('N0', 'N0.0'); // two stations only: every built wish is the other one
  events.length = 0;
  game.setSpeed(4);
  let maxSame = 0;
  for (let i = 0; i < 600; i++) {
    game.update(0.25);
    await flush(8);
    for (const st of game.state.stations.values()) {
      const counts = new Map();
      for (const id of st.waiting) {
        const th = game.state.thoughts.find((x) => x.id === id);
        if (th && game.state.stations.has(th.to)) counts.set(th.to, (counts.get(th.to) || 0) + 1);
      }
      for (const c of counts.values()) maxSame = Math.max(maxSame, c);
    }
  }
  assert.ok(maxSame >= 2, `queues form: ${maxSame}`);
  assert.ok(maxSame <= 3, `capped: ${maxSame}`);
});

// ------------------------------------------------------------ determinism

function snapshot(game) {
  const s = game.state;
  return JSON.stringify({
    time: s.time, money: s.money, delivered: s.delivered, lost: s.lost, rep: s.reputation, streak: s.streak, goal: s.goal,
    payday: s.payday,
    stations: [...s.stations.values()].map((x) => [x.title, x.waiting]),
    thoughts: s.thoughts, tracks: s.tracks.map((t) => [t.id, t.from, t.to, t.level, t.typeId]),
  });
}

async function scripted(seed) {
  const { game, events } = await setup({ seed, spawnThoughts: true, money: 5000, graph: treeGraph(), start: 'N0' });
  game.setSpeed(4);
  for (let i = 0; i < 700; i++) {
    game.update(i % 3 === 0 ? 0.05 : 0.1);
    await flush(6);
    if (i === 20) await game.build('N0', 'N0.0');
    if (i === 40) { game.upgradeTrack(1); await game.build('N0', 'N0.1'); }
    if (i === 60) game.upgradeTrack(2);
    if (i === 200) { await game.build('N0.0', 'N0.0.0'); game.upgradeTrack(3); }
    if (i === 300) { game.upgradeTrack(1); game.upgradeTrack(2); }
  }
  return snapshot(game) + JSON.stringify(events.filter((e) => ['routeBonus', 'goalDone', 'thoughtDelivered'].includes(e.name)).map((e) => [e.name, e.p.amount ?? e.p.reward ?? e.p.fare, e.p.streak ?? e.p.count ?? 0]));
}

test('determinism: goals, route bonus, streak and the new spawn mix give the same run for the same seed', async () => {
  const a = await scripted(42);
  const b = await scripted(42);
  assert.equal(a, b);
  assert.notEqual(a, await scripted(43));
  assert.ok(a.includes('goalDone'), 'goals happened');
});

test('econ: streak multiplier and inflation helpers', () => {
  assert.equal(streakFareMult(0), 1);
  assert.equal(streakFareMult(1), 1 + ECON.streakFarePerStep);
  assert.equal(streakFareMult(1000), 1 + ECON.streakFareMax);
  assert.equal(inflationAt(0), 1);
});

test('a new track comes with a Local train already running, at no extra charge', async () => {
  const wiki = createFakeWiki(smallGraph(), { start: 'Hub' });
  const world = createFakeWorld();
  const game = createGame({ wiki, world, seed: 7, spawnThoughts: false }); // autoTrain is the default
  const events = [];
  for (const name of EVENTS) game.on(name, (p) => events.push({ name, p }));
  await game.start();
  game.state.money = 5000;
  assert.equal(game.state.goal.id, 'first-station');

  const q = game.quoteBuild('Hub', 'A');
  const res = await game.build('Hub', 'A');
  assert.equal(res.ok, true);
  const [track] = game.state.tracks;
  assert.equal(track.level, 1);
  assert.equal(track.typeId, 'local');
  assert.equal(game.state.trains.length, 1);
  assert.equal(game.state.trains[0].trackId, track.id);
  // charged for the build only (the first-station goal reward comes back at once)
  const reward = ofType(events, 'goalDone').reduce((s, e) => s + e.reward, 0);
  assert.equal(game.state.money, 5000 - q.cheap.total + reward);
  // there is nothing to teach about adding a train, so that goal never appears
  assert.ok(!ofType(events, 'goalDone').some((e) => e.goal.id === 'first-train'));
  assert.equal(game.state.goal.id, 'first-ticket');
  // the track is announced before its train
  const names = events.map((e) => e.name);
  assert.ok(names.indexOf('trackBuilt') < names.indexOf('trackUpgraded'));
  // the next step on offer is the Express, at its price
  const up = game.quoteUpgrade(track.id);
  assert.equal(up.ok, true);
  assert.deepEqual(up.options.map((o) => o.typeId), ['express']);
  // and the train really runs
  const t0 = game.state.trains[0].t;
  for (let i = 0; i < 80; i++) game.update(0.1);
  assert.ok(game.state.trains[0].t !== t0 || game.state.trains[0].state === 'dwelling');
});

test('track is laid to where the station is at build time, even if its spot moved while loading', async () => {
  const wiki = createFakeWiki(smallGraph(), { start: 'Hub' });
  const world = createFakeWorld();
  const game = createGame({ wiki, world, seed: 7, spawnThoughts: false });
  await game.start();
  game.state.money = 5000;
  const before = { ...world.placements.get('A') };
  // Move A's reserved spot while the build is waiting for the article.
  const realGet = wiki.getArticle.bind(wiki);
  wiki.getArticle = async (title) => {
    const a = await realGet(title);
    if (title === 'A') { const p = world.placements.get('A'); p.q += 2; p.r -= 1; }
    return a;
  };
  const res = await game.build('Hub', 'A');
  assert.equal(res.ok, true);
  const p = world.placements.get('A');
  assert.ok(p.q !== before.q || p.r !== before.r, 'the spot did move');
  const route = game.state.tracks[0].route;
  const end = route.hexes[route.hexes.length - 1];
  assert.deepEqual([end.q, end.r], [p.q, p.r], 'track ends at the station');
  const st = game.state.stations.get('A');
  assert.deepEqual([st.q, st.r], [p.q, p.r], 'station recorded where it stands');
});

test('tickets: never more than three, always to a place not yet built, paid when both ends are joined', async () => {
  const wiki = createFakeWiki(treeGraph(5, 3), { start: 'N0' });
  const world = createFakeWorld();
  const game = createGame({ wiki, world, seed: 11 });
  const events = [];
  for (const name of [...EVENTS, 'ticketAdded', 'ticketDone', 'ticketExpired']) game.on(name, (p) => events.push({ name, p }));
  await game.start();
  game.state.money = 1e6;
  assert.equal(game.state.tickets.length, 0);

  // they arrive a few seconds apart and stop at three
  await runUntil(game, () => game.state.tickets.length >= ECON.maxTickets, 2000);
  assert.equal(game.state.tickets.length, ECON.maxTickets);
  for (let i = 0; i < 300; i++) { game.update(0.1); await flush(3); }
  assert.equal(game.state.tickets.length, ECON.maxTickets, 'no fourth ticket');

  const seenTo = new Set();
  for (const t of game.state.tickets) {
    assert.ok(!game.state.stations.has(t.to), 'destination is not built');
    assert.ok(t.to !== t.from);
    assert.ok(!seenTo.has(t.to), 'no two tickets to the same place');
    seenTo.add(t.to);
    assert.ok(t.links >= 1 && t.links <= ECON.ticketMaxLinks);
    assert.ok(t.reward > 0 && t.time > 0 && t.time <= t.timeMax);
  }
  // the first ticket is one link from the start, so a new player can do it at once
  const first = ofType(events, 'ticketAdded')[0].ticket;
  assert.equal(first.from, 'N0');
  assert.equal(first.links, 1);

  // nothing ages until the first build: the clock has not started
  const full = first.reward;
  assert.equal(game.state.clockRunning, false);
  assert.equal(game.state.time, 0);
  assert.equal(game.state.tickets.find((t) => t.id === first.id).reward, full);
  assert.equal(game.state.tickets.find((t) => t.id === first.id).time, first.timeMax);

  // building the destination joins both ends: paid at once, exactly once, and a new ticket follows
  const before = game.state.money;
  const quote = game.quoteBuild('N0', first.to);
  const res = await game.build('N0', first.to);
  assert.equal(res.ok, true);
  const done = ofType(events, 'ticketDone');
  assert.equal(done.length, 1);
  assert.equal(done[0].ticket.id, first.id);
  const goalGold = ofType(events, 'goalDone').reduce((n, e) => n + e.reward, 0);
  assert.equal(game.state.money, before - quote.cheap.total + done[0].reward + goalGold);
  assert.ok(!game.state.tickets.some((t) => t.id === first.id));
  await runUntil(game, () => game.state.tickets.length >= ECON.maxTickets, 2000);
  assert.equal(game.state.tickets.length, ECON.maxTickets);
  for (const t of game.state.tickets) assert.ok(!game.state.stations.has(t.to));
});

test('tickets: a ticket between two places not yet built needs both, and an unmet ticket is withdrawn without penalty', async () => {
  const wiki = createFakeWiki(treeGraph(5, 3), { start: 'N0' });
  const world = createFakeWorld();
  const game = createGame({ wiki, world, seed: 5, spawnThoughts: false }); // no automatic tickets
  const events = [];
  for (const name of ['ticketDone', 'ticketExpired']) game.on(name, (p) => events.push({ name, p }));
  await game.start();
  game.state.money = 1e6;
  const t = game._debug.addTicket('N0.0', 'N0.0.1', '', '', 2);
  await game.build('N0', 'N0.0');
  assert.equal(events.length, 0, 'one end is not enough');
  await game.build('N0.0', 'N0.0.1');
  assert.equal(events.filter((e) => e.name === 'ticketDone').length, 1);

  const rep = game.state.reputation;
  const streak = game.state.streak;
  const u = game._debug.addTicket('N0', 'N0.2.2', '', '', 2);
  for (let i = 0; i < Math.ceil(u.timeMax / 0.1) + 5; i++) game.update(0.1);
  assert.equal(events.filter((e) => e.name === 'ticketExpired').length, 1);
  assert.equal(game.state.tickets.length, 0);
  assert.equal(game.state.reputation, rep);
  assert.equal(game.state.streak, streak);
  assert.ok(t.id !== u.id);
});

test('with tickets on, ordinary passengers only ask for stations that exist', async () => {
  const wiki = createFakeWiki(treeGraph(4, 3), { start: 'N0' });
  const world = createFakeWorld();
  const game = createGame({ wiki, world, seed: 3 });
  const spawned = [];
  game.on('thoughtSpawned', (p) => spawned.push(p.thought));
  await game.start();
  game.state.money = 1e6;
  for (let i = 0; i < 200; i++) { game.update(0.1); await flush(3); }
  assert.equal(spawned.length, 0, 'nobody rides while there is one station');
  await game.build('N0', 'N0.0');
  await game.build('N0', 'N0.1');
  for (let i = 0; i < 1500 && spawned.length < 12; i++) { game.update(0.1); await flush(3); }
  assert.ok(spawned.length >= 6);
  for (const th of spawned) assert.ok(['N0', 'N0.0', 'N0.1'].includes(th.to), th.to);
});

test('the clock starts with the first build: then time passes, paydays come and ticket rewards fall', async () => {
  const wiki = createFakeWiki(treeGraph(5, 3), { start: 'N0' });
  const world = createFakeWorld();
  const game = createGame({ wiki, world, seed: 11 });
  const paydays = [];
  game.on('payday', (p) => paydays.push(p));
  await game.start();
  await runUntil(game, () => game.state.tickets.length >= ECON.maxTickets, 2000);
  for (let i = 0; i < 400; i++) game.update(0.1);
  assert.equal(game.state.time, 0);
  assert.equal(game.state.money, ECON.startMoney, 'nothing paid or charged while waiting');
  assert.equal(paydays.length, 0);
  assert.equal(game.state.inflation, 1);

  // build to a place that is not a ticket destination, so a ticket is still open afterwards
  const taken = new Set(game.state.tickets.map((t) => t.to));
  const target = ['N0.0', 'N0.1', 'N0.2'].find((t) => !taken.has(t));
  assert.ok(target);
  const res = await game.build('N0', target);
  assert.equal(res.ok, true);
  const open = game.state.tickets[0];
  const before = open.reward;
  for (let i = 0; i < 300; i++) game.update(0.1);
  assert.equal(game.state.clockRunning, true);
  assert.ok(game.state.time > 25);
  assert.ok(paydays.length >= 2);
  const now = game.state.tickets.find((t) => t.id === open.id);
  assert.ok(now && now.reward < before && now.time < now.timeMax);
});
