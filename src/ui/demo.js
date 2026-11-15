// Standalone demo of the UI against a MOCK game and renderer (no wiki, world, sim or three.js).
// Open /ui-demo.html. Options: ?fresh (single starting station, to see the first goals),
// ?fail (the first start() rejects, to see "Try again"). The game starts by itself.
import { createUI } from './index.js';
import { ECON, TRAIN_TYPES, TRACK_UPGRADES } from '../config.js';
import { hexToWorld } from '../hex.js';

const params = new URLSearchParams(location.search);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fake wikipedia data

const FILLER_STEMS = [
  'History of', 'List of', 'Timeline of', 'Geography of', 'Economy of', 'Culture of', 'Railways in', 'Transport in',
];
const FILLER_PLACES = [
  'France', 'Japan', 'Germany', 'India', 'Brazil', 'Canada', 'Italy', 'Spain', 'Poland', 'Sweden', 'Chile', 'Kenya',
  'Egypt', 'Norway', 'Peru', 'Turkey', 'Ireland', 'Vietnam', 'Mexico', 'Iceland',
];
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

function makeArticle(title, { kind = 'article', description = '', summary = '', lead = [], extra = [], count = 90, thumbnail = null }) {
  const links = [];
  const seen = new Set([title]);
  const push = (t) => { if (!seen.has(t)) { seen.add(t); links.push(t); } };
  lead.forEach(push);
  extra.forEach(push);
  let i = 0;
  while (links.length < count) {
    const stem = FILLER_STEMS[(hash(title) + i) % FILLER_STEMS.length];
    const place = FILLER_PLACES[(hash(title + i) >>> 3) % FILLER_PLACES.length];
    push(`${stem} ${place}${i > 150 ? ' ' + i : ''}`);
    i++;
  }
  return {
    title, kind, description, popularity: 0.55, summary, thumbnail,
    url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')),
    leadLinks: lead.filter((t) => t !== title), links,
  };
}

const KNOWN = {
  'Rail transport': {
    count: 260,
    description: 'Means of transport on wheeled vehicles running on rails',
    summary: 'Rail transport is a means of transport that transfers passengers and goods on wheeled vehicles running on rails, which are incorporated in tracks. In contrast to road transport, where the vehicles run on a prepared flat surface, rail vehicles are directionally guided by the tracks on which they run.',
    lead: ['Locomotive', 'Steam engine', 'Train station', 'Rapid transit', 'High-speed rail', 'Narrow-gauge railway', 'Maglev', 'Track gauge', 'List of rail transport topics', 'Railroad (disambiguation)'],
    extra: ['Industrial Revolution', 'Diesel engine', 'Rail freight transport', 'Passenger train', 'Railway electrification', 'Tram', 'Funicular'],
  },
  Locomotive: {
    description: 'Rail transport vehicle that provides the motive power for a train',
    summary: 'A locomotive is a rail transport vehicle that provides the motive power for a train. If a locomotive is capable of carrying a payload, it is usually rather referred to as a multiple unit, motor coach, railcar or power car.',
    lead: ['Rail transport', 'Steam engine', 'Diesel locomotive', 'Electric locomotive', 'Railway electrification', 'Track gauge', 'Train station'],
    extra: ['Diesel engine', 'Industrial Revolution', 'Horsepower'],
  },
  'Steam engine': {
    description: 'Engine that performs mechanical work using steam as its working fluid',
    summary: 'A steam engine is a heat engine that performs mechanical work using steam as its working fluid. The steam engine uses the force produced by steam pressure to push a piston back and forth inside a cylinder.',
    lead: ['Locomotive', 'James Watt', 'Thermodynamics', 'Boiler', 'Rail transport'],
    extra: ['Industrial Revolution', 'Horsepower', 'Newcomen atmospheric engine'],
  },
};
const GHOST_STUBS = {
  'Train station': ['article', 'Railway facility where trains regularly stop'],
  'Rapid transit': ['article', 'Form of public transport in urban areas'],
  'High-speed rail': ['article', 'Type of rail transport network'],
  'Narrow-gauge railway': ['article', 'Railway with track narrower than standard gauge'],
  Maglev: ['article', 'Train system using magnetic levitation'],
  'Track gauge': ['article', 'Distance between the rails of a railway track'],
  'List of rail transport topics': ['list', 'Wikipedia list article'],
  'Railroad (disambiguation)': ['disambiguation', 'Disambiguation page'],
  'Diesel locomotive': ['article', 'Locomotive powered by a diesel engine'],
  'Electric locomotive': ['article', 'Locomotive powered by electricity'],
  'Railway electrification': ['article', 'Powering trains with electricity'],
  'James Watt': ['article', 'Scottish inventor and engineer (1736-1819)'],
  Thermodynamics: ['article', 'Branch of physics concerned with heat and temperature'],
  Boiler: ['article', 'Closed vessel in which fluid is heated'],
};


