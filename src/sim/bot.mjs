// Headless balance bot. Usage:
//   node src/sim/bot.mjs [--seed N] [--minutes 45] [--world fake|real] [--strategy play|idle] [--quiet]
// Plays the sim on a synthetic wiki graph and prints a table every 2 game minutes.
import { mulberry32 } from '../hex.js';
import { TRAIN_TYPES, ECON } from '../config.js';
import { createGame } from './index.js';
import { inflationAt } from './econ.js';
import { createFakeWiki, createFakeWorld, flush } from './fakes.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);
const SEED = Number(args.seed ?? 1);
const MINUTES = Number(args.minutes ?? 45);
const STRATEGY = args.strategy ?? 'play';
const WORLD_KIND = args.world ?? 'fake';

// ------------------------------------------------------------ synthetic wiki
export function makeSyntheticGraph(seed, n = 400) {
  const r = mulberry32(seed * 7919 + 13);
  const V = 30000;
  const title = (i) => `Article ${((i % n) + n) % n}`;
  const graph = {};
  for (let i = 0; i < n; i++) {
    const K = 60 + Math.floor(540 * r() * r());           // 60..600, skewed low
    const centre = (i * V) / n;
    const spread = K * 1.2 + 40;
    const links = new Set();
    let guard = 0;
    while (links.size < K && guard++ < K * 20) {
      const off = (r() + r() + r() - 1.5) * spread;       // bell-ish: neighbours overlap heavily
      links.add(`Concept ${Math.floor(((centre + off) % V + V) % V)}`);
    }
    const leadCount = 8 + Math.floor(r() * 9);
    const lead = new Set();
    guard = 0;
    while (lead.size < leadCount && guard++ < 200) {
      const far = r() < 0.12;
      const j = far ? Math.floor(r() * n) : i + (r() < 0.5 ? -1 : 1) * (1 + Math.floor(r() * 14));
      const t = title(j);
      if (t !== title(i)) lead.add(t);
    }
    for (let k = 0; k < 6; k++) links.add(title(i + 15 + Math.floor(r() * 10)));
    const roll = r();
    graph[title(i)] = {
      kind: i === 0 ? 'article' : roll < 0.04 ? 'list' : roll < 0.07 ? 'disambiguation' : 'article',
      popularity: 0.1 + 0.8 * r(),
      leadLinks: [...lead],
      links: [...links],
    };
  }
  return graph;
}

