// Headless balance bot. Usage:
//   node src/sim/bot.mjs [--seed N] [--minutes 45] [--world fake|real] [--strategy play|careful|lazy|idle]
//                        [--final auto|freight|bullet] [--quiet]
// Plays the sim on a synthetic wiki graph and prints a table every 2 game minutes.
import { mulberry32 } from '../hex.js';
import { TRAIN_TYPES, ECON } from '../config.js';
import { createGame } from './index.js';
import { inflationAt } from './econ.js';
import { createFakeWiki, createFakeWorld, flush } from './fakes.js';

// --set ECON.fareBase=50 --set TRAIN_TYPES.local.speed=1.2 ... overrides config values for an experiment (any number of times).
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== '--set') continue;
  const [path, value] = (process.argv[i + 1] || '').split('=');
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], { ECON, TRAIN_TYPES });
  target[last] = Number(value);
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a === '--set' || arr[i - 1] === '--set') return acc;
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);
const SEED = Number(args.seed ?? 1);
const MINUTES = Number(args.minutes ?? 45);
const STRATEGY = args.strategy ?? 'play';
const WORLD_KIND = args.world ?? 'fake';
const FINAL = args.final ?? 'auto';   // which final train the bot buys: its own rule, or always one kind

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
// Strategies:
//   play    builds toward thought destinations while the network pays (up to 30 stations), puts a Local on every
//           track it needs, upgrades tracks where passengers queue, and picks freight or bullet
//           by queue length.
//   careful the same, but stops at 14 stations.
//   lazy    lays four tracks, puts a Local on each, then does nothing.
//   idle    lays four tracks and does nothing.
export async function runBot({ seed = SEED, minutes = MINUTES, strategy = STRATEGY, worldKind = WORLD_KIND, final = FINAL, print = true } = {}) {
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
  const router = game._debug.router;
  const articleLinks = {};
  for (const [t, g] of Object.entries(graph)) {
    articleLinks[t] = [...new Set([...g.leadLinks, ...g.links])].filter((x) => graph[x]);
  }

  const rows = [];
  let lastMoney = s.money;
  let lastBuildAt = -999;
  let simpleBuilt = 0;
  let fareEma = 0;    // fares per minute, smoothed over ~3 game minutes (from paydays)
  let upkeepRate = 0; // per minute, from the last payday
  // Boardings per track over the last few minutes, and the longest queue seen there.
  const usage = new Map();
  const maxQueue = new Map();
  game.on('thoughtBoarded', ({ train }) => {
    const u = usage.get(train.trackId) || [];
    u.push(s.time);
    usage.set(train.trackId, u);
  });
  // What the economy gave the player besides fares, and why the final trains were chosen.
  const stats = {
    goals: 0, goalGold: 0, bonusEvents: 0, bonusPassengers: 0, bonusGold: 0, maxStreak: 0,
    spawned: 0, spawnedBuilt: 0, minMoneyFirst5: Infinity, minRepAfter4: Infinity,
    finals: [],   // { typeId, minute, queue, peakQueue, use }
  };
  game.on('goalDone', (p) => { stats.goals++; stats.goalGold += p.reward; });
  game.on('routeBonus', (p) => { stats.bonusEvents++; stats.bonusPassengers += p.count; stats.bonusGold += p.amount; });
  game.on('thoughtDelivered', (p) => { stats.maxStreak = Math.max(stats.maxStreak, p.streak); });
  game.on('thoughtSpawned', ({ thought }) => { stats.spawned++; if (s.stations.has(thought.to)) stats.spawnedBuilt++; });
  const usePerMin = (trackId) => {
    const u = (usage.get(trackId) || []).filter((t) => t > s.time - 180);
    usage.set(trackId, u);
    return u.length / 3;
  };
  game.on('payday', (p) => {
    const perMin = 60 / ECON.paydaySeconds;
    fareEma += (p.fares * perMin - fareEma) / 18;
    upkeepRate = p.upkeep * perMin;
  });
  const incomeRate = () => [...s.stations.values()].reduce((n, st) => n + st.incomePerMin, 0);
  const reserve = () => Math.max(60, 2 * upkeepRate);
  const localPrice = () => Math.round(TRAIN_TYPES.local.cost * s.inflation);

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

  async function tryBuild(from, to, { withLocal = true } = {}) {
    if (!world.placements.has(to)) {
      const sv = await game.survey(from, to);
      if (!sv.ok) return false;
    }
    const q = game.quoteBuild(from, to);
    if (!q.ok) return false;
    const extra = withLocal ? localPrice() : 0;
    if (q.cheap.total + extra + reserve() > s.money) return false;
    if (strategy === 'careful' && !s.stations.has(to) && s.stations.size >= 14) return false;
    if (strategy === 'play' && !s.stations.has(to) && s.stations.size >= 30) return false; // keeps the run affordable to simulate
    if (strategy === 'play' || strategy === 'careful') {
      // Only grow while fares + link income cover upkeep five minutes from now.
      const added = (q.cheap.route.hexes.length * ECON.trackUpkeepPerHexPerMin + TRAIN_TYPES.local.upkeepPerMin) * s.inflation;
      const growth = inflationAt(s.time + 300) / s.inflation;
      if (s.stations.size >= 8 && fareEma + incomeRate() < (upkeepRate + added) * growth * 0.8) return false;
    }
    const r = await game.build(from, to);
    if (!r.ok) return false;
    lastBuildAt = s.time;
    if (withLocal) game.upgradeTrack(game.trackBetween(from, to).id);
    return true;
  }

  // Waiting thoughts that would take this track next (from either end).
  function queueFor(track) {
    let n = 0;
    for (const end of [track.from, track.to]) {
      const other = end === track.from ? track.to : track.from;
      for (const id of s.stations.get(end).waiting) {
        const th = s.thoughts.find((x) => x.id === id);
        if (th && router.isGoodStep(th.to, end, other)) n++;
      }
    }
    return n;
  }

  async function decide() {
    if (strategy === 'idle' || strategy === 'lazy') {
      if (simpleBuilt < 4) {
        const ghosts = [...world.placements.values()].filter((p) => p.state === 'ghost' && graph[p.title]?.kind === 'article');
        for (const g of ghosts) {
          if (await tryBuild('Article 0', g.title, { withLocal: strategy === 'lazy' })) { simpleBuilt++; break; }
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
        e.value += th.fare / (path.length - 1) + (path.length === 2 ? ECON.routeBonusFraction * th.fare : 0);
        steps.set(key, e);
      }
      const options = [];
      for (const e of steps.values()) {
        if (!world.placements.has(e.to)) { options.push({ ...e, cost: 300 * s.inflation }); continue; }
        const q = game.quoteBuild(e.from, e.to);
        if (q.ok) options.push({ ...e, cost: q.cheap.total + localPrice() });
      }
      options.sort((a, b) => b.value / b.cost - a.value / a.cost);
      // A player follows the goal line: while it asks for more stations, build even where the waiting fares
      // alone would not repay it (the goal reward and the route bonus help).
      const g = s.goal;
      const wantsStations = g && (g.id === 'first-station' || g.id === 'four-stations' || g.id.startsWith('stations-')) && s.stations.size < g.target + 1;
      let built = false;
      for (const o of options.slice(0, 3)) {
        if (o.value < o.cost * (wantsStations ? 0.02 : 0.25)) break;
        if (await tryBuild(o.from, o.to)) { built = true; break; }
      }
      if (!built && wantsStations) {
        // Nobody is asking for anything buildable: take the cheapest signpost.
        const cands = [];
        for (const p of world.placements.values()) {
          if (p.state !== 'ghost' || graph[p.title]?.kind !== 'article') continue;
          for (const from of s.stations.keys()) {
            const q = game.quoteBuild(from, p.title);
            if (q.ok) cands.push({ from, to: p.title, cost: q.cheap.total });
          }
        }
        cands.sort((a, b) => a.cost - b.cost);
        for (const c of cands.slice(0, 2)) if (await tryBuild(c.from, c.to)) break;
      }
      // Join built destinations that the served network cannot reach yet.
      for (const th of s.thoughts) {
        if (th.state !== 'waiting' || !s.stations.has(th.to)) continue;
        if (router.stopsBetween(th.at, th.to) !== null) continue;
        if (!game.trackBetween(th.at, th.to) && game.quoteBuild(th.at, th.to).ok && (await tryBuild(th.at, th.to))) break;
      }
    }
    // 2. Every track needs a train to be any use.
    for (const t of s.tracks) {
      if (t.level === 0 && s.money > localPrice() + reserve()) game.upgradeTrack(t.id);
    }
    // 3. Upgrade busy tracks: queues beyond capacity, or heavy use (faster trains = fuller fares).
    for (const t of s.tracks) {
      if (t.level === 0) continue;
      const q = game.quoteUpgrade(t.id);
      if (!q.ok) continue;
      const queue = queueFor(t);
      maxQueue.set(t.id, Math.max(maxQueue.get(t.id) || 0, queue));
      const cap = TRAIN_TYPES[t.typeId].capacity;
      const use = usePerMin(t.id);
      const busy = queue >= cap || use >= (t.level === 1 ? 1.5 : 3);
      if (!busy) continue;
      // Freight carries a crowd; bullet takes a few, fast. Queues of more than a bullet can carry call for freight.
      const want = final !== 'auto' ? final : (maxQueue.get(t.id) || 0) >= 8 ? 'freight' : 'bullet';
      const pick = q.options.length === 1 ? q.options[0] : q.options.find((o) => o.typeId === want);
      if (pick && s.money > pick.cost + reserve() * 1.5) {
        if (game.upgradeTrack(t.id, pick.typeId).ok && q.options.length > 1) {
          stats.finals.push({ typeId: pick.typeId, minute: s.time / 60, queue, peakQueue: maxQueue.get(t.id) || 0, use });
        }
      }
    }
  }

  const header = ' min |    money | net/min | stations | delivered | lost | infl | upkeep/min |  fares/min | rep  | goals | levels 0/1/2/F/B';
  if (print) console.log(`seed ${seed}, strategy ${strategy}, world ${worldKind}\n${header}`);
  const levels = () => {
    const c = { 0: 0, 1: 0, 2: 0, freight: 0, bullet: 0 };
    for (const t of s.tracks) c[t.level === 3 ? t.typeId : t.level]++;
    return c;
  };
  const totalSeconds = minutes * 60;
  let nextReport = 120;
  while (s.phase === 'running' && s.time < totalSeconds) {
    game.update(0.25); // speed 4 -> 1 game second
    await flush(30);
    await decide();
    await flush(30);
    if (s.time <= 300) stats.minMoneyFirst5 = Math.min(stats.minMoneyFirst5, s.money);
    if (s.time >= 240) stats.minRepAfter4 = Math.min(stats.minRepAfter4, s.reputation);
    if (s.time >= nextReport - 1e-6 || s.phase !== 'running') {
      const lv = levels();
      const row = {
        min: s.time / 60, money: s.money, net: (s.money - lastMoney) / 2, stations: s.stations.size,
        delivered: s.delivered, lost: s.lost, infl: s.inflation, upkeep: upkeepRate, fares: fareEma,
        rep: s.reputation, levels: lv, phase: s.phase,
      };
      rows.push(row);
      lastMoney = s.money;
      nextReport += 120;
      if (print) {
        console.log(
          `${row.min.toFixed(1).padStart(4)} | ${row.money.toFixed(0).padStart(8)} | ${row.net.toFixed(0).padStart(7)} | ${String(row.stations).padStart(8)} | ${String(row.delivered).padStart(9)} | ${String(row.lost).padStart(4)} | ${row.infl.toFixed(2)} | ${row.upkeep.toFixed(0).padStart(10)} | ${row.fares.toFixed(0).padStart(10)} | ${row.rep.toFixed(2)} | ${String(stats.goals).padStart(5)} | ${lv[0]}/${lv[1]}/${lv[2]}/${lv.freight}/${lv.bullet}${row.phase === 'over' ? '  BANKRUPT' : ''}`,
        );
      }
    }
  }
  const result = { game, seed, strategy, endMinute: s.time / 60, phase: s.phase, score: s.score, delivered: s.delivered, lost: s.lost, stations: s.stations.size, trains: s.trains.length, levels: levels(), rows, stats };
  if (print) console.log(`end: ${result.phase} at ${result.endMinute.toFixed(1)} min, score ${result.score}, stations ${result.stations}, trains ${result.trains}, delivered ${result.delivered}, lost ${result.lost}`);
  if (print) {
    const f = stats.finals.filter((x) => x.typeId === 'freight').length;
    console.log(`goals ${stats.goals} (${stats.goalGold.toFixed(0)} gold), route bonus ${stats.bonusPassengers} passengers (${stats.bonusGold} gold), best streak ${stats.maxStreak}, wanted a built station ${stats.spawnedBuilt}/${stats.spawned}, lowest gold in first 5 min ${stats.minMoneyFirst5.toFixed(0)}, lowest reputation after 4 min ${stats.minRepAfter4.toFixed(2)}, final trains: freight ${f}, bullet ${stats.finals.length - f}`);
  }
  return result;
}

if (process.argv[1]?.endsWith('bot.mjs')) {
  await runBot();
}