// ------------------------------------------------------------------ mock game

function createMockGame() {
  const handlers = new Map();
  const emit = (name, payload) => { for (const fn of handlers.get(name) || []) fn(payload); };
  const PERIOD = ECON.paydaySeconds;
  const state = {
    phase: 'idle', time: 0, speed: 1, money: ECON.startMoney, score: 0, inflation: 1,
    payday: { period: PERIOD, in: PERIOD, income: 0, fares: 0, upkeep: 0, pending: 0, forecast: 0, last: null },
    goal: null, streak: 0, tickets: [],
    delivered: 0, lost: 0, reputation: ECON.reputationStart, uniqueLinks: 0, bankruptIn: null,
    stations: new Map(), stubs: new Map(), tracks: [], trains: [], thoughts: [],
  };
  const placements = new Map();
  let nextId = 1;
  let spawnIn = 6;
  let negFor = 0;
  let failFirst = params.has('fail');

  const articles = new Map();
  function articleFor(title) {
    if (articles.has(title)) return articles.get(title);
    const k = KNOWN[title];
    const stub = GHOST_STUBS[title];
    const a = makeArticle(title, k ? k : {
      kind: stub ? stub[0] : 'article',
      description: stub ? stub[1] : '',
      summary: `${title} is a topic with a short plain-text summary that the wiki module would supply.`,
      lead: ['Rail transport', 'Locomotive', 'Track gauge', 'Thermodynamics', 'History of France'].filter((t) => t !== title),
    });
    articles.set(title, a);
    return a;
  }

  function addPlacement(title, q, r, st, parent) {
    placements.set(title, { title, q, r, state: st, parent });
    const a = articleFor(title);
    state.stubs.set(title, { title, kind: a.kind, description: a.description, popularity: a.popularity });
  }

  function recomputeUnique() {
    const seen = new Set();
    let total = 0;
    for (const st of [...state.stations.values()].sort((a, b) => a.builtAt - b.builtAt)) {
      let u = 0;
      for (const l of st.article.links) if (!seen.has(l)) { seen.add(l); u++; }
      st.uniqueLinks = u;
      st.incomePerMin = st.article.kind === 'article' ? u * ECON.linkIncomePerUniqueLinkPerMin : 0;
      total += u;
    }
    state.uniqueLinks = total;
  }

  function addBuilt(title, q, r, parent) {
    addPlacement(title, q, r, 'built', parent);
    state.stations.set(title, {
      title, article: articleFor(title), q, r, uniqueLinks: 0, incomePerMin: 0, waiting: [], builtAt: state.time + state.stations.size * 0.001,
    });
    recomputeUnique();
  }

  function ghostRing(parentTitle, count) {
    const p = placements.get(parentTitle);
    const lead = articleFor(parentTitle).leadLinks.filter((t) => !placements.has(t)).slice(0, count);
    const added = [];
    lead.forEach((t, i) => {
      const ang = (hash(parentTitle) % 6) + i * 1.1;
      const dist = 4 + (i % 4);
      addPlacement(t, p.q + Math.round(Math.cos(ang) * dist), p.r + Math.round(Math.sin(ang) * dist), 'ghost', parentTitle);
      added.push(placements.get(t));
    });
    if (added.length) emit('ghostsAdded', { placements: added });
  }

  function hexDist(a, b) {
    const dq = a.q - b.q, dr = a.r - b.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  function makeRoute(from, to, style) {
    const a = placements.get(from), b = placements.get(to);
    const n = Math.max(3, Math.round(hexDist(a, b)));
    const len = style === 'cheap' ? n + Math.ceil(n * 0.4) : n;
    const salt = hash(from + to);
    const hexes = [];
    for (let i = 0; i <= len; i++) {
      let kind = 'ground';
      if (i > 0 && i < len) {
        if (style === 'cheap') { if ((i + salt) % 7 === 3) kind = 'ledge'; else if ((i + salt) % 11 === 5) kind = 'bridge'; }
        else if ((i + salt) % 5 === 2) kind = 'bridge';
        else if ((i + salt) % 9 === 5) kind = 'tunnel';
      }
      const f = i / len;
      hexes.push({ q: Math.round(a.q + (b.q - a.q) * f), r: Math.round(a.r + (b.r - a.r) * f), kind });
    }
    const cost = hexes.reduce((s, h) => s + ECON.trackCostPerHex[h.kind], 0);
    return { from, to, style, hexes, points: [], length: len, cost };
  }

  function quote(route, to) {
    const art = articleFor(to);
    const mult = art.kind === 'article' ? 1 : ECON.specialPageCostMult;
    const stationCost = state.stations.has(to) ? 0 : Math.round((ECON.stationBaseCost + ECON.stationPopularityCost * art.popularity) * mult * state.inflation);
    const trackCost = Math.round(route.cost * state.inflation);
    const total = trackCost + stationCost;
    return { style: route.style, route, trackCost, stationCost, total, affordable: total <= state.money };
  }

  // income and upkeep per game second, from the current network
  function rates() {
    const income = [...state.stations.values()].reduce((s, st) => s + st.incomePerMin, 0) / 60;
    const upkeep = (state.tracks.reduce((s, tr) => s + tr.route.length * ECON.trackUpkeepPerHexPerMin, 0)
      + state.trains.reduce((s, tr) => s + TRAIN_TYPES[tr.typeId].upkeepPerMin, 0)) * state.inflation / 60;
    return { income, upkeep };
  }

  function refreshForecast() {
    const p = state.payday;
    const r = rates();
    p.pending = p.income + p.fares - p.upkeep;
    p.forecast = p.pending + (r.income - r.upkeep) * p.in;
  }

  function upgradeOptions(track) {
    return TRACK_UPGRADES[track.level].map((id) => {
      const t = TRAIN_TYPES[id];
      const cost = Math.round(t.cost * state.inflation);
      return { typeId: id, name: t.name, blurb: t.blurb, cost, affordable: cost <= state.money };
    });
  }

  // ---- goals: a few that teach the game in order, then ones that repeat and grow
  const GOAL_DEFS = [
    { id: 'station', text: 'Build a station', how: 'Click a signpost on the map, then press Build', target: () => 1, count: () => state.stations.size },
    { id: 'train', text: 'Put a train on a track', how: 'Click the price tag on a track', target: () => 1, count: () => state.trains.length },
    { id: 'deliver3', text: 'Deliver 3 passengers', how: 'Passengers ride a train to the station they want', target: () => 3, count: () => state.delivered },
    { id: 'upgrade', text: 'Upgrade a track', how: 'Click the price tag on a track with a train', target: () => 1, count: () => state.tracks.filter((t) => t.level >= 2).length },
  ];
  let goalIndex = -1;
  let goalBase = 0;
  function defFor(i) {
    if (i < GOAL_DEFS.length) return GOAL_DEFS[i];
    const k = i - GOAL_DEFS.length;
    return k % 2 === 0
      ? { id: 'deliverN', text: `Deliver ${5 + k * 2} passengers`, how: 'Keep trains running to the stations passengers want', target: () => 5 + k * 2, count: () => state.delivered }
      : { id: 'reachN', text: `Reach ${state.stations.size + 2} stations`, how: 'Build more stations from the signposts', target: (() => { const n = state.stations.size + 2; return () => n; })(), count: () => state.stations.size };
  }
  function startGoal(i) {
    goalIndex = i;
    const d = defFor(i);
    const base = d.id === 'reachN' ? 0 : d.count(); // goals count what happens from now on
    goalBase = base;
    state.goal = { id: d.id, text: d.text, how: d.how, progress: Math.max(0, d.count() - base), target: d.target(), reward: ECON.goalRewardBase + i * 50 };
  }
  function updateGoal() {
    const g = state.goal;
    if (!g) return;
    const d = defFor(goalIndex);
    g.progress = Math.min(g.target, Math.max(0, d.count() - goalBase));
    if (g.progress >= g.target) {
      const done = { ...g };
      state.money += g.reward;
      startGoal(goalIndex + 1);
      emit('goalDone', { goal: done, reward: done.reward, next: state.goal });
    }
  }

  // ---- tickets: routes to find; from a built station to one not built, or between two not built
  const TICKET_POOL = ['Maglev', 'Tram', 'Boiler', 'James Watt', 'Diesel engine', 'Thermodynamics', 'Funicular', 'Rapid transit', 'Cheese'];
  let ticketIn = 4;
  function addTicket() {
    const built = [...state.stations.keys()];
    const free = TICKET_POOL.filter((t) => !state.stations.has(t) && !state.tickets.some((k) => k.to === t || k.from === t));
    if (free.length < 2) return;
    const to = free[Math.floor(Math.random() * free.length)];
    const rest = free.filter((t) => t !== to);
    const from = Math.random() < 0.6 ? built[Math.floor(Math.random() * built.length)] : rest[Math.floor(Math.random() * rest.length)];
    const links = 2 + Math.floor(Math.random() * 3);
    const desc = (t) => (GHOST_STUBS[t] && GHOST_STUBS[t][1]) || '';
    const reward0 = Math.round((ECON.ticketBase + ECON.ticketPerLink * links) * state.inflation);
    const tk = { id: nextId++, from, to, fromDescription: desc(from), toDescription: desc(to), links, reward0, reward: reward0, time: 150, timeMax: 150 };
    state.tickets.push(tk);
    emit('ticketAdded', { ticket: tk });
  }
  function updateTickets(t) {
    for (const tk of [...state.tickets]) {
      tk.time -= t;
      tk.reward = Math.round(tk.reward0 * (1 - 0.5 * (1 - Math.max(0, tk.time) / tk.timeMax)));
      if (state.stations.has(tk.from) && state.stations.has(tk.to) && game.trackBetween(tk.from, tk.to)) {
        drop(state.tickets, tk);
        state.money += tk.reward;
        emit('ticketDone', { ticket: tk, reward: tk.reward });
      } else if (tk.time <= 0) {
        drop(state.tickets, tk);
        emit('ticketExpired', { ticket: tk });
      }
    }
    ticketIn -= t;
    if (ticketIn <= 0 && state.tickets.length < ECON.maxTickets) { ticketIn = 8; addTicket(); }
  }
  function drop(arr, x) { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); }

  const game = {
    state,
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
    async start() {
      state.phase = 'loading';
      await sleep(1200);
      if (failFirst) {
        failFirst = false;
        state.phase = 'idle';
        throw new Error('Wikipedia did not answer (mock failure). Try again.');
      }
      addBuilt('Rail transport', 0, 0, null);
      ghostRing('Rail transport', 10);
      if (!params.has('fresh')) seedRichGame();
      startGoal(params.has('fresh') ? 0 : 2);
      refreshForecast();
      state.phase = 'running';
      for (let i = 0; i < ECON.maxTickets; i++) addTicket();
      emit('started', { station: state.stations.get('Rail transport') });
    },
    update(dt) {
      if (state.phase !== 'running') return;
      const t = dt * state.speed;
      if (t <= 0) return;
      state.time += t;
      state.inflation = 1 + ECON.inflationRate * Math.pow(state.time / 60, ECON.inflationExponent);
      const p = state.payday;
      const r = rates();
      p.income += r.income * t;
      p.upkeep += r.upkeep * t;
      p.in -= t;
      while (p.in <= 0) {
        p.in += p.period;
        const amount = p.income + p.fares - p.upkeep;
        state.money += amount;
        p.last = { amount, income: p.income, fares: p.fares, upkeep: p.upkeep, time: state.time };
        emit('payday', { amount, income: p.income, fares: p.fares, upkeep: p.upkeep });
        p.income = p.fares = p.upkeep = 0;
      }
      refreshForecast();
      state.score = Math.round(state.delivered * 10 + state.stations.size * 25 + state.uniqueLinks * 0.1);
      state.bankruptIn = null;
      if (state.money < 0) {
        negFor += t;
        state.bankruptIn = Math.max(0, ECON.bankruptcyGraceSeconds - negFor);
        if (negFor >= ECON.bankruptcyGraceSeconds) return gameOver();
      } else negFor = 0;

      for (const th of state.thoughts) th.patience -= t;
      for (const th of state.thoughts.filter((x) => x.patience <= 0)) {
        remove(state.thoughts, th);
        state.lost++;
        state.streak = 0;
        state.reputation = Math.max(0, state.reputation - ECON.reputationPerLost);
        const st = state.stations.get(th.from);
        if (st) st.waiting = st.waiting.filter((id) => id !== th.id);
        emit('thoughtLost', { thought: th });
      }
      for (const th of state.thoughts) {
        const frac = Math.max(0, th.patience / th.patienceMax);
        th.fare = Math.round(th.baseFare * (ECON.fareMinFraction + (1 - ECON.fareMinFraction) * frac));
      }
      // each running train delivers a waiting passenger now and then
      for (const tr of state.trains) {
        tr.carry = (tr.carry || 0) + t;
        if (tr.carry > 9 / TRAIN_TYPES[tr.typeId].speed * 1.6) {
          tr.carry = 0;
          const track = state.tracks.find((x) => x.id === tr.trackId);
          const th = state.thoughts.find((x) => x.state === 'waiting' && (x.at === track.from || x.at === track.to));
          if (th) deliver(th, th.at === track.from ? track.to : track.from);
        }
        tr.passengers = Array.from({ length: Math.floor((Math.sin(state.time / 5 + tr.id) + 1) * 1.6) }, (_, i) => i);
      }
      updateTickets(t);
      spawnIn -= t;
      if (spawnIn <= 0) { spawnIn = 12; spawnThought(); }
      updateGoal();
    },
    setSpeed(s) { state.speed = s; },
    quoteBuild(from, to) {
      const f = state.stations.get(from);
      if (!f) return { ok: false, reason: `${from} is not a built station.` };
      if (!placements.has(to)) return { ok: false, reason: `${to} is not on the map.` };
      const t = state.stations.get(to);
      const linked = f.article.links.includes(to) || (t && t.article.links.includes(from));
      if (!linked) return { ok: false, reason: `${from} does not link to ${to}.` };
      if (game.trackBetween(from, to)) return { ok: false, reason: 'Track already joins these stations.' };
      const cheap = quote(makeRoute(from, to, 'cheap'), to);
      const direct = quote(makeRoute(from, to, 'direct'), to);
      return { ok: true, cheap, direct, same: false };
    },
    async build(from, to, style = 'cheap') {
      await sleep(500);
      const q = game.quoteBuild(from, to);
      if (!q.ok) return q;
      const pick = style === 'direct' ? q.direct : q.cheap;
      if (pick.total > state.money) return { ok: false, reason: `Not enough gold: ${pick.total} needed.` };
      state.money -= pick.total;
      const ghost = !state.stations.has(to);
      if (ghost) {
        const p = placements.get(to);
        p.state = 'built';
        addBuilt(to, p.q, p.r, from);
      }
      const track = { id: nextId++, from, to, route: pick.route, level: 0, typeId: null, trainId: null };
      state.tracks.push(track);
      if (ghost) {
        const waiting = state.thoughts.filter((x) => x.state === 'waiting' && x.to === to);
        const amount = Math.round(waiting.reduce((n, x) => n + x.fare, 0) * ECON.routeBonusFraction);
        emit('stationBuilt', { station: state.stations.get(to), track });
        ghostRing(to, 8);
        if (waiting.length) {
          state.money += amount;
          emit('routeBonus', { station: to, count: waiting.length, amount });
        }
      }
      emit('trackBuilt', { track });
      return { ok: true };
    },
    async survey(from, link) {
      await sleep(250);
      const f = state.stations.get(from);
      if (!f || !f.article.links.includes(link)) return { ok: false, reason: `${from} does not link to ${link}.` };
      if (!placements.has(link)) {
        const p = placements.get(from);
        const n = placements.size;
        addPlacement(link, p.q + 3 + (n % 5), p.r - 4 + (n % 7), 'ghost', from);
        emit('ghostsAdded', { placements: [placements.get(link)] });
      }
      return { ok: true };
    },
    quoteUpgrade(trackId) {
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return { ok: false, reason: 'No such track.' };
      const options = upgradeOptions(track);
      return options.length ? { ok: true, options } : { ok: false, reason: 'This track is fully upgraded.' };
    },
    upgradeTrack(trackId, typeId) {
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return { ok: false, reason: 'No such track.' };
      const options = upgradeOptions(track);
      if (!options.length) return { ok: false, reason: 'This track is fully upgraded.' };
      const opt = typeId ? options.find((o) => o.typeId === typeId) : options.length === 1 ? options[0] : null;
      if (!opt) return { ok: false, reason: 'Choose which train to put on this track.' };
      if (opt.cost > state.money) return { ok: false, reason: `A ${opt.name} costs ${opt.cost} gold; you have ${Math.floor(state.money)}.` };
      state.money -= opt.cost;
      if (track.trainId != null) remove(state.trains, state.trains.find((t) => t.id === track.trainId));
      const train = { id: nextId++, typeId: opt.typeId, trackId: track.id, state: 'moving', t: 0.2, forward: true, atStation: track.from, passengers: [] };
      state.trains.push(train);
      track.level++;
      track.typeId = opt.typeId;
      track.trainId = train.id;
      emit('trackUpgraded', { track, train });
      emit('trainsChanged', {});
      return { ok: true };
    },
    trackBetween(a, b) {
      return state.tracks.find((t) => (t.from === a && t.to === b) || (t.from === b && t.to === a)) || null;
    },
  };

  function remove(arr, x) { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); }

  function deliver(th, station) {
    remove(state.thoughts, th);
    const st = state.stations.get(th.at);
    if (st) st.waiting = st.waiting.filter((id) => id !== th.id);
    state.delivered++;
    state.streak++;
    state.reputation = Math.min(1, state.reputation + ECON.reputationPerDelivery);
    const fare = Math.round(th.fare * (1 + Math.min(ECON.streakFareMax, ECON.streakFarePerStep * (state.streak - 1))));
    state.payday.fares += fare;
    emit('thoughtDelivered', { thought: th, fare, station, streak: state.streak });
  }

  function mkThought(from, to, desc, hops, patience) {
    const th = {
      id: nextId++, from, to, toDescription: desc, hops, baseFare: Math.round(ECON.fareBase + ECON.farePerHop * Math.pow(hops, ECON.fareHopExponent)), fare: 0,
      patience, patienceMax: ECON.patienceBase + ECON.patiencePerHop * hops, state: 'waiting', at: from, trainId: null,
    };
    th.fare = th.baseFare;
    state.thoughts.push(th);
    state.stations.get(from).waiting.push(th.id);
    return th;
  }

  function spawnThought() {
    const built = [...state.stations.keys()];
    const from = built[Math.floor(Math.random() * built.length)];
    const pool = ['Industrial Revolution', 'Maglev', 'James Watt', 'Diesel engine', 'Rapid transit', 'Thermodynamics', 'Tram', 'Boiler', 'Steam engine'];
    const to = pool[Math.floor(Math.random() * pool.length)];
    if (to === from) return;
    const hops = 2 + Math.floor(Math.random() * 3);
    const th = mkThought(from, to, (GHOST_STUBS[to] && GHOST_STUBS[to][1]) || (to === 'Industrial Revolution' ? 'Transition to new manufacturing processes, c. 1760-1840' : ''), hops, ECON.patienceBase + ECON.patiencePerHop * hops);
    emit('thoughtSpawned', { thought: th });
  }

  function gameOver() {
    state.phase = 'over';
    emit('gameOver', { score: state.score, time: state.time, delivered: state.delivered, stations: state.stations.size });
  }

  function seedRichGame() {
    addBuilt('Locomotive', 5, -2, 'Rail transport');
    addBuilt('Steam engine', 9, -1, 'Locomotive');
    ghostRing('Locomotive', 6);
    ghostRing('Steam engine', 5);
    const t1 = { id: nextId++, from: 'Rail transport', to: 'Locomotive', route: makeRoute('Rail transport', 'Locomotive', 'cheap'), level: 0, typeId: null, trainId: null };
    const t2 = { id: nextId++, from: 'Locomotive', to: 'Steam engine', route: makeRoute('Locomotive', 'Steam engine', 'cheap'), level: 0, typeId: null, trainId: null };
    state.tracks.push(t1, t2);
    state.time = 190;
    state.delivered = 7;
    state.money = 640;
    state.payday.last = { amount: 87, income: 3, fares: 95, upkeep: 11, time: 180 };
    game.upgradeTrack(t1.id, 'local');
    state.money = 640;
    mkThought('Rail transport', 'Industrial Revolution', 'Transition to new manufacturing processes, c. 1760-1840', 3, 190);
    mkThought('Rail transport', 'Steam engine', 'Engine that performs mechanical work using steam as its working fluid', 1, 70);
    mkThought('Locomotive', 'Maglev', 'Train system using magnetic levitation', 2, 140);
    mkThought('Steam engine', 'Diesel locomotive', 'Locomotive powered by a diesel engine', 2, 38);
    mkThought('Locomotive', 'Cheese', '', 4, 300);
    const riding = state.thoughts[1];
    riding.state = 'riding';
    riding.at = null;
    riding.trainId = state.trains[0].id;
  }

  game.placements = placements;
  game.upgradeOptions = (track) => upgradeOptions(track);
  game.debug = {
    bankrupt() { state.money = -100; negFor = ECON.bankruptcyGraceSeconds - 8; },
    cash() { state.money += 1000; },
    finishGoal() { if (state.goal) { state.goal.target = Math.max(1, state.goal.target); goalBase -= state.goal.target; updateGoal(); } },
    streak() { const th = state.thoughts.find((x) => x.state === 'waiting'); if (th) deliver(th, th.at); },
    lose() { const th = state.thoughts[0]; if (th) { th.patience = 0; } },
    payday() { state.payday.in = 0.01; },
    ticket() { const tk = state.tickets[0]; if (tk) { drop(state.tickets, tk); state.money += tk.reward; emit('ticketDone', { ticket: tk, reward: tk.reward }); } },
  };
  return game;
}