// ------------------------------------------------------------ bot
export async function runBot({ seed = SEED, minutes = MINUTES, strategy = STRATEGY, worldKind = WORLD_KIND, print = true } = {}) {
  const graph = makeSyntheticGraph(seed);
  const wiki = createFakeWiki(graph, { start: 'Article 0' });
  let world;
  if (worldKind === 'real') {
    const { createWorld } = await import('../world/index.js');
    world = createWorld({ seed });
  } else {
    world = createFakeWorld();
  }
  const game = createGame({ wiki, world, seed });
  await game.start();
  game.setSpeed(4);
  const s = game.state;
  const articleLinks = {};
  for (const [t, g] of Object.entries(graph)) {
    articleLinks[t] = [...new Set([...g.leadLinks, ...g.links])].filter((x) => graph[x]);
  }

  const rows = [];
  let lastMoney = s.money;
  let lastBuildAt = -999;
  let idleBuilt = 0;
  let fareEma = 0; // faresPerMin smoothed over ~3 game minutes
  const reserve = () => Math.max(60, 2 * s.upkeepPerMin);

  // Shortest link path from any built station to target (over real articles), depth <= 4.
  function planPath(target) {
    const prev = new Map();
    const q = [];
    for (const t of s.stations.keys()) { prev.set(t, null); q.push([t, 0]); }
    for (let i = 0; i < q.length; i++) {
      const [cur, d] = q[i];
      if (cur === target) break;
      if (d >= 4) continue;
      for (const nx of articleLinks[cur] || []) {
        if (prev.has(nx)) continue;
        prev.set(nx, cur);
        q.push([nx, d + 1]);
      }
    }
    if (!prev.has(target)) return null;
    const path = [target];
    while (prev.get(path[0]) !== null) path.unshift(prev.get(path[0]));
    return path;
  }

  function attachToLines(a, b) {
    for (const line of s.lines) {
      const st = line.stations;
      if (st.length >= 7) continue;
      if (st[st.length - 1] === a) { if (game.setLineStations(line.id, [...st, b]).ok) return; }
      if (st[0] === a) { if (game.setLineStations(line.id, [b, ...st]).ok) return; }
    }
    const res = game.createLine([a, b]);
    if (res.ok) game.buyTrain('local', res.line.id);
  }

  async function tryBuild(from, to, { lines = true } = {}) {
    if (!world.placements.has(to)) {
      const sv = await game.survey(from, to);
      if (!sv.ok) return false;
    }
    const q = game.quoteBuild(from, to);
    if (!q.ok) { if (process.env.BOTDEBUG) console.log('quote fail', from, to, q.reason); return false; }
    const trainPrice = Math.round(TRAIN_TYPES.local.cost * s.inflation);
    const needsTrain = lines && !s.lines.some((l) => l.stations.at(-1) === from || l.stations[0] === from);
    if (q.cheap.total + reserve() + (needsTrain ? trainPrice : 0) > s.money) { if (process.env.BOTDEBUG) console.log('poor', from, to, q.cheap.total, q.cheap.trackCost, s.money.toFixed(0)); return false; }
    // Only grow while the network pays for itself (fares + link income cover upkeep after the build).
    const addedUpkeep = q.cheap.route.hexes.length * ECON.trackUpkeepPerHexPerMin * s.inflation;
    const earning = fareEma + s.incomePerMin;
    const growth = inflationAt(s.time + 300) / s.inflation; // upkeep five minutes from now
    if (strategy === 'careful' && !s.stations.has(to) && s.stations.size >= 14) return false;
    if (lines && s.stations.size >= 5 && earning < (s.upkeepPerMin + addedUpkeep) * growth) {
      if (process.env.BOTDEBUG) console.log('hold', from, to, earning.toFixed(0), s.upkeepPerMin.toFixed(0));
      return false;
    }
    const r = await game.build(from, to, 'cheap');
    if (!r.ok) return false;
    if (lines) attachToLines(from, to);
    lastBuildAt = s.time;
    return true;
  }

  async function decide() {
    if (strategy === 'idle' || strategy === 'lazy') {
      // idle: lays four tracks and walks away. lazy: same plus one line with one train.
      if (idleBuilt < 4) {
        const ghosts = [...world.placements.values()].filter((p) => p.state === 'ghost' && graph[p.title]?.kind === 'article');
        for (const g of ghosts) {
          if (await tryBuild('Article 0', g.title, { lines: false })) { idleBuilt++; break; }
        }
        if (idleBuilt === 4 && strategy === 'lazy') {
          const near = s.tracks.map((t) => (t.from === 'Article 0' ? t.to : t.from));
          const res = game.createLine([near[0], 'Article 0', near[1]]);
          if (res.ok) game.buyTrain('local', res.line.id);
        }
      }
      return;
    }
    // 1. Build the step that serves the most waiting fare per unit of cost.
    if (s.time - lastBuildAt > 3) {
      const steps = new Map();
      const wanted = s.thoughts.filter((t) => t.state === 'waiting' && !s.stations.has(t.to)).sort((a, b) => b.fare - a.fare);
      for (const th of wanted.slice(0, 14)) {
        const path = planPath(th.to);
        if (!path || path.length < 2 || path.length > 4) continue;
        const key = `${path[0]}\u0000${path[1]}`;
        const e = steps.get(key) || { from: path[0], to: path[1], value: 0 };
        e.value += th.fare / (path.length - 1);
        steps.set(key, e);
      }
      const options = [];
      for (const e of steps.values()) {
        if (!world.placements.has(e.to)) { options.push({ ...e, cost: 250 * s.inflation }); continue; }
        const q = game.quoteBuild(e.from, e.to);
        if (q.ok) options.push({ ...e, cost: q.cheap.total });
      }
      options.sort((a, b) => b.value / b.cost - a.value / a.cost);
      for (const o of options.slice(0, 3)) {
        if (o.value < o.cost * 0.25) break; // not worth it yet
        if (await tryBuild(o.from, o.to)) break;
      }
      // Connect built destinations that are not on the line network.
      for (const th of s.thoughts) {
        if (th.state !== 'waiting' || !s.stations.has(th.to)) continue;
        if (game._debug.router.stopsBetween(th.at, th.to) !== null) continue;
        const a = th.at, b = th.to;
        if (game.trackBetween(a, b)) { attachToLines(a, b); break; }
        if (game.quoteBuild(a, b).ok && (await tryBuild(a, b))) break;
      }
    }
    // 0. In debt: sell a spare train.
    if (s.bankruptIn !== null) {
      const line = [...s.lines].sort((a, b) => b.trainIds.length - a.trainIds.length)[0];
      if (line && line.trainIds.length > 1) game.sellTrain(line.trainIds.at(-1));
    }
    // 2. Trains where thoughts pile up.
    for (const line of s.lines) {
      let waiting = 0;
      for (const t of line.stations) {
        for (const id of s.stations.get(t).waiting) {
          const th = s.thoughts.find((x) => x.id === id);
          if (th && game._debug.router.stopsBetween(t, th.to) !== null) waiting++;
        }
      }
      const cap = line.trainIds.length * TRAIN_TYPES.local.capacity;
      const type = s.unlockedTrainTypes.includes('express') && line.stations.length > 3 ? 'express' : 'local';
      const price = Math.round(TRAIN_TYPES[type].cost * s.inflation);
      if (line.trainIds.length < 3 && waiting > cap && s.money > price + reserve() * 2) {
        game.buyTrain(type, line.id);
      }
    }
  }

  const header = ' min |    money | net/min | stations | delivered | lost | infl | upkeep/min | fares/min | income/min | links | trains';
  if (print) console.log(`seed ${seed}, strategy ${strategy}, world ${worldKind}\n${header}`);
  const totalSeconds = minutes * 60;
  let nextReport = 120;
  while (s.phase === 'running' && s.time < totalSeconds) {
    game.update(0.25); // speed 4 -> 1 game second
    fareEma += (s.faresPerMin - fareEma) / 180;
    await flush(30);
    await decide();
    await flush(30);
    if (s.time >= nextReport - 1e-6 || s.phase !== 'running') {
      const row = {
        min: s.time / 60,
        money: s.money,
        net: (s.money - lastMoney) / 2,
        stations: s.stations.size,
        delivered: s.delivered,
        lost: s.lost,
        infl: s.inflation,
        upkeep: s.upkeepPerMin,
        fares: s.faresPerMin,
        income: s.incomePerMin,
        links: s.uniqueLinks,
        trains: s.trains.length,
        phase: s.phase,
      };
      rows.push(row);
      lastMoney = s.money;
      nextReport += 120;
      if (print) {
        console.log(
          `${row.min.toFixed(1).padStart(4)} | ${row.money.toFixed(0).padStart(8)} | ${row.net.toFixed(0).padStart(7)} | ${String(row.stations).padStart(8)} | ${String(row.delivered).padStart(9)} | ${String(row.lost).padStart(4)} | ${row.infl.toFixed(2)} | ${row.upkeep.toFixed(0).padStart(10)} | ${row.fares.toFixed(0).padStart(9)} | ${row.income.toFixed(1).padStart(10)} | ${String(row.links).padStart(5)} | ${String(row.trains).padStart(6)}${row.phase === 'over' ? '  BANKRUPT' : ''}`,
        );
      }
    }
  }
  const result = { game, seed, strategy, endMinute: s.time / 60, phase: s.phase, score: s.score, delivered: s.delivered, lost: s.lost, stations: s.stations.size, trains: s.trains.length, lines: s.lines.length, rows };
  if (print) console.log(`end: ${result.phase} at ${result.endMinute.toFixed(1)} min, score ${result.score}, stations ${result.stations}, trains ${result.trains}, lines ${result.lines}, delivered ${result.delivered}, lost ${result.lost}`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bot.mjs')) {
  await runBot();
}
