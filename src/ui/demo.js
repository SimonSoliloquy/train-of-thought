// Standalone demo of the UI against a MOCK game and renderer (no wiki, world, sim or three.js).
// Open /ui-demo.html. Options: ?fresh (single starting station, for the first-run hints),
// ?skip (skip the start screen), ?fail (first start() rejects, to see the retry path).
import { createUI } from './index.js';
import { ECON, TRAIN_TYPES, LINE_COLORS } from '../config.js';
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
  const state = {
    phase: 'idle', time: 0, speed: 1, money: ECON.startMoney, score: 0, inflation: 1,
    incomePerMin: 0, upkeepPerMin: 0, faresPerMin: 0, delivered: 0, lost: 0, uniqueLinks: 0, bankruptIn: null,
    unlockedTrainTypes: ['local'], nextMilestone: { uniqueLinks: 400, unlock: 'express' },
    stations: new Map(), stubs: new Map(), tracks: [], lines: [], trains: [], thoughts: [],
  };
  const placements = new Map();
  let nextId = 1;
  let spawnIn = 8;
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
    if (total >= 400 && !state.unlockedTrainTypes.includes('express')) {
      state.unlockedTrainTypes = [...state.unlockedTrainTypes, 'express'];
      state.nextMilestone = { uniqueLinks: 1000, unlock: 'hauler' };
      if (state.phase === 'running') emit('milestone', { unlock: 'express', uniqueLinks: total });
    }
    state.incomePerMin = [...state.stations.values()].reduce((s, st) => s + st.incomePerMin, 0);
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
        if (style === 'cheap') { if ((i + salt) % 7 === 3) kind = 'ledge'; }
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

  const game = {
    state,
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
    async start() {
      state.phase = 'loading';
      await sleep(900);
      if (failFirst) {
        failFirst = false;
        state.phase = 'idle';
        throw new Error('Wikipedia did not answer (mock failure). Try again.');
      }
      addBuilt('Rail transport', 0, 0, null);
      ghostRing('Rail transport', 10);
      if (!params.has('fresh')) seedRichGame();
      state.phase = 'running';
      emit('started', { station: state.stations.get('Rail transport') });
      emit('toast', { text: 'Welcome aboard. Click your station to begin.', tone: 'info' });
    },
    update(dt) {
      if (state.phase !== 'running') return;
      const t = dt * state.speed;
      if (t <= 0) return;
      state.time += t;
      state.inflation = 1 + ECON.inflationRate * Math.pow(state.time / 60, ECON.inflationExponent);
      state.upkeepPerMin = (state.tracks.reduce((s, tr) => s + tr.route.length, 0) * ECON.trackUpkeepPerHexPerMin
        + state.trains.reduce((s, tr) => s + TRAIN_TYPES[tr.typeId].upkeepPerMin, 0)) * state.inflation;
      state.faresPerMin = state.trains.length ? 18 * state.trains.length + 4 * Math.sin(state.time / 7) : 0;
      state.money += ((state.incomePerMin + state.faresPerMin - state.upkeepPerMin) / 60) * t;
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
        const st = state.stations.get(th.from);
        if (st) st.waiting = st.waiting.filter((id) => id !== th.id);
        emit('thoughtLost', { thought: th });
      }
      for (const th of state.thoughts) {
        const frac = Math.max(0, th.patience / th.patienceMax);
        th.fare = Math.round(th.baseFare * (ECON.fareMinFraction + (1 - ECON.fareMinFraction) * frac));
      }
      for (const tr of state.trains) {
        if (Math.random() < t * 0.4) {
          const cap = TRAIN_TYPES[tr.typeId].capacity;
          tr.passengers = Array.from({ length: Math.floor(Math.random() * (cap + 1)) }, (_, i) => i);
        }
      }
      spawnIn -= t;
      if (spawnIn <= 0) { spawnIn = 14; spawnThought(); }
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
      const same = hash(from + to) % 5 === 0;
      if (same) return { ok: true, cheap, direct: { ...cheap, style: 'direct' }, same: true };
      return { ok: true, cheap, direct, same: false };
    },
    async build(from, to, style) {
      await sleep(500);
      const q = game.quoteBuild(from, to);
      if (!q.ok) return q;
      const pick = style === 'direct' ? q.direct : q.cheap;
      if (pick.total > state.money) return { ok: false, reason: `Not enough cash: ${pick.total} needed.` };
      state.money -= pick.total;
      const ghost = !state.stations.has(to);
      if (ghost) {
        const p = placements.get(to);
        p.state = 'built';
        addBuilt(to, p.q, p.r, from);
      }
      const track = { id: nextId++, from, to, route: pick.route };
      state.tracks.push(track);
      if (ghost) {
        emit('stationBuilt', { station: state.stations.get(to), track });
        ghostRing(to, 8);
      }
      emit('trackBuilt', { track });
      if (state.uniqueLinks >= 150) emit('toast', { text: `${to} added ${state.stations.get(to).uniqueLinks} unique links.`, tone: 'good' });
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
    createLine(stations) {
      const bad = checkLine(stations);
      if (bad) return bad;
      const line = { id: nextId++, name: `Line ${state.lines.length + 1}`, color: LINE_COLORS[state.lines.length % LINE_COLORS.length], stations: stations.slice(), trainIds: [] };
      state.lines.push(line);
      emit('linesChanged', {});
      return { ok: true, line };
    },
    setLineStations(lineId, stations) {
      const line = state.lines.find((l) => l.id === lineId);
      if (!line) return { ok: false, reason: 'That line no longer exists.' };
      const bad = checkLine(stations);
      if (bad) return bad;
      line.stations = stations.slice();
      emit('linesChanged', {});
      return { ok: true };
    },
    deleteLine(lineId) {
      const line = state.lines.find((l) => l.id === lineId);
      if (!line) return { ok: false, reason: 'That line no longer exists.' };
      for (const id of line.trainIds.slice()) removeTrain(id, false);
      remove(state.lines, line);
      emit('trainsChanged', {});
      emit('linesChanged', {});
      return { ok: true };
    },
    buyTrain(typeId, lineId) {
      const line = state.lines.find((l) => l.id === lineId);
      const type = TRAIN_TYPES[typeId];
      if (!line || !type) return { ok: false, reason: 'Unknown line or train type.' };
      const price = Math.round(type.cost * state.inflation);
      if (state.money < price) return { ok: false, reason: `A ${type.name} costs $${price}; you have $${Math.floor(state.money)}.` };
      state.money -= price;
      const track = game.trackBetween(line.stations[0], line.stations[1]);
      const train = { id: nextId++, typeId, lineId, state: 'moving', trackId: track ? track.id : 0, t: 0.2, forward: true, atStation: line.stations[0], passengers: [] };
      state.trains.push(train);
      line.trainIds.push(train.id);
      emit('trainsChanged', {});
      return { ok: true, train };
    },
    sellTrain(trainId) {
      if (!state.trains.some((t) => t.id === trainId)) return { ok: false, reason: 'That train is already gone.' };
      removeTrain(trainId, true);
      emit('trainsChanged', {});
      return { ok: true };
    },
    trackBetween(a, b) {
      return state.tracks.find((t) => (t.from === a && t.to === b) || (t.from === b && t.to === a)) || null;
    },
  };

  function checkLine(stations) {
    if (stations.length < 2) return { ok: false, reason: 'A line needs at least two stations.' };
    for (let i = 1; i < stations.length; i++) {
      if (!game.trackBetween(stations[i - 1], stations[i])) return { ok: false, reason: `No track joins ${stations[i - 1]} and ${stations[i]}.` };
    }
    return null;
  }
  function remove(arr, x) { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); }
  function removeTrain(id, refund) {
    const t = state.trains.find((x) => x.id === id);
    if (!t) return;
    remove(state.trains, t);
    const line = state.lines.find((l) => l.id === t.lineId);
    if (line) line.trainIds = line.trainIds.filter((x) => x !== id);
    if (refund) state.money += TRAIN_TYPES[t.typeId].cost * ECON.sellRefund;
  }

  function spawnThought() {
    const built = [...state.stations.keys()];
    const from = built[Math.floor(Math.random() * built.length)];
    const pool = ['Industrial Revolution', 'Maglev', 'James Watt', 'Diesel engine', 'Rapid transit', 'Thermodynamics', 'Tram', 'Boiler'];
    const to = pool[Math.floor(Math.random() * pool.length)];
    if (to === from) return;
    const hops = 2 + Math.floor(Math.random() * 3);
    const th = {
      id: nextId++, from, to, toDescription: (GHOST_STUBS[to] && GHOST_STUBS[to][1]) || (to === 'Industrial Revolution' ? 'Transition to new manufacturing processes, c. 1760-1840' : ''),
      hops, fare: 0, baseFare: Math.round(ECON.fareBase + ECON.farePerHop * Math.pow(hops, ECON.fareHopExponent)),
      patience: ECON.patienceBase + ECON.patiencePerHop * hops, patienceMax: ECON.patienceBase + ECON.patiencePerHop * hops,
      state: 'waiting', at: from, trainId: null,
    };
    th.fare = th.baseFare;
    state.thoughts.push(th);
    state.stations.get(from).waiting.push(th.id);
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
    const t1 = { id: nextId++, from: 'Rail transport', to: 'Locomotive', route: makeRoute('Rail transport', 'Locomotive', 'cheap') };
    const t2 = { id: nextId++, from: 'Locomotive', to: 'Steam engine', route: makeRoute('Locomotive', 'Steam engine', 'direct') };
    state.tracks.push(t1, t2);
    state.money = 840;
    state.time = 190;
    state.delivered = 7;
    const res = game.createLine(['Rail transport', 'Locomotive', 'Steam engine']);
    game.buyTrain('local', res.line.id);
    game.buyTrain('local', res.line.id);
    state.money = 840;
    const mk = (from, to, desc, hops, patience) => {
      const th = {
        id: nextId++, from, to, toDescription: desc, hops, baseFare: 15 + 20 * Math.pow(hops, 1.4), fare: 0,
        patience, patienceMax: 150 + 60 * hops, state: 'waiting', at: from, trainId: null,
      };
      th.fare = th.baseFare;
      state.thoughts.push(th);
      state.stations.get(from).waiting.push(th.id);
    };
    mk('Rail transport', 'Industrial Revolution', 'Transition to new manufacturing processes, c. 1760-1840', 3, 190);
    mk('Rail transport', 'Steam engine', 'Engine that performs mechanical work using steam as its working fluid', 1, 70);
    mk('Locomotive', 'Maglev', 'Train system using magnetic levitation', 2, 140);
    mk('Steam engine', 'Diesel locomotive', 'Locomotive powered by a diesel engine', 2, 38);
    mk('Locomotive', 'Cheese', '', 4, 300);
    state.trains[0].passengers = [1];
    const riding = state.thoughts[1];
    riding.state = 'riding';
    riding.trainId = state.trains[0].id;
  }

  game.placements = placements;
  game.debug = {
    bankrupt() { state.money = -100; negFor = ECON.bankruptcyGraceSeconds - 8; },
    unlock() { state.unlockedTrainTypes = ['local', 'express']; state.nextMilestone = { uniqueLinks: 1000, unlock: 'hauler' }; emit('milestone', { unlock: 'express', uniqueLinks: 400 }); },
    cash() { state.money += 1000; },
  };
  return game;
}