// ------------------------------------------------------------------ mock renderer

function createMockRenderer(game, mapEl, logEl) {
  const pickers = new Set();
  const log = { selection: null, preview: null, follow: null, focus: null, offer: null };
  const paint = () => {
    const p = log.preview ? `${log.preview.routes.length} route(s)` : 'none';
    logEl.textContent = `ring: ${log.selection ?? '-'}  |  route preview: ${p}  |  follow: ${log.follow ?? '-'}  |  focus: ${log.focus ?? '-'}  |  offer: ${log.offer ? log.offer.label + ' / ' + (log.offer.sub || '') : '-'}`;
  };
  const renderer = {
    update() {},
    onPick(h) { pickers.add(h); return () => pickers.delete(h); },
    setSelection(t) { log.selection = t; paint(); drawMap(); },
    setBuildOffer(o) { log.offer = o; paint(); drawMap(); },
    setRoutePreview(routes, active) { log.preview = routes && routes.length ? { routes, active: active || 'cheap' } : null; paint(); drawMap(); },
    focus(t) { log.focus = t; paint(); },
    follow(id) { log.follow = id; paint(); },
    dispose() {},
    // demo only
    pick(p) { for (const h of pickers) h(p); },
    log,
  };

  // A rough SVG map so clicking something feels like clicking the 3D view. Like the real view
  // it draws only built stations, tracks, upgrade tags, and (for the selected station) signposts.
  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const pos = (t) => { const p = game.placements.get(t); return hexToWorld(p.q, p.r); };
  function signposts() {
    const sel = log.selection && game.state.stations.get(log.selection);
    if (!sel) return [];
    return sel.article.leadLinks.filter((t) => game.placements.has(t) && !game.state.stations.has(t));
  }
  function drawMap() {
    mapEl.textContent = '';
    const svg = el('svg', { width: '100%', height: '100%' });
    svg.addEventListener('click', (e) => { if (e.target === svg) renderer.pick({ kind: 'none' }); });
    const g = el('g', { transform: `translate(${innerWidth * 0.5 - 120},${innerHeight * 0.5}) scale(26)` });
    const st = game.state;
    if (log.preview) {
      for (const r of log.preview.routes) {
        const pts = r.hexes.map((h) => { const w = hexToWorld(h.q, h.r); return `${w.x},${w.z}`; }).join(' ');
        g.append(el('polyline', { points: pts, fill: 'none', stroke: '#ffbf3f', 'stroke-width': 0.3, 'stroke-dasharray': '0.5 0.35' }));
      }
    }
    for (const tr of st.tracks) {
      const a = pos(tr.from), b = pos(tr.to);
      g.append(el('line', { x1: a.x, y1: a.z, x2: b.x, y2: b.z, stroke: tr.level ? '#e4572e' : '#3a2a1a', 'stroke-width': 0.28 }));
      // upgrade tags, like the ones the 3D view floats over each track
      const opts = game.upgradeOptions(tr);
      opts.forEach((o, i) => {
        const mx = (a.x + b.x) / 2 + (i - (opts.length - 1) / 2) * 3.4, my = (a.z + b.z) / 2 - 0.9;
        const tag = el('g', { style: 'cursor:pointer' });
        tag.append(el('rect', { x: mx - 1.6, y: my - 0.55, width: 3.2, height: 1.1, rx: 0.2, fill: o.affordable ? '#ffbf3f' : '#5a5a5a' }));
        const tx = el('text', { x: mx, y: my + 0.2, 'text-anchor': 'middle', 'font-size': 0.62, fill: '#1a1405', 'pointer-events': 'none' });
        tx.textContent = `${o.name} ${o.cost} gold`;
        tag.append(tx);
        tag.addEventListener('click', (e) => { e.stopPropagation(); renderer.pick({ kind: 'upgrade', trackId: tr.id, typeId: o.typeId }); });
        g.append(tag);
      });
      if (tr.trainId != null) {
        const tx = el('circle', { cx: (a.x + b.x) / 2, cy: (a.z + b.z) / 2, r: 0.55, fill: TRAIN_TYPES[tr.typeId].color, stroke: '#fff', 'stroke-width': 0.1, style: 'cursor:pointer' });
        tx.addEventListener('click', (e) => { e.stopPropagation(); renderer.pick({ kind: 'train', trainId: tr.trainId }); });
        g.append(tx);
      }
    }
    for (const [title, s] of st.stations) {
      const w = hexToWorld(s.q, s.r);
      const c = el('circle', {
        cx: w.x, cy: w.z, r: 0.85, fill: '#f7f2e4', stroke: title === log.selection ? '#ffbf3f' : '#1b2a44',
        'stroke-width': title === log.selection ? 0.3 : 0.12, style: 'cursor:pointer',
      });
      c.addEventListener('click', (e) => { e.stopPropagation(); renderer.pick({ kind: 'station', title }); });
      const tx = el('text', { x: w.x, y: w.z + 1.8, 'text-anchor': 'middle', 'font-size': 0.8, fill: '#10241a', 'pointer-events': 'none' });
      tx.textContent = title;
      g.append(c, tx);
      // the small floating article picture; a click opens the reader
      const card = el('rect', { x: w.x - 0.7, y: w.z - 2.5, width: 1.4, height: 1.0, rx: 0.1, fill: '#e8e2d0', stroke: '#1b2a44', 'stroke-width': 0.08, style: 'cursor:zoom-in' });
      card.addEventListener('click', (e) => { e.stopPropagation(); renderer.pick({ kind: 'article', title }); });
      g.append(card);
    }
    for (const title of signposts()) {
      const w = pos(title);
      const post = el('g', { style: 'cursor:pointer' });
      post.append(el('rect', { x: w.x - 2.4, y: w.z - 0.5, width: 4.8, height: 1, rx: 0.2, fill: title === log.selection ? '#ffbf3f' : '#17407a', stroke: '#fff', 'stroke-width': 0.08 }));
      const tx = el('text', { x: w.x, y: w.z + 0.22, 'text-anchor': 'middle', 'font-size': 0.5, fill: '#fff', 'pointer-events': 'none' });
      tx.textContent = title.length > 22 ? title.slice(0, 21) + '…' : title;
      post.append(tx);
      post.addEventListener('click', (e) => { e.stopPropagation(); renderer.pick({ kind: 'ghost', title }); });
      g.append(post);
    }
    if (log.offer && game.placements.has(log.offer.title)) {
      const o = log.offer, w = pos(o.title);
      const b = el('g', { style: 'cursor:pointer', opacity: o.affordable ? 1 : 0.7 });
      b.append(el('rect', { x: w.x - 3, y: w.z - 2.4, width: 6, height: 1.9, rx: 0.3, fill: o.affordable ? '#ffbf3f' : '#5a5a5a' }));
      const t1 = el('text', { x: w.x, y: w.z - 1.5, 'text-anchor': 'middle', 'font-size': 0.7, 'font-weight': 700, fill: '#1a1405', 'pointer-events': 'none' });
      t1.textContent = o.label;
      const t2 = el('text', { x: w.x, y: w.z - 0.8, 'text-anchor': 'middle', 'font-size': 0.45, fill: '#1a1405', 'pointer-events': 'none' });
      t2.textContent = o.sub || '';
      b.append(t1, t2);
      b.addEventListener('click', (e) => { e.stopPropagation(); renderer.pick({ kind: 'build', title: o.title }); });
      g.append(b);
    }
    svg.append(g);
    mapEl.append(svg);
  }
  renderer.redraw = drawMap;
  paint();
  return renderer;
}

