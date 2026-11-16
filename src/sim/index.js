// The simulation: implements `Game` from src/types.js. Pure logic — no DOM, no three.js,
// no network except through the injected `wiki`, no Math.random, no Date.
import { ECON, TRAIN_TYPES, TRACK_UPGRADES, WORLD } from '../config.js';
import { mulberry32 } from '../hex.js';
import { routeLength } from '../route.js';
import { createEmitter } from './events.js';
import { createRouter } from './routing.js';
import {
  inflationAt, spawnInterval, targetDepth, baseFare, patienceFor, liveFare,
  reputationFareMult, reputationCrowdMult, reputationAfterDelivery, reputationAfterLoss,
  stationBaseCost, incomePerMinFor, scoreFor, isSpecialKind, streakFareMult, routeBonusFor,
} from './econ.js';
import { makeGoal } from './goals.js';
import { longestLine } from './line.js';

const STEP = 0.1;            // max game seconds per substep
const MAX_REAL_DT = 0.25;    // real seconds per update() beyond which time is dropped
const MAX_PENDING_SPAWNS = 3;
const ARTICLE_CACHE_MAX = 400;
const SPEEDS = [0, 1, 2, 4];
const LOST_TOAST_GAP = 8;     // game seconds between 'thought lost' toasts
const MAX_SAME_BUILT_PAIR = 3; // live passengers with the same origin and the same built destination
const MAX_ANCHOR_TRIES = 4;
const UNBUILT_FARTHER_ODDS = 0.3; // chance of going one more link past the built network, per step, as depth allows
const BUILT_FARTHER_ODDS = 0.6;   // see pickBuilt
const UNLINKED_BUILT_HOPS = 2;    // price of a built destination no track reaches yet

const ok = () => ({ ok: true });
const fail = (reason) => ({ ok: false, reason });

