// The simulation: implements `Game` from src/types.js. Pure logic — no DOM, no three.js,
// no network except through the injected `wiki`, no Math.random, no Date.
import { ECON, TRAIN_TYPES, STARTING_TRAIN_TYPES, LINE_COLORS, WORLD } from '../config.js';
import { mulberry32 } from '../hex.js';
import { routeLength } from '../route.js';
import { createEmitter } from './events.js';
import { createRouter } from './routing.js';
import {
  inflationAt, spawnInterval, targetDepth, baseFare, patienceFor, liveFare,
  reputationFareMult, reputationCrowdMult, reputationAfterDelivery, reputationAfterLoss,
  stationBaseCost, incomePerMinFor, scoreFor, isSpecialKind,
} from './econ.js';

const STEP = 0.1;            // max game seconds per substep
const MAX_REAL_DT = 0.25;    // real seconds per update() beyond which time is dropped
const MAX_PENDING_SPAWNS = 3;
const ARTICLE_CACHE_MAX = 400;
const SPEEDS = [0, 1, 2, 4];
const LOST_TOAST_GAP = 8;     // game seconds between 'thought lost' toasts

const ok = () => ({ ok: true });
const fail = (reason) => ({ ok: false, reason });

export function createGame({ wiki, world, seed = 1, spawnThoughts = true }) {
  const rng = mulberry32(seed >>> 0);
  const { on, emit } = createEmitter();
  const toast = (text, tone = 'info') => emit('toast', { text, tone });

  /** @type {import('../types.js').GameState} */
  const state = {
    phase: 'idle',
    time: 0,
    speed: 1,
    money: ECON.startMoney,
    score: 0,
    inflation: 1,
    incomePerMin: 0,
    upkeepPerMin: 0,
    faresPerMin: 0,
    delivered: 0,
    lost: 0,
    reputation: ECON.reputationStart,
    uniqueLinks: 0,
    bankruptIn: null,
    unlockedTrainTypes: [...STARTING_TRAIN_TYPES],
    nextMilestone: null,
    stations: new Map(),
    stubs: new Map(),
    tracks: [],
    lines: [],
    trains: [],
    thoughts: [],
  };

  // ------------------------------------------------------------ internals
  const seenLinks = new Set();          // union of links of all built stations
  const linkSets = new Map();           // station title -> Set(article.links)
  const trackByPair = new Map();
  const tracksById = new Map();
  const linesById = new Map();
  const trainsById = new Map();
  const thoughtsById = new Map();
  const nav = new Map();                // train id -> { idx, next, dir, dwell }
  const baseFares = new Map();          // thought id -> base fare
  const pendingPairs = new Set();
  const pendingGhosts = new Set();
  const articleCache = new Map();
  const fareLog = [];                   // { time, fare } for the rolling window
  const router = createRouter(() => state.lines);
  let trackHexTotal = 0;
  let pendingSpawns = 0;
  let spawnTimer = 0;
  let lastLostToast = -Infinity;
  let nextTrackId = 1, nextLineId = 1, nextTrainId = 1, nextThoughtId = 1;

  const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const lenOf = (route) => route.length || routeLength(route) || 1;
  const toStub = (a) => ({ title: a.title, kind: a.kind, description: a.description || '', popularity: a.popularity });

  function trackBetween(a, b) {
    return trackByPair.get(pairKey(a, b)) || null;
  }

  function stationLinks(title) {
    return linkSets.get(title) || new Set();
  }

  async function loadArticle(title) {
    const st = state.stations.get(title);
    if (st) return st.article;
    if (articleCache.has(title)) return articleCache.get(title);
    const a = await wiki.getArticle(title);
    articleCache.set(title, a);
    if (articleCache.size > ARTICLE_CACHE_MAX) articleCache.delete(articleCache.keys().next().value);
    return a;
  }

  async function stubsFor(titles) {
    const out = new Map();
    const missing = [];
    for (const t of titles) {
      if (state.stubs.has(t)) out.set(t, state.stubs.get(t));
      else if (articleCache.has(t)) out.set(t, toStub(articleCache.get(t)));
      else missing.push(t);
    }
    if (missing.length) {
      const got = await wiki.getStubs(missing);
      for (const t of missing) if (got.has(t)) out.set(t, got.get(t));
    }
    return out;
  }

  function dedupeTiles(tiles) {
    const seen = new Set();
    const out = [];
    for (const t of tiles) {
      const k = `${t.q},${t.r}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }

  function refreshDerived() {
    let income = 0;
    for (const s of state.stations.values()) income += s.incomePerMin;
    state.incomePerMin = income;
    let trainUpkeep = 0;
    for (const tr of state.trains) trainUpkeep += TRAIN_TYPES[tr.typeId].upkeepPerMin;
    state.upkeepPerMin = (trackHexTotal * ECON.trackUpkeepPerHexPerMin + trainUpkeep) * state.inflation;
    while (fareLog.length && fareLog[0].time <= state.time - 60) fareLog.shift();
    let fares = 0;
    for (const f of fareLog) fares += f.fare;
    state.faresPerMin = fares;
    state.score = scoreFor(state.delivered, state.stations.size, state.uniqueLinks);
    state.nextMilestone = null;
    for (const m of ECON.milestones) {
      if (!state.unlockedTrainTypes.includes(m.unlock)) {
        state.nextMilestone = { uniqueLinks: m.uniqueLinks, unlock: m.unlock };
        break;
      }
    }
  }

  function checkMilestones() {
    for (const m of ECON.milestones) {
      if (state.uniqueLinks >= m.uniqueLinks && !state.unlockedTrainTypes.includes(m.unlock)) {
        state.unlockedTrainTypes.push(m.unlock);
        const name = TRAIN_TYPES[m.unlock]?.name || m.unlock;
        emit('milestone', { unlock: m.unlock, uniqueLinks: m.uniqueLinks });
        toast(`${m.uniqueLinks} unique links reached. ${name} trains are now available.`, 'good');
      }
    }
    refreshDerived();
  }

  function networkChanged() {
    router.invalidate();
  }

  /** Builds the Station record; updates unique-link accounting. */
  function addStation(title, article) {
    const pl = world.placements.get(title);
    const links = new Set(article.links || []);
    let unique = 0;
    for (const l of links) if (!seenLinks.has(l)) unique++;
    for (const l of links) seenLinks.add(l);
    linkSets.set(title, links);
    /** @type {import('../types.js').Station} */
    const station = {
      title,
      article,
      q: pl ? pl.q : 0,
      r: pl ? pl.r : 0,
      uniqueLinks: unique,
      incomePerMin: incomePerMinFor(article.kind, unique),
      waiting: [],
      builtAt: state.time,
    };
    state.stations.set(title, station);
    state.stubs.set(title, toStub(article));
    articleCache.delete(title);
    state.uniqueLinks += unique;
    return station;
  }

  function addTrack(route) {
    const track = { id: nextTrackId++, from: route.from, to: route.to, route };
    state.tracks.push(track);
    tracksById.set(track.id, track);
    trackByPair.set(pairKey(route.from, route.to), track);
    trackHexTotal += route.hexes.length;
    return track;
  }

  /** Ghost candidates for a freshly built article: the first N lead links that exist. */
  async function ghostCandidates(article) {
    const lead = (article.leadLinks || []).filter((t) => t !== article.title);
    let stubs;
    try {
      stubs = await stubsFor(lead);
    } catch {
      stubs = new Map();
    }
    const valid = lead.filter((t) => stubs.has(t)).slice(0, WORLD.ghostsPerStation);
    return { valid, stubs };
  }

  function placeGhostsFor(parent, titles, stubs) {
    for (const t of titles) if (!state.stubs.has(t)) state.stubs.set(t, stubs.get(t));
    if (!titles.length) return { placements: [], revealed: [] };
    const res = world.placeGhosts(parent, titles);
    return { placements: res.placements || [], revealed: res.revealed || [] };
  }

  // ------------------------------------------------------------ start
  async function start() {
    if (state.phase !== 'idle') return;
    state.phase = 'loading';
    try {
      const article = await wiki.randomStart();
      const title = article.title;
      const { revealed: r0 } = world.placeStart(title);
      const station = addStation(title, article);
      const { valid, stubs } = await ghostCandidates(article);
      const g = placeGhostsFor(title, valid, stubs);
      state.phase = 'running';
      state.inflation = inflationAt(0);
      spawnTimer = Math.max(0, spawnInterval(1) - 4); // first thought after a few seconds
      checkMilestones();
      emit('started', { station });
      emit('tilesRevealed', { tiles: dedupeTiles([...(r0 || []), ...g.revealed]) });
      emit('ghostsAdded', { placements: g.placements });
    } catch (err) {
      state.phase = 'idle';
      throw err;
    }
  }

  // ------------------------------------------------------------ building
  function quoteBuild(fromTitle, toTitle) {
    if (state.phase !== 'running') return fail('The game is not running.');
    const a = state.stations.get(fromTitle);
    if (!a) return fail('Track must start at a built station.');
    if (fromTitle === toTitle) return fail('A station cannot connect to itself.');
    if (!world.placements.has(toTitle)) return fail('That article is not on the map yet.');
    const b = state.stations.get(toTitle);
    const linked = stationLinks(fromTitle).has(toTitle) || (b && stationLinks(toTitle).has(fromTitle));
    if (!linked) return fail(`${fromTitle} does not link to ${toTitle}.`);
    if (trackBetween(fromTitle, toTitle)) return fail('Track already joins these stations.');
    if (pendingPairs.has(pairKey(fromTitle, toTitle)) || (!b && pendingGhosts.has(toTitle))) {
      return fail('That is already being built.');
    }
    let routes;
    try {
      routes = world.findRoutes(fromTitle, toTitle);
    } catch {
      return fail('No route can be found there.');
    }
    const infl = state.inflation;
    const stationCost = b ? 0 : Math.round(stationBaseCost(state.stubs.get(toTitle)) * infl);
    const mk = (style, route) => {
      const trackCost = Math.round(route.cost * infl);
      const total = trackCost + stationCost;
      return { style, route, trackCost, stationCost, total, affordable: total <= state.money };
    };
    return { ok: true, cheap: mk('cheap', routes.cheap), direct: mk('direct', routes.direct), same: !!routes.same };
  }

  async function build(fromTitle, toTitle, style) {
    if (style !== 'cheap' && style !== 'direct') return fail('Pick the cheap or the direct route.');
    const q = quoteBuild(fromTitle, toTitle);
    if (!q.ok) return fail(q.reason);
    const quote = q[style];
    if (!quote.affordable) return fail(`Not enough money: that costs ${quote.total}.`);
    const ghost = !state.stations.has(toTitle);
    const key = pairKey(fromTitle, toTitle);
    pendingPairs.add(key);
    if (ghost) pendingGhosts.add(toTitle);
    state.money -= quote.total; // charged once, up front; refunded if the article cannot load
    try {
      let article = null;
      let cands = null;
      if (ghost) {
        try {
          article = await loadArticle(toTitle);
        } catch {
          if (state.phase === 'running') state.money += quote.total;
          return fail(`Could not load ${toTitle}. Nothing was charged.`);
        }
        cands = await ghostCandidates({ ...article, title: toTitle });
      }
      if (state.phase !== 'running') return fail('The game is over.');

      const revealed = [];
      if (ghost) revealed.push(...(world.setBuilt(toTitle).revealed || []));
      revealed.push(...(world.commitRoute(quote.route).revealed || []));
      const track = addTrack(quote.route);
      let station = null;
      let placements = [];
      if (ghost) {
        station = addStation(toTitle, article);
        const g = placeGhostsFor(toTitle, cands.valid, cands.stubs);
        revealed.push(...g.revealed);
        placements = g.placements;
      }
      networkChanged();
      refreshDerived();
      emit('tilesRevealed', { tiles: dedupeTiles(revealed) });
      if (placements.length) emit('ghostsAdded', { placements });
      emit('trackBuilt', { track });
      if (station) {
        emit('stationBuilt', { station, track });
        toast(`${toTitle} station is open (${station.uniqueLinks} new links).`, 'good');
        checkMilestones();
      } else {
        toast(`Track laid between ${fromTitle} and ${toTitle}.`, 'good');
      }
      return ok();
    } finally {
      pendingPairs.delete(key);
      if (ghost) pendingGhosts.delete(toTitle);
    }
  }

  async function survey(fromTitle, linkTitle) {
    if (state.phase !== 'running') return fail('The game is not running.');
    if (!state.stations.has(fromTitle)) return fail('Survey from a built station.');
    if (!stationLinks(fromTitle).has(linkTitle)) return fail(`${fromTitle} does not link to ${linkTitle}.`);
    if (world.placements.has(linkTitle)) return ok();
    let stubs;
    try {
      stubs = await stubsFor([linkTitle]);
    } catch {
      return fail(`Could not look up ${linkTitle}.`);
    }
    if (!stubs.has(linkTitle)) return fail(`${linkTitle} is not an article.`);
    if (state.phase !== 'running') return fail('The game is over.');
    if (world.placements.has(linkTitle)) return ok();
    const g = placeGhostsFor(fromTitle, [linkTitle], stubs);
    if (g.revealed.length) emit('tilesRevealed', { tiles: dedupeTiles(g.revealed) });
    if (g.placements.length) emit('ghostsAdded', { placements: g.placements });
    return ok();
  }

  // ------------------------------------------------------------ lines and trains
  function validateStops(stations) {
    if (!Array.isArray(stations) || stations.length < 2) return 'A line needs at least two stations.';
    for (const s of stations) if (!state.stations.has(s)) return `${s} is not a built station.`;
    for (let i = 0; i + 1 < stations.length; i++) {
      if (stations[i] === stations[i + 1]) return 'A line cannot stop at the same station twice in a row.';
      if (!trackBetween(stations[i], stations[i + 1])) {
        return `No track joins ${stations[i]} and ${stations[i + 1]}.`;
      }
    }
    return null;
  }

  function createLine(stations) {
    if (state.phase !== 'running') return fail('The game is not running.');
    const bad = validateStops(stations);
    if (bad) return fail(bad);
    const id = nextLineId++;
    const line = {
      id,
      name: `Line ${id}`,
      color: LINE_COLORS[(id - 1) % LINE_COLORS.length],
      stations: [...stations],
      trainIds: [],
    };
    state.lines.push(line);
    linesById.set(id, line);
    networkChanged();
    emit('linesChanged', {});
    return { ok: true, line };
  }

  /** Puts a train's riders off at the last station it stopped at. */
  function unload(train) {
    const st = state.stations.get(train.atStation);
    for (const id of train.passengers) {
      const th = thoughtsById.get(id);
      if (!th) continue;
      th.state = 'waiting';
      th.trainId = null;
      th.at = train.atStation;
      st.waiting.push(id);
    }
    train.passengers = [];
  }

  function setLineStations(lineId, stations) {
    if (state.phase !== 'running') return fail('The game is not running.');
    const line = linesById.get(lineId);
    if (!line) return fail('No such line.');
    const bad = validateStops(stations);
    if (bad) return fail(bad);
    line.stations = [...stations];
    networkChanged();
    for (const id of line.trainIds) {
      const tr = trainsById.get(id);
      unload(tr);
      placeAtStart(tr, line);
    }
    emit('linesChanged', {});
    emit('trainsChanged', {});
    return ok();
  }

  function removeTrain(tr) {
    unload(tr);
    const line = linesById.get(tr.lineId);
    if (line) line.trainIds = line.trainIds.filter((x) => x !== tr.id);
    state.trains.splice(state.trains.indexOf(tr), 1);
    trainsById.delete(tr.id);
    nav.delete(tr.id);
    state.money += ECON.sellRefund * TRAIN_TYPES[tr.typeId].cost;
  }

  function deleteLine(lineId) {
    if (state.phase !== 'running') return fail('The game is not running.');
    const line = linesById.get(lineId);
    if (!line) return fail('No such line.');
    for (const id of [...line.trainIds]) removeTrain(trainsById.get(id));
    state.lines.splice(state.lines.indexOf(line), 1);
    linesById.delete(lineId);
    networkChanged();
    refreshDerived();
    emit('linesChanged', {});
    emit('trainsChanged', {});
    return ok();
  }

  function buyTrain(typeId, lineId) {
    if (state.phase !== 'running') return fail('The game is not running.');
    const type = TRAIN_TYPES[typeId];
    if (!type) return fail('No such train type.');
    if (!state.unlockedTrainTypes.includes(typeId)) return fail(`${type.name} trains are not unlocked yet.`);
    const line = linesById.get(lineId);
    if (!line) return fail('No such line.');
    const price = Math.round(type.cost * state.inflation);
    if (price > state.money) return fail(`Not enough money: a ${type.name} train costs ${price}.`);
    state.money -= price;
    const train = {
      id: nextTrainId++,
      typeId,
      lineId,
      state: 'dwelling',
      trackId: 0,
      t: 0,
      forward: true,
      atStation: line.stations[0],
      passengers: [],
    };
    state.trains.push(train);
    trainsById.set(train.id, train);
    line.trainIds.push(train.id);
    placeAtStart(train, line);
    refreshDerived();
    emit('trainsChanged', {});
    return { ok: true, train };
  }

  function sellTrain(trainId) {
    if (state.phase !== 'running') return fail('The game is not running.');
    const tr = trainsById.get(trainId);
    if (!tr) return fail('No such train.');
    removeTrain(tr);
    refreshDerived();
    emit('trainsChanged', {});
    return ok();
  }

  // ------------------------------------------------------------ train motion
  function placeAtStart(train, line) {
    const n = { idx: 0, next: 1, dir: 1, dwell: ECON.dwellSeconds };
    nav.set(train.id, n);
    arriveAt(train, line, n, 0);
  }

  /** Train has stopped at line.stations[n.idx]: point it at the next stop and swap riders. */
  function arriveAt(train, line, n, overshoot) {
    const stops = line.stations;
    let j = n.idx + n.dir;
    if (j < 0 || j >= stops.length) {
      n.dir = -n.dir;
      j = n.idx + n.dir;
    }
    n.next = j;
    const here = stops[n.idx];
    const nextStop = stops[j];
    const track = trackBetween(here, nextStop);
    train.state = 'dwelling';
    train.atStation = here;
    train.trackId = track.id;
    train.forward = track.route.from === here;
    train.t = train.forward ? 0 : 1;
    n.dwell = ECON.dwellSeconds - overshoot;
    exchange(train, here, nextStop);
  }

  function exchange(train, here, nextStop) {
    const station = state.stations.get(here);
    for (const id of [...train.passengers]) {
      const th = thoughtsById.get(id);
      if (!th) continue;
      if (th.to === here) {
        deliver(th, train, here);
      } else if (!router.isGoodStep(th.to, here, nextStop)) {
        train.passengers.splice(train.passengers.indexOf(id), 1);
        th.state = 'waiting';
        th.trainId = null;
        th.at = here;
        station.waiting.push(id);
      }
    }
    board(train, station, nextStop);
  }

  function board(train, station, nextStop) {
    const cap = TRAIN_TYPES[train.typeId].capacity;
    if (train.passengers.length >= cap || !station.waiting.length) return;
    for (const id of [...station.waiting]) {
      if (train.passengers.length >= cap) break;
      const th = thoughtsById.get(id);
      if (!th || !router.isGoodStep(th.to, station.title, nextStop)) continue;
      station.waiting.splice(station.waiting.indexOf(id), 1);
      th.state = 'riding';
      th.at = null;
      th.trainId = train.id;
      train.passengers.push(id);
      emit('thoughtBoarded', { thought: th, train });
    }
  }

  function moveTrains(h) {
    for (const train of [...state.trains]) {
      const n = nav.get(train.id);
      const line = linesById.get(train.lineId);
      if (!n || !line) continue;
      let rem = h;
      if (train.state === 'dwelling') {
        n.dwell -= rem;
        if (n.dwell > 0) {
          board(train, state.stations.get(train.atStation), line.stations[n.next]);
          continue;
        }
        rem = -n.dwell;
        train.state = 'moving';
      }
      const track = tracksById.get(train.trackId);
      const L = lenOf(track.route);
      const speed = TRAIN_TYPES[train.typeId].speed;
      const left = (train.forward ? 1 - train.t : train.t) * L;
      const need = left / speed;
      if (rem < need) {
        train.t += (train.forward ? 1 : -1) * (speed * rem) / L;
      } else {
        train.t = train.forward ? 1 : 0;
        n.idx = n.next;
        arriveAt(train, line, n, rem - need);
      }
    }
  }

  // ------------------------------------------------------------ thoughts
  function removeThought(th) {
    const i = state.thoughts.indexOf(th);
    if (i >= 0) state.thoughts.splice(i, 1);
    thoughtsById.delete(th.id);
    baseFares.delete(th.id);
  }

  function deliver(th, train, here) {
    train.passengers.splice(train.passengers.indexOf(th.id), 1);
    const fare = th.fare;
    state.money += fare;
    state.delivered++;
    state.reputation = reputationAfterDelivery(state.reputation, th.patienceMax > 0 ? th.patience / th.patienceMax : 0);
    fareLog.push({ time: state.time, fare });
    th.state = 'delivered';
    th.trainId = null;
    th.at = null;
    removeThought(th);
    emit('thoughtDelivered', { thought: th, fare, station: here });
  }

  function loseThought(th) {
    const st = state.stations.get(th.at);
    if (st) {
      const i = st.waiting.indexOf(th.id);
      if (i >= 0) st.waiting.splice(i, 1);
    }
    const at = th.at;
    th.state = 'lost';
    th.at = null;
    removeThought(th);
    state.lost++;
    state.reputation = reputationAfterLoss(state.reputation);
    emit('thoughtLost', { thought: th });
    // Throttled so a collapsing network does not bury the player in toasts.
    if (state.time - lastLostToast >= LOST_TOAST_GAP) {
      lastLostToast = state.time;
      toast(`A thought waiting at ${at} for ${th.to} gave up.`, 'bad');
    }
  }

  function tickThoughts(h) {
    for (const th of [...state.thoughts]) {
      th.patience = Math.max(0, th.patience - h);
      th.fare = liveFare(baseFares.get(th.id), th.patience, th.patienceMax) * reputationFareMult(state.reputation);
      if (th.state === 'waiting' && th.patience <= 0) loseThought(th);
    }
  }

  const liveDuplicate = (from, to) => state.thoughts.some((t) => t.from === from && t.to === to);

  /** Random walk along lead links; resolves to {title, stub} or null. Never touches the shared rng. */
  async function pickDestination(origin, hops, r) {
    let cur = state.stations.get(origin).article;
    const visited = new Set([origin]);
    for (let step = 1; step < hops; step++) {
      const opts = (cur.leadLinks || []).filter((t) => !visited.has(t));
      if (!opts.length) return null;
      const next = opts[Math.floor(r() * opts.length)];
      visited.add(next);
      cur = await loadArticle(next);
    }
    const opts = (cur.leadLinks || []).filter((t) => !visited.has(t) && t !== origin && !liveDuplicate(origin, t));
    if (!opts.length) return null;
    const stubs = await stubsFor(opts);
    const good = opts.filter((t) => stubs.has(t) && !isSpecialKind(stubs.get(t).kind));
    const unbuilt = good.filter((t) => !state.stations.has(t));
    const built = good.filter((t) => state.stations.has(t));
    const preferUnbuilt = r() < 0.7;
    const pool = preferUnbuilt ? (unbuilt.length ? unbuilt : built) : (built.length ? built : unbuilt);
    if (!pool.length) return null;
    const title = pool[Math.floor(r() * pool.length)];
    return { title, stub: stubs.get(title) };
  }

  function trySpawn() {
    if (pendingSpawns >= MAX_PENDING_SPAWNS) return;
    const open = [...state.stations.values()].filter((s) => s.waiting.length < ECON.maxWaitingPerStation);
    if (!open.length) return;
    const origin = open[Math.floor(rng() * open.length)].title;
    const depth = targetDepth(state.delivered);
    const lo = Math.max(1, depth - 1);
    const hops = lo + Math.floor(rng() * (depth - lo + 1));
    const r = mulberry32(Math.floor(rng() * 4294967296));
    pendingSpawns++;
    pickDestination(origin, hops, r)
      .then((dest) => {
        if (!dest || state.phase !== 'running') return;
        const st = state.stations.get(origin);
        if (!st || st.waiting.length >= ECON.maxWaitingPerStation) return;
        if (dest.title === origin || liveDuplicate(origin, dest.title)) return;
        addThought(origin, dest.title, hops, (dest.stub && dest.stub.description) || '');
      })
      .catch(() => {})
      .finally(() => {
        pendingSpawns--;
      });
  }

  function addThought(origin, to, hops, toDescription = '') {
    const st = state.stations.get(origin);
    const base = baseFare(hops);
    const patienceMax = patienceFor(hops);
    const th = {
      id: nextThoughtId++,
      from: origin,
      to,
      toDescription,
      hops,
      fare: base * reputationFareMult(state.reputation),
      patience: patienceMax,
      patienceMax,
      state: 'waiting',
      at: origin,
      trainId: null,
    };
    baseFares.set(th.id, base);
    thoughtsById.set(th.id, th);
    state.thoughts.push(th);
    st.waiting.push(th.id);
    emit('thoughtSpawned', { thought: th });
    return th;
  }

  function tickSpawns(h) {
    if (!spawnThoughts) return;
    spawnTimer += h;
    const interval = spawnInterval(state.stations.size) / reputationCrowdMult(state.reputation);
    if (spawnTimer >= interval) {
      spawnTimer -= interval;
      trySpawn();
    }
  }

  // ------------------------------------------------------------ money
  function tickMoney(h) {
    let income = 0;
    for (const s of state.stations.values()) income += s.incomePerMin;
    let trainUpkeep = 0;
    for (const tr of state.trains) trainUpkeep += TRAIN_TYPES[tr.typeId].upkeepPerMin;
    const upkeep = (trackHexTotal * ECON.trackUpkeepPerHexPerMin + trainUpkeep) * state.inflation;
    state.money += ((income - upkeep) * h) / 60;
  }

  function tickBankruptcy(h) {
    if (state.money < 0) {
      if (state.bankruptIn === null) {
        state.bankruptIn = ECON.bankruptcyGraceSeconds;
        toast(`You are in debt. Bankrupt in ${ECON.bankruptcyGraceSeconds} seconds unless money recovers.`, 'bad');
      } else {
        state.bankruptIn = Math.max(0, state.bankruptIn - h);
        if (state.bankruptIn <= 0) gameOver();
      }
    } else if (state.bankruptIn !== null) {
      state.bankruptIn = null;
      toast('Back out of debt.', 'good');
    }
  }

  function gameOver() {
    state.phase = 'over';
    refreshDerived();
    emit('gameOver', {
      score: state.score,
      time: state.time,
      delivered: state.delivered,
      stations: state.stations.size,
    });
    toast(`Bankrupt. The line closes with a score of ${state.score}.`, 'bad');
  }

  // ------------------------------------------------------------ loop
  function step(h) {
    state.time += h;
    state.inflation = inflationAt(state.time);
    tickMoney(h);
    moveTrains(h);
    tickThoughts(h);
    tickSpawns(h);
    tickBankruptcy(h);
  }

  function update(dt) {
    if (state.phase !== 'running') return;
    if (!(dt > 0)) return;
    let game = Math.min(dt, MAX_REAL_DT) * state.speed;
    while (game > 1e-9 && state.phase === 'running') {
      const h = Math.min(game, STEP);
      step(h);
      game -= h;
    }
    refreshDerived();
  }

  function setSpeed(speed) {
    if (SPEEDS.includes(speed)) state.speed = speed;
  }

  refreshDerived();

  return {
    state,
    on,
    start,
    update,
    setSpeed,
    quoteBuild,
    build,
    survey,
    createLine,
    setLineStations,
    deleteLine,
    buyTrain,
    sellTrain,
    trackBetween,
    // Not part of the contract: hooks for tests and the balance bot.
    _debug: { addThought, router, nav },
  };
}