// ------------------------------------------------------------------ boot

const mapEl = document.getElementById('map');
const log = document.getElementById('log');
const bar = document.getElementById('bar');
const game = createMockGame();
const renderer = createMockRenderer(game, mapEl, log);
const ui = createUI({ root: document.getElementById('ui'), game, renderer });
window.tot = { game, renderer, ui };

function drawBar() {
  bar.textContent = '';
  const add = (label, fn, cls) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    bar.append(b);
  };
  const lab = document.createElement('span');
  lab.textContent = 'Fake picks:';
  bar.append(lab);
  for (const title of game.state.stations.keys()) add(`● ${title}`, () => renderer.pick({ kind: 'station', title }));
  for (const title of game.state.stations.keys()) add(`article: ${title}`, () => renderer.pick({ kind: 'article', title }));
  const sel = renderer.log.selection;
  const st = sel && game.state.stations.get(sel);
  if (st) for (const t of st.article.leadLinks.filter((x) => game.placements.has(x) && !game.state.stations.has(x)).slice(0, 6)) add(`○ signpost: ${t}`, () => renderer.pick({ kind: 'ghost', title: t }));
  for (const tr of game.state.tracks) {
    for (const o of game.upgradeOptions(tr)) add(`tag: ${o.name} (track ${tr.id})`, () => renderer.pick({ kind: 'upgrade', trackId: tr.id, typeId: o.typeId }));
  }
  for (const t of game.state.trains) add(`train #${t.id}`, () => renderer.pick({ kind: 'train', trainId: t.id }));
  add('empty space', () => renderer.pick({ kind: 'none' }));
  const sp = document.createElement('span');
  sp.className = 'sp';
  bar.append(sp);
  add('+1000 gold', () => game.debug.cash(), 'dbg');
  add('finish ticket', () => game.debug.ticket(), 'dbg');
  add('finish goal', () => game.debug.finishGoal(), 'dbg');
  add('deliver one', () => game.debug.streak(), 'dbg');
  add('lose one', () => game.debug.lose(), 'dbg');
  add('payday now', () => game.debug.payday(), 'dbg');
  add('go bankrupt', () => game.debug.bankrupt(), 'dbg');
}
for (const ev of ['started', 'ghostsAdded', 'stationBuilt', 'trackBuilt', 'trackUpgraded', 'trainsChanged']) game.on(ev, () => { drawBar(); renderer.redraw(); });
const origSel = renderer.setSelection;
renderer.setSelection = (t) => { origSel(t); drawBar(); };
drawBar();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  game.update(dt);
  renderer.update(dt);
  ui.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