// ------------------------------------------------------------------ mock renderer

function createMockRenderer(game, mapEl, logEl) {
  const pickers = new Set();
  const log = { selection: null, preview: null, highlight: null, follow: null, focus: null };
  const paint = () => {
    const p = log.preview ? `${log.preview.routes.length} route(s), active ${log.preview.active}` : 'none';
    logEl.textContent = `selection: ${log.selection ?? '-'}  |  preview: ${p}  |  line highlight: ${log.highlight ?? '-'}  |  follow: ${log.follow ?? '-'}  |  focus: ${log.focus ?? '-'}`;
  };
  const renderer = {
    update() {},
    onPick(h) { pickers.add(h); return () => pickers.delete(h); },
    setSelection(t) { log.selection = t; paint(); drawMap(); },
    setRoutePreview(routes, active) { log.preview = routes && routes.length ? { routes, active: active || 'cheap' } : null; paint(); },
    setLineHighlight(id) { log.highlight = id; paint(); },
    focus(t) { log.focus = t; paint(); },
    follow(id) { log.follow = id; paint(); },
    dispose() {},
    // demo only
    pick(p) { for (const h of pickers) h(p); },
  };

  // A rough SVG map so clicking something feels like clicking the 3D view.
  const NS = 'http://www.w3.org/2000/svg';
  function drawMap() {
    mapEl.textContent = '';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.addEventListener('click', (e) => { if (e.target === svg) renderer.pick({ kind: 'none' }); });
    const g = document.createElementNS(NS, 'g');
    const cx = innerWidth * 0.5 - 120, cy = innerHeight * 0.5;
    g.setAttribute('transform', `translate(${cx},${cy}) scale(26)`);
    const pos = (t) => { const p = game.placements.get(t); return hexToWorld(p.q, p.r); };
    for (const tr of game.state.tracks) {
      const a = pos(tr.from), b = pos(tr.to);
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', a.x); l.setAttribute('y1', a.z); l.setAttribute('x2', b.x); l.setAttribute('y2', b.z);
      l.setAttribute('stroke', '#3a2a1a'); l.setAttribute('stroke-width', '0.28');
      g.append(l);
    }
    for (const [title, p] of game.placements) {
      const w = hexToWorld(p.q, p.r);
      const built = p.state === 'built';
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', w.x); c.setAttribute('cy', w.z); c.setAttribute('r', built ? 0.8 : 0.55);
      c.setAttribute('fill', built ? '#f7f2e4' : 'rgba(255,255,255,0.25)');
      c.setAttribute('stroke', title === log.selection ? '#ffbf3f' : built ? '#1b2a44' : '#ffffff');
      c.setAttribute('stroke-width', title === log.selection ? 0.28 : 0.12);
      c.style.cursor = 'pointer';
      c.addEventListener('click', (e) => { e.stopPropagation(); renderer.pick({ kind: built ? 'station' : 'ghost', title }); });
      const tx = document.createElementNS(NS, 'text');
      tx.setAttribute('x', w.x); tx.setAttribute('y', w.z + 1.7); tx.setAttribute('text-anchor', 'middle');
      tx.setAttribute('font-size', '0.8'); tx.setAttribute('fill', '#10241a'); tx.setAttribute('pointer-events', 'none');
      tx.textContent = title;
      g.append(c, tx);
    }
    svg.append(g);
    mapEl.append(svg);
  }
  renderer.redraw = drawMap;
  paint();
  return renderer;
}

// ------------------------------------------------------------------ boot

const view = document.getElementById('view');
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
  lab.textContent = 'Fake map pick:';
  bar.append(lab);
  for (const [title, p] of game.placements) {
    add(`${p.state === 'built' ? '●' : '○'} ${title}`, () => renderer.pick({ kind: p.state === 'built' ? 'station' : 'ghost', title }));
  }
  for (const t of game.state.trains) add(`train #${t.id}`, () => renderer.pick({ kind: 'train', trainId: t.id }));
  add('empty space', () => renderer.pick({ kind: 'none' }));
  const sp = document.createElement('span');
  sp.className = 'sp';
  bar.append(sp);
  add('+$1000', () => game.debug.cash(), 'dbg');
  add('unlock Express', () => game.debug.unlock(), 'dbg');
  add('go bankrupt', () => game.debug.bankrupt(), 'dbg');
}
for (const ev of ['started', 'ghostsAdded', 'stationBuilt', 'trainsChanged']) game.on(ev, () => { drawBar(); renderer.redraw(); });
game.on('trackBuilt', () => renderer.redraw());
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

if (params.has('skip')) game.start();