// autoTrain: every new track comes with a Local train already running (the game as played).
// Tests that need a bare track pass autoTrain: false.
// tickets: the game hands out up to ECON.maxTickets routes to find, and ordinary passengers only
// ride between stations that exist. Tests of the older passenger rules pass tickets: false.
// surprises: unannounced gold (a find at a new station, a tip on a ticket). Off with tickets: false;
// tests that count gold exactly pass surprises: false.
export function createGame({ wiki, world, seed = 1, spawnThoughts = true, autoTrain = true, tickets = true, surprises = tickets }) {
  const ticketsOn = tickets && spawnThoughts;
  const clockWaits = tickets; // the clock starts with the first build (the game as played)
  const overheadOn = tickets;  // the company's own running cost (the game as played)
  const rng = mulberry32(seed >>> 0);
  const luck = mulberry32((seed ^ 0x9e3779b9) >>> 0); // its own stream, so surprises never shift anything else
  let startTitle = '';
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
    payday: {
      period: ECON.paydaySeconds,
      in: ECON.paydaySeconds,
      income: 0,
      fares: 0,
      upkeep: 0,
      pending: 0,
      forecast: 0,
      last: null,
    },
    goal: null,
    streak: 0,
    delivered: 0,
    lost: 0,
    reputation: ECON.reputationStart,
    uniqueLinks: 0,
    bankruptIn: null,
    stations: new Map(),
    stubs: new Map(),
    tracks: [],
    trains: [],
    thoughts: [],
    tickets: [],
    clockRunning: !tickets,
  };

  // ------------------------------------------------------------ internals
  const seenLinks = new Set();          // union of links of all built stations
  const linkSets = new Map();           // station title -> Set(article.links)
  const trackByPair = new Map();
  const tracksById = new Map();
  const trainsById = new Map();
  const thoughtsById = new Map();
  const nav = new Map();                // train id -> { dwell }
  const baseFares = new Map();          // thought id -> base fare
  const pendingPairs = new Set();
  const pendingGhosts = new Set();
  const articleCache = new Map();
  const router = createRouter(function* servedEdges() {
    for (const t of state.tracks) if (t.level >= 1) yield [t.from, t.to];
  });
  let paydayElapsed = 0;                // game seconds into the current pay period
  let trackHexTotal = 0;
  let pendingSpawns = 0;
  let spawnTimer = 0;
  let lastLostToast = -Infinity;
  let nextTrackId = 1, nextTrainId = 1, nextThoughtId = 1;
  let goalIndex = 0;                    // goals completed so far
  let goalMeasure = () => 0;

  const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const lenOf = (route) => route.length || routeLength(route) || 1;
  const toStub = (a) => ({ title: a.title, kind: a.kind, description: a.description || '', popularity: a.popularity });

  function trackBetween(a, b) {
    return trackByPair.get(pairKey(a, b)) || null;
  }

  function stationLinks(title) {
    return linkSets.get(title) || new Set();
  }

  /** Makes built stations a and/or b link to each other, so track may join them (sandbox use). */
  function link(a, b) {
    if (a === b) return;
    linkSets.get(a)?.add(b);
    linkSets.get(b)?.add(a);
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

  function incomeRate() {
    let income = 0;
    for (const st of state.stations.values()) income += st.incomePerMin;
    return income;
  }

  function upkeepRate() {
    let trainUpkeep = 0;
    for (const tr of state.trains) trainUpkeep += TRAIN_TYPES[tr.typeId].upkeepPerMin;
    // The company itself costs gold to run once the clock has started, however small the network:
    // a few stations cannot sit still for ever, only tickets keep you ahead.
    const overhead = overheadOn && state.tracks.length ? ECON.overheadPerMin : 0;
    return (trackHexTotal * ECON.trackUpkeepPerHexPerMin + trainUpkeep + overhead) * state.inflation;
  }

  // ------------------------------------------------------------ goals
  let ticketsDone = 0;

  function metrics() {
    let maxLevel = 0;
    for (const t of state.tracks) if (t.level > maxLevel) maxLevel = t.level;
    return { stations: state.stations.size, delivered: state.delivered, maxLevel, tickets: ticketsDone };
  }

  function nextGoal() {
    const made = makeGoal(goalIndex, metrics(), state.inflation, autoTrain);
    state.goal = made.goal;
    goalMeasure = made.measure;
    syncGoal();
  }

  function syncGoal() {
    const g = state.goal;
    if (!g) return false;
    g.progress = Math.max(0, Math.min(g.target, goalMeasure(metrics())));
    return g.progress >= g.target;
  }

  /** Pays every goal that is met, one after another (a goal already met when it comes up completes at once). */
  function checkGoal() {
    for (let guard = 0; guard < 50 && state.phase === 'running' && syncGoal(); guard++) {
      const done = state.goal;
      state.money += done.reward; // paid the moment it is met, exactly once
      goalIndex++;
      nextGoal();
      emit('goalDone', { goal: done, reward: done.reward, next: state.goal });
    }
  }

  function refreshDerived() {
    syncGoal();
    const p = state.payday;
    p.period = ECON.paydaySeconds;
    p.in = Math.max(0, ECON.paydaySeconds - paydayElapsed);
    p.pending = p.income + p.fares - p.upkeep;
    p.forecast = p.pending + ((incomeRate() - upkeepRate()) * p.in) / 60;
    state.score = scoreFor(state.delivered, state.stations.size, state.uniqueLinks, ticketsDone);
  }

  function networkChanged() {
    router.invalidate();
    checkTickets();
  }

  /** Builds the Station record; updates unique-link accounting. */
  function addStation(title, article) {
    // Tell the map which articles this station links to, so related stations can sit near each other.
    if (typeof world.noteLinks === 'function') world.noteLinks(title, article.links || []);
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
    const track = { id: nextTrackId++, from: route.from, to: route.to, route, level: 0, typeId: null, trainId: null };
    state.tracks.push(track);
    tracksById.set(track.id, track);
    trackByPair.set(pairKey(route.from, route.to), track);
    // Rails that were already there (shared stretches) cost nothing more to keep up.
    trackHexTotal += route.hexes.filter((h) => !h.shared).length;
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
      startTitle = title;
      const { revealed: r0 } = world.placeStart(title);
      const station = addStation(title, article);
      const { valid, stubs } = await ghostCandidates(article);
      const g = placeGhostsFor(title, valid, stubs);
      state.phase = 'running';
      state.inflation = inflationAt(0);
      spawnTimer = Math.max(0, spawnInterval(1) - 4); // first thought after a few seconds
      refreshDerived();
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

  async function build(fromTitle, toTitle, style = 'cheap') {
    if (style !== 'cheap' && style !== 'direct') return fail('Pick the cheap or the direct route.');
    const q = quoteBuild(fromTitle, toTitle);
    if (!q.ok) return fail(q.reason);
    const quote = q[style];
    if (!quote.affordable) return fail(`Not enough gold: that costs ${quote.total} gold.`);
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

      // The article took a moment to load, and an unbuilt spot may have moved meanwhile (another
      // build finishing can pull it towards its other linkers). Lay the track to where the
      // station really is now, never to where it was when priced: same price, fresh route.
      // The article took a moment to load. Meanwhile an unbuilt spot may have moved, or another
      // build may have laid track across this route. Find the way again now, so the track goes to
      // where the station really is and never lies on top of track that was not there when priced.
      // The price already charged stands.
      let route;
      try {
        const fresh = world.findRoutes(fromTitle, toTitle);
        route = fresh[style] || fresh.cheap;
      } catch {
        state.money += quote.total;
        return fail(`Could not find a way to ${toTitle}. Nothing was charged.`);
      }

      const revealed = [];
      if (ghost) revealed.push(...(world.setBuilt(toTitle).revealed || []));
      revealed.push(...(world.commitRoute(route).revealed || []));
      const track = addTrack(route);
      const startTrain = autoTrain;
      let station = null;
      let placements = [];
      let bonus = null;
      if (ghost) {
        station = addStation(toTitle, article);
        bonus = payRouteBonus(toTitle);
        const g = placeGhostsFor(toTitle, cands.valid, cands.stubs);
        revealed.push(...g.revealed);
        placements = g.placements;
      }
      networkChanged();
      refreshDerived();
      emit('tilesRevealed', { tiles: dedupeTiles(revealed) });
      if (placements.length) emit('ghostsAdded', { placements });
      emit('trackBuilt', { track });
      if (station) emit('stationBuilt', { station, track });
      // A new track comes with its train: it starts running at once, at no extra charge.
      if (startTrain) doUpgrade(track.id, undefined, true);
      if (bonus) emit('routeBonus', bonus);
      if (station) stationSurprise(toTitle);
      checkGoal();
      return ok();
    } finally {
      pendingPairs.delete(key);
      if (ghost) pendingGhosts.delete(toTitle);
    }
  }

  /** Passengers waiting for a station that has just been built each pay part of their fare and get their patience back. */
  function payRouteBonus(title) {
    let count = 0;
    let sum = 0;
    for (const th of state.thoughts) {
      if (th.state !== 'waiting' || th.to !== title) continue;
      sum += routeBonusFor(th.fare);
      count++;
      th.patience = th.patienceMax;
      th.fare = liveFare(baseFares.get(th.id), th.patience, th.patienceMax) * reputationFareMult(state.reputation);
    }
    if (!count) return null;
    const amount = Math.round(sum);
    state.money += amount;
    return { station: title, count, amount };
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

  // ------------------------------------------------------------ track upgrades and trains
  function quoteUpgrade(trackId) {
    if (state.phase !== 'running') return fail('The game is not running.');
    const track = tracksById.get(trackId);
    if (!track) return fail('No such track.');
    const next = TRACK_UPGRADES[track.level] || [];
    if (!next.length) return fail('This track is fully upgraded.');
    const options = next.map((typeId) => {
      const type = TRAIN_TYPES[typeId];
      const cost = Math.round(type.cost * state.inflation);
      return { typeId, name: type.name, blurb: type.blurb, cost, affordable: cost <= state.money };
    });
    return { ok: true, options };
  }

  const upgradeTrack = (trackId, typeId) => doUpgrade(trackId, typeId, false);

  /** free: the Local that comes with a newly built track. */
  function doUpgrade(trackId, typeId, free) {
    const q = quoteUpgrade(trackId);
    if (!q.ok) return fail(q.reason);
    let option;
    if (typeId === undefined || typeId === null) {
      if (q.options.length !== 1) return fail(`Choose ${q.options.map((o) => o.name).join(' or ')}.`);
      option = q.options[0];
    } else {
      option = q.options.find((o) => o.typeId === typeId);
      if (!option) return fail(`This track cannot take a ${TRAIN_TYPES[typeId]?.name || typeId} train now.`);
    }
    if (!free && !option.affordable) return fail(`Not enough gold: that costs ${option.cost} gold.`);
    if (!free) state.money -= option.cost;
    const track = tracksById.get(trackId);
    const old = track.trainId !== null ? trainsById.get(track.trainId) : null;
    const train = {
      id: nextTrainId++,
      typeId: option.typeId,
      trackId,
      state: old ? old.state : 'dwelling',
      t: old ? old.t : 0,
      forward: old ? old.forward : true,
      atStation: old ? old.atStation : track.from,
      passengers: [],
    };
    const n = { dwell: old ? nav.get(old.id).dwell : ECON.dwellSeconds };
    if (old) {
      // The new train takes over in place; riders stay aboard up to its capacity.
      const cap = TRAIN_TYPES[option.typeId].capacity;
      const keep = old.passengers.slice(0, cap);
      old.passengers = old.passengers.slice(cap);
      unload(old);
      for (const id of keep) {
        thoughtsById.get(id).trainId = train.id;
        train.passengers.push(id);
      }
      state.trains.splice(state.trains.indexOf(old), 1, train);
      trainsById.delete(old.id);
      nav.delete(old.id);
    } else {
      state.trains.push(train);
    }
    trainsById.set(train.id, train);
    nav.set(train.id, n);
    track.level += 1;
    track.typeId = option.typeId;
    track.trainId = train.id;
    networkChanged();
    if (!old) exchange(train, train.atStation); // a brand-new train picks up at once
    refreshDerived();
    emit('trackUpgraded', { track, train });
    emit('trainsChanged', {});
    checkGoal();
    return ok();
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

  const otherEnd = (track, here) => (track.from === here ? track.to : track.from);

  /** Train has stopped at `here` (one end of its track): deliver, let off, take on. */
  function arriveAt(train, track, here, overshoot) {
    train.state = 'dwelling';
    train.atStation = here;
    train.forward = track.route.from === here;
    train.t = train.forward ? 0 : 1;
    nav.get(train.id).dwell = ECON.dwellSeconds - overshoot;
    exchange(train, here);
  }

  function exchange(train, here) {
    const track = tracksById.get(train.trackId);
    const nextStop = otherEnd(track, here);
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
      const track = tracksById.get(train.trackId);
      let rem = h;
      if (train.state === 'dwelling') {
        n.dwell -= rem;
        if (n.dwell > 0) {
          board(train, state.stations.get(train.atStation), otherEnd(track, train.atStation));
          continue;
        }
        rem = -n.dwell;
        train.state = 'moving';
      }
      const L = lenOf(track.route);
      const speed = TRAIN_TYPES[train.typeId].speed;
      const left = (train.forward ? 1 - train.t : train.t) * L;
      const need = left / speed;
      if (rem < need) {
        train.t += (train.forward ? 1 : -1) * (speed * rem) / L;
      } else {
        const here = train.forward ? track.route.to : track.route.from;
        arriveAt(train, track, here, rem - need);
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
    const fare = th.fare * streakFareMult(state.streak); // a run of deliveries pays more
    state.payday.fares += fare; // banked for the next payday
    state.delivered++;
    state.streak++;
    state.reputation = reputationAfterDelivery(state.reputation, th.patienceMax > 0 ? th.patience / th.patienceMax : 0);
    th.state = 'delivered';
    th.trainId = null;
    th.at = null;
    removeThought(th);
    emit('thoughtDelivered', { thought: th, fare, station: here, streak: state.streak });
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
    state.streak = 0;
    state.reputation = reputationAfterLoss(state.reputation);
    emit('thoughtLost', { thought: th });
    // Throttled so a collapsing network does not bury the player in toasts.
    if (state.time - lastLostToast >= LOST_TOAST_GAP) {
      lastLostToast = state.time;
      toast(`A passenger at ${at} gave up waiting for ${th.to}.`, 'bad');
    }
  }

  function tickThoughts(h) {
    for (const th of [...state.thoughts]) {
      th.patience = Math.max(0, th.patience - h);
      th.fare = liveFare(baseFares.get(th.id), th.patience, th.patienceMax) * reputationFareMult(state.reputation);
      if (th.state === 'waiting' && th.patience <= 0) loseThought(th);
    }
  }

  const liveCount = (from, to) => state.thoughts.reduce((n, t) => n + (t.from === from && t.to === to ? 1 : 0), 0);
  const liveDuplicate = (from, to) => liveCount(from, to) > 0;

  /** Stops from `origin` to every station reachable over existing track, bare or served alike. */
  function trackDistances(origin) {
    const adj = new Map();
    const link = (a, b) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    };
    for (const t of state.tracks) {
      link(t.from, t.to);
      link(t.to, t.from);
    }
    const dist = new Map([[origin, 0]]);
    const queue = [origin];
    for (let i = 0; i < queue.length; i++) {
      for (const nb of adj.get(queue[i]) || []) {
        if (!dist.has(nb)) {
          dist.set(nb, dist.get(queue[i]) + 1);
          queue.push(nb);
        }
      }
    }
    return dist;
  }

  /** A station that already exists, preferring one the passenger could reach over existing track. */
  function pickBuilt(origin, r) {
    const dist = trackDistances(origin);
    const all = [...state.stations.values()].filter(
      (s) => s.title !== origin && !isSpecialKind(s.article.kind) && liveCount(origin, s.title) < MAX_SAME_BUILT_PAIR,
    );
    if (!all.length) return null;
    const near = all.filter((s) => dist.has(s.title) && dist.get(s.title) <= ECON.maxDepth);
    const linked = near.length ? near : all.filter((s) => dist.has(s.title));
    const pool = linked.length ? linked : all;
    // Nearer stations are likelier: each extra stop makes a destination BUILT_FARTHER_ODDS as likely.
    const weight = (st) => Math.pow(BUILT_FARTHER_ODDS, dist.has(st.title) ? dist.get(st.title) - 1 : UNLINKED_BUILT_HOPS - 1);
    let x = r() * pool.reduce((n, st) => n + weight(st), 0);
    let st = pool[pool.length - 1];
    for (const cand of pool) {
      x -= weight(cand);
      if (x < 0) { st = cand; break; }
    }
    const d = dist.get(st.title);
    const hops = d === undefined ? UNLINKED_BUILT_HOPS : Math.min(ECON.maxDepth, d);
    return { title: st.title, stub: toStub(st.article), hops };
  }

  /**
   * An article that is not built yet: usually a direct link of a station the passenger can get to
   * over track (so it is on a signpost somewhere the player can see), and, as deliveries mount,
   * sometimes one or more links further out. Never touches the shared rng.
   */
  async function pickUnbuilt(origin, r) {
    const dist = trackDistances(origin);
    const depth = targetDepth(state.delivered);
    let k = 1; // links past the built network
    while (k < depth && r() < UNBUILT_FARTHER_ODDS) k++;
    // Stations nearer the passenger are likelier anchors: weight 1, 1/2, 1/4, ...
    const anchors = [...dist.entries()].filter(([t]) => state.stations.has(t));
    for (let tries = 0; tries < MAX_ANCHOR_TRIES && anchors.length; tries++) {
      let total = 0;
      for (const [, d] of anchors) total += Math.pow(0.5, d);
      let x = r() * total;
      let at = anchors.length - 1;
      for (let i = 0; i < anchors.length; i++) {
        x -= Math.pow(0.5, anchors[i][1]);
        if (x < 0) { at = i; break; }
      }
      const [anchor, d] = anchors.splice(at, 1)[0];
      const found = await walkOut(anchor, origin, k, r);
      if (found) return { title: found.title, stub: found.stub, hops: Math.min(ECON.maxDepth, d + found.links) };
    }
    return null;
  }

  /** From a built station, follow `k - 1` lead links through unbuilt articles, then pick the last one. */
  async function walkOut(anchor, origin, k, r) {
    let cur = state.stations.get(anchor).article;
    const visited = new Set([origin, anchor]);
    let links = 1;
    for (; links < k; links++) {
      const opts = (cur.leadLinks || []).filter((t) => !visited.has(t) && !state.stations.has(t));
      if (!opts.length) break;
      const next = opts[Math.floor(r() * opts.length)];
      let article;
      try {
        article = await loadArticle(next);
      } catch {
        break;
      }
      visited.add(next);
      cur = article;
    }
    const opts = (cur.leadLinks || []).filter((t) => !visited.has(t) && !state.stations.has(t) && !liveDuplicate(origin, t));
    if (!opts.length) return null;
    const stubs = await stubsFor(opts);
    const good = opts.filter((t) => stubs.has(t) && !isSpecialKind(stubs.get(t).kind));
    // Prefer an article already on the map as a signpost.
    const shown = good.filter((t) => world.placements.has(t));
    const pool = shown.length ? shown : good;
    if (!pool.length) return null;
    const title = pool[Math.floor(r() * pool.length)];
    return { title, stub: stubs.get(title), links };
  }

  /** Chooses what a new passenger at `origin` wants, and how far away that counts as. */
  async function pickDestination(origin, r) {
    // With tickets on, ordinary passengers only ride between stations that exist.
    if (tickets) return state.stations.size >= 2 ? pickBuilt(origin, r) : null;
    const wantBuilt = state.stations.size >= 2 && r() < ECON.builtDestinationShare;
    if (wantBuilt) return pickBuilt(origin, r) || (await pickUnbuilt(origin, r));
    return (await pickUnbuilt(origin, r)) || (state.stations.size >= 2 ? pickBuilt(origin, r) : null);
  }

  function trySpawn() {
    if (pendingSpawns >= MAX_PENDING_SPAWNS) return;
    const open = [...state.stations.values()].filter((s) => s.waiting.length < ECON.maxWaitingPerStation);
    if (!open.length) return;
    const origin = open[Math.floor(rng() * open.length)].title;
    const r = mulberry32(Math.floor(rng() * 4294967296));
    pendingSpawns++;
    pickDestination(origin, r)
      .then((dest) => {
        if (!dest || state.phase !== 'running') return;
        const st = state.stations.get(origin);
        if (!st || st.waiting.length >= ECON.maxWaitingPerStation) return;
        if (dest.title === origin) return;
        const built = state.stations.has(dest.title);
        if (built ? liveCount(origin, dest.title) >= MAX_SAME_BUILT_PAIR : liveDuplicate(origin, dest.title)) return;
        addThought(origin, dest.title, dest.hops, (dest.stub && dest.stub.description) || '');
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

  // ------------------------------------------------------------ surprises
  const FINDS = [
    'A gold seam struck while digging',
    'A patron endowed the station',
    'A forgotten mail contract turned up',
    'Old rails salvaged and sold',
    'The town threw a collection',
    'A crate of unclaimed freight sold',
  ];
  const JACKPOTS = ['A lost payroll chest unearthed', 'A railway baron backs the line'];

  function paySurprise(station, kind, text, base) {
    const amount = Math.max(1, Math.round(base));
    state.money += amount;
    emit('surprise', { station, kind, text, amount });
    return amount;
  }

  /** A new station sometimes turns something up. Nothing announces it beforehand. */
  function stationSurprise(title) {
    if (!surprises || state.phase !== 'running') return 0;
    const roll = luck();
    const pick = luck();
    const size = luck();
    if (roll < ECON.surpriseJackpotChance) {
      return paySurprise(title, 'jackpot', JACKPOTS[Math.floor(pick * JACKPOTS.length)], ECON.surpriseJackpot * state.inflation);
    }
    if (roll < ECON.surpriseJackpotChance + ECON.surpriseFindChance) {
      const base = ECON.surpriseFindMin + (ECON.surpriseFindMax - ECON.surpriseFindMin) * size;
      return paySurprise(title, 'find', FINDS[Math.floor(pick * FINDS.length)], base * state.inflation);
    }
    return 0;
  }

  /** A ticket's passenger sometimes tips on arrival. */
  function ticketSurprise(t, reward) {
    if (!surprises || state.phase !== 'running') return 0;
    if (luck() >= ECON.surpriseTipChance) return 0;
    return paySurprise(t.to, 'tip', 'A grateful passenger tipped', reward * ECON.surpriseTipFraction);
  }

  // ------------------------------------------------------------ tickets
  let nextTicketId = 1;
  let ticketsIssued = 0;
  let pendingTickets = 0;
  let ticketGap = 2; // seconds until the next ticket may be drawn
  // How far the next ticket reaches. It follows how the player is doing, not the clock: quick
  // finishes push it out, tickets that run out pull it back in.
  let ticketSkill = ECON.ticketSkillStart;
  const clampSkill = (x) => Math.min(ECON.ticketMaxLinks, Math.max(1, x));
  const ticketBase = new Map(); // ticket id -> full reward when issued
  const ticketPaths = new Map(); // ticket id -> the chain of articles it was drawn along (the surveyor's map)
  const surveyorCost = () => Math.round(ECON.surveyorCost * state.inflation);

  function removeTicket(t) {
    const i = state.tickets.indexOf(t);
    if (i >= 0) state.tickets.splice(i, 1);
    ticketBase.delete(t.id);
    ticketPaths.delete(t.id);
  }

  /** A ticket is met the moment both ends are stations joined by track. Paid at once. */
  function checkTickets() {
    // A surveyor's advice is used up once the station it pointed at exists.
    for (const t of state.tickets) {
      if (t.hint && state.stations.has(t.hint.to)) {
        t.hint = null;
        emit('ticketHint', { ticket: t, hint: null });
      }
    }
    let any = false;
    for (const t of [...state.tickets]) {
      if (!state.stations.has(t.from) || !state.stations.has(t.to)) continue;
      if (!trackDistances(t.from).has(t.to)) continue;
      removeTicket(t);
      const reward = t.reward;
      state.money += reward;
      ticketsDone++;
      ticketSkill = clampSkill(ticketSkill + (t.time >= t.timeMax / 2 ? ECON.ticketSkillFast : ECON.ticketSkillSlow));
      ticketGap = ECON.ticketGapSeconds;
      any = true;
      emit('ticketDone', { ticket: t, reward });
      ticketSurprise(t, reward);
    }
    if (any) checkGoal();
  }

  function addTicket(from, to, fromDescription, toDescription, links, path = null, express = false) {
    const base = (ECON.ticketBase + ECON.ticketPerLink * links) * state.inflation * (express ? ECON.expressRewardMult : 1);
    const timeMax = Math.round((ECON.ticketSecondsBase + ECON.ticketSecondsPerLink * links) * (express ? ECON.expressTimeMult : 1));
    const t = { id: nextTicketId++, from, to, fromDescription, toDescription, links, express: !!express, reward: Math.round(base), time: timeMax, timeMax, surveyCost: surveyorCost(), surveying: null, hint: null };
    ticketBase.set(t.id, base);
    if (Array.isArray(path) && path.length >= 2) ticketPaths.set(t.id, path.slice());
    state.tickets.push(t);
    ticketsIssued++;
    emit('ticketAdded', { ticket: t });
    checkTickets();
    return t;
  }

  /** One link out from `article` to a page that is not built, not special, and not already ticketed. */
  async function stepOut(article, visited, taken, r) {
    const opts = (article.leadLinks || []).filter((t) => !visited.has(t) && !state.stations.has(t) && !taken.has(t));
    if (!opts.length) return null;
    const stubs = await stubsFor(opts);
    const good = opts.filter((t) => stubs.has(t) && !isSpecialKind(stubs.get(t).kind));
    if (!good.length) return null;
    const title = good[Math.floor(r() * good.length)];
    visited.add(title);
    return { title, stub: stubs.get(title) };
  }

  /**
   * Draws one ticket. Its destination is always unbuilt, some links out from the network; its
   * start is always a station the player owns. Tickets reach further
   * as more are issued, so the game becomes about finding the chain of links.
   */
  async function drawTicket() {
    const r = mulberry32(Math.floor(rng() * 4294967296));
    // Every draw takes the same three numbers, so the stream stays in step whatever they decide.
    const shorter = r() < ECON.ticketShorterChance;
    const express = r() < ECON.expressTicketChance && ticketsIssued > 0 && surprises;
    let k = Math.floor(clampSkill(ticketSkill));
    if (shorter && k > 1) k--;
    if (ticketsIssued === 0) k = 1;
    pendingTickets++;
    try {
      for (let tries = 0; tries < 6; tries++) {
        const built = [...state.stations.values()].filter((st) => !isSpecialKind(st.article.kind));
        if (!built.length) return;
        const taken = new Set(state.tickets.flatMap((t) => [t.from, t.to]));
        const anchor = built[Math.floor(r() * built.length)];
        // A ticket always starts from a station the player owns: its passenger is waiting there.
        const bothNew = false;
        const visited = new Set([anchor.title]);
        const path = [anchor.title];
        let from = anchor.title;
        let fromDescription = anchor.article.description || '';
        let cur = anchor.article;
        let links = 0;
        if (bothNew) {
          const first = await stepOut(cur, visited, taken, r);
          if (!first) continue;
          from = first.title;
          path.push(first.title);
          fromDescription = first.stub.description || '';
          links = 1;
          try { cur = await loadArticle(first.title); } catch { continue; }
        }
        const steps = bothNew ? k - 1 : k;
        let last = null;
        for (let i = 0; i < steps; i++) {
          const next = await stepOut(cur, visited, taken, r);
          if (!next) break;
          last = next;
          path.push(next.title);
          links++;
          if (i < steps - 1) {
            try { cur = await loadArticle(next.title); } catch { break; }
          }
        }
        if (!last || last.title === from) continue;
        if (state.phase !== 'running' || state.tickets.length >= ECON.maxTickets) return;
        if (state.stations.has(last.title) || (bothNew && state.stations.has(from))) continue;
        if (state.tickets.some((t) => t.to === last.title || t.from === last.title)) continue;
        addTicket(from, last.title, fromDescription, last.stub.description || '', links, path, express);
        return;
      }
    } catch {
      // a failed lookup just means no ticket this time
    } finally {
      pendingTickets--;
    }
  }

  /**
   * Buy a surveyor for one ticket: for a fee, they point out the next article to build on a route
   * that reaches the ticket's destination, and which of your stations to build it from.
   * One purchase shows one step; once that station is built, another can be bought.
   */
  async function buySurveyor(ticketId) {
    if (state.phase !== 'running') return fail('The game is not running.');
    const t = state.tickets.find((x) => x.id === ticketId);
    if (!t) return fail('That ticket is gone.');
    if (t.hint) return { ok: true, hint: t.hint };
    if (t.surveying) return { ok: true, surveying: t.surveying };
    const path = ticketPaths.get(t.id);
    if (!path) return fail('The surveyor has no map for this ticket.');
    let i = -1;
    for (let k = 0; k < path.length; k++) if (state.stations.has(path[k])) i = k;
    if (i < 0 || i >= path.length - 1) return fail('There is nothing left to survey for this ticket.');
    const cost = surveyorCost();
    if (state.money < cost) return fail(`Not enough gold: a surveyor costs ${cost} gold.`);
    const from = path[i];
    const to = path[i + 1];
    state.money -= cost;
    if (!world.placements.has(to)) {
      let res;
      try {
        res = await survey(from, to);
      } catch {
        res = { ok: false };
      }
      if (!res || !res.ok) {
        state.money += cost;
        return fail('The surveyor could not find the way. Nothing was charged.');
      }
    }
    if (!state.tickets.includes(t)) { state.money += cost; return fail('That ticket is gone.'); }
    // The surveyor goes to work at that station; what they find is revealed when they finish.
    t.surveying = { from, to, left: ECON.surveyorSeconds, total: ECON.surveyorSeconds };
    emit('ticketHint', { ticket: t, hint: null });
    return { ok: true, surveying: t.surveying };
  }

  function tickTickets(h, frozen = false) {
    const cost = surveyorCost();
    for (const t of state.tickets) {
      t.surveyCost = cost;
      // A surveyor at work finishes on their own clock, even before the game's clock has started.
      const sv = t.surveying;
      if (!sv) continue;
      if (state.stations.has(sv.to)) { t.surveying = null; continue; } // built meanwhile: nothing left to find
      sv.left = Math.max(0, sv.left - h);
      if (sv.left <= 0) {
        t.surveying = null;
        t.hint = { from: sv.from, to: sv.to };
        emit('ticketHint', { ticket: t, hint: t.hint });
      }
    }
    for (const t of frozen ? [] : [...state.tickets]) {
      t.time = Math.max(0, t.time - h);
      t.reward = Math.round(liveFare(ticketBase.get(t.id), t.time, t.timeMax));
      if (t.time <= 0) {
        removeTicket(t);
        ticketSkill = clampSkill(ticketSkill - ECON.ticketSkillExpired);
        ticketGap = ECON.ticketGapSeconds;
        emit('ticketExpired', { ticket: t });
      }
    }
    if (!ticketsOn) return;
    ticketGap = Math.max(0, ticketGap - h);
    if (ticketGap <= 0 && state.tickets.length + pendingTickets < ECON.maxTickets) {
      ticketGap = ECON.ticketGapSeconds;
      drawTicket();
    }
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
    const p = state.payday;
    p.income += (incomeRate() * h) / 60;
    p.upkeep += (upkeepRate() * h) / 60;
    paydayElapsed += h;
    if (paydayElapsed >= ECON.paydaySeconds - 1e-9) {
      const amount = p.income + p.fares - p.upkeep;
      state.money += amount;
      p.last = { amount, income: p.income, fares: p.fares, upkeep: p.upkeep, time: state.time };
      p.income = 0;
      p.fares = 0;
      p.upkeep = 0;
      paydayElapsed = 0;
      emit('payday', { amount, income: p.last.income, fares: p.last.fares, upkeep: p.last.upkeep });
    }
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
    } else {
      state.bankruptIn = null;
    }
  }

  function gameOver() {
    state.phase = 'over';
    refreshDerived();
    const line = longestLine(state.tracks);
    emit('gameOver', {
      score: state.score,
      time: state.time,
      delivered: state.delivered,
      stations: state.stations.size,
      tickets: ticketsDone,
      start: startTitle,
      lineFrom: line ? line.from : null,
      lineTo: line ? line.to : null,
    });
  }

  // ------------------------------------------------------------ loop
  function step(h) {
    // Nothing costs or ages until the player has built something: the clock (time, inflation,
    // paydays, ticket timers, passengers) starts with the first track. Tickets still arrive,
    // so there is something to aim for.
    if (clockWaits && state.tracks.length === 0) {
      state.clockRunning = false;
      tickTickets(h, true);
      return;
    }
    state.clockRunning = true;
    state.time += h;
    state.inflation = inflationAt(state.time);
    tickMoney(h);
    moveTrains(h);
    tickThoughts(h);
    tickSpawns(h);
    tickTickets(h);
    tickBankruptcy(h);
    checkGoal();
  }

  function update(dt) {
    if (state.phase !== 'running') return;
    if (!(dt > 0)) return;
    let game = Math.min(dt, MAX_REAL_DT) * state.speed;
    while (game > 1e-9 && state.phase === 'running') {
      // Substeps end exactly on payday boundaries so paydays land on the dot.
      const h = Math.min(game, STEP, Math.max(1e-6, ECON.paydaySeconds - paydayElapsed));
      step(h);
      game -= h;
    }
    refreshDerived();
  }

  function setSpeed(speed) {
    if (SPEEDS.includes(speed)) state.speed = speed;
  }

  nextGoal();
  refreshDerived();

  return {
    state,
    on,
    start,
    update,
    setSpeed,
    quoteBuild,
    build,
    link,
    survey,
    quoteUpgrade,
    upgradeTrack,
    buySurveyor,
    trackBetween,
    // Not part of the contract: hooks for tests and the balance bot.
    _debug: { addThought, addTicket, router, nav },
  };
}
