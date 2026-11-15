// A small MOCK world + game that satisfy the contract in src/types.js, used by the
// standalone render demo and by the Node smoke tests. No DOM, no three.js.
import { WORLD, ECON, TRAIN_TYPES } from '../config.js';
import { hexToWorld, worldToHex, hexKey, hexSpiral, hexDistance, hexRound, hashString, mulberry32 } from '../hex.js';

// ------------------------------------------------------------ noise

function lattice(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = lattice(ix, iz, seed), b = lattice(ix + 1, iz, seed);
  const c = lattice(ix, iz + 1, seed), d = lattice(ix + 1, iz + 1, seed);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
}

function fbm(x, z, seed, oct = 4) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += valueNoise(x * f, z * f, seed + i * 31) * amp; norm += amp; amp *= 0.5; f *= 2; }
  return s / norm;
}

const q4 = (v) => Math.round(v * 4) / 4;

/** Deterministic mock terrain: grassland centre, river to the south, ridge to the north,
 *  canyon north-east, desert east, jungle south-west, forest west. */
export function mockTerrain(q, r, seed = 7) {
  const { x, z } = hexToWorld(q, r);
  const n = fbm(x * 0.12, z * 0.12, seed);
  const detail = lattice(q, r, seed + 99);
  const riverZ = 4.6 + 2.2 * Math.sin(x * 0.17) + 1.2 * Math.sin(x * 0.07 + 1);
  const dRiver = Math.abs(z - riverZ);
  const ridgeZ = -9 + 2.2 * Math.sin(x * 0.15 + 0.5);
  const dRidge = Math.abs(z - ridgeZ);
  let biome = 'grassland';
  let elevation = 0.5 + n * 0.8;
  let water = false;
  if (x > 7 && z < -2.5 && dRidge > 2) {
    biome = 'canyon';
    // stepped mesas: terraces by noise
    elevation = 0.75 + Math.floor(n * 4) * 0.5;
  } else if (x > 10) {
    biome = 'desert';
    elevation = 0.4 + n * 0.5;
  } else if (x < -5 && z > 6.5) {
    biome = 'jungle';
    elevation = 0.4 + n * 0.7;
  } else if (x < -4 && z < 2) {
    biome = 'forest';
    elevation = 0.7 + n * 1.2;
  }
  if (dRidge < 3.4) {
    biome = 'mountains';
    const k = 1 - dRidge / 3.4;
    elevation = Math.max(elevation, 0.9 + Math.pow(k, 0.8) * (WORLD.maxElevation - 0.9) * (0.75 + n * 0.35));
  }
  if (dRiver < 3.3 && biome !== 'mountains' && biome !== 'canyon') {
    if (biome === 'grassland' || dRiver < 2) biome = 'riverlands';
    elevation = Math.min(elevation, 0.3 + dRiver * 0.18);
  }
  if (dRiver < 0.95 && x > -30) {
    water = true;
    biome = biome === 'desert' ? 'desert' : 'riverlands';
    elevation = 0.2;
  }
  elevation = Math.max(0, Math.min(WORLD.maxElevation, q4(elevation)));
  if (water) elevation = 0.2;
  return { q, r, biome, elevation, water, detail };
}

// ------------------------------------------------------------ routes

function hexLine(a, b) {
  const N = hexDistance(a, b);
  const out = [];
  for (let i = 0; i <= N; i++) {
    const t = N === 0 ? 0 : i / N;
    out.push(hexRound(a.q + (b.q - a.q) * t + 1e-6, a.r + (b.r - a.r) * t + 1e-6));
  }
  return out;
}

function dedupe(path) {
  const out = [];
  for (const h of path) if (!out.length || hexKey(out[out.length - 1].q, out[out.length - 1].r) !== hexKey(h.q, h.r)) out.push(h);
  return out;
}

/**
 * Build a Route along the given hex path (inclusive of both ends).
 * Kinds: water -> bridge; high mountain between low ends -> tunnel; steep sides -> ledge.
 */
export function makeRoute(from, to, path, terrainAt, style = 'direct') {
  const tiles = path.map((h) => terrainAt(h.q, h.r));
  const endE = Math.max(tiles[0].elevation, tiles[tiles.length - 1].elevation);
  const hexes = path.map((h, i) => {
    const t = tiles[i];
    let kind = 'ground';
    if (i > 0 && i < path.length - 1) {
      if (t.water) kind = 'bridge';
      else if (t.biome === 'mountains' && t.elevation > endE + 1.2) kind = 'tunnel';
      else {
        let lo = Infinity, hi = -Infinity;
        for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
          const n = terrainAt(h.q + dq, h.r + dr);
          lo = Math.min(lo, n.water ? n.elevation - 0.4 : n.elevation);
          hi = Math.max(hi, n.elevation);
        }
        if (hi - lo >= 1.0 && t.elevation - lo >= 0.5) kind = 'ledge';
      }
    }
    return { q: h.q, r: h.r, kind };
  });
  // base rail heights per hex
  const RAIL = 0.1;
  const ys = tiles.map((t) => t.elevation + RAIL);
  // bridges: level deck over the water at the higher bank + clearance
  for (let i = 0; i < hexes.length; i++) {
    if (hexes[i].kind !== 'bridge') continue;
    let j = i; while (j < hexes.length && hexes[j].kind === 'bridge') j++;
    const bank = Math.max(ys[i - 1] ?? ys[i], ys[j] ?? ys[i]);
    for (let k = i; k < j; k++) ys[k] = bank + 0.25;
    i = j - 1;
  }
  // tunnels: straight grade between the portals
  for (let i = 0; i < hexes.length; i++) {
    if (hexes[i].kind !== 'tunnel') continue;
    let j = i; while (j < hexes.length && hexes[j].kind === 'tunnel') j++;
    const a = ys[i - 1], b = ys[j];
    for (let k = i; k < j; k++) ys[k] = a + (b - a) * ((k - i + 1) / (j - i + 1));
    i = j - 1;
  }
  // centreline through hex centres, then Chaikin smoothing carrying (y, u)
  let pts = path.map((h, i) => { const w = hexToWorld(h.q, h.r); return { x: w.x, y: ys[i], z: w.z, u: i }; });
  for (let it = 0; it < 3; it++) {
    const next = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const lerp = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, u: a.u + (b.u - a.u) * t });
      next.push(lerp(0.25), lerp(0.75));
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  // resample to ~8 points per hex
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
  const total = cum[cum.length - 1];
  const n = Math.max(2, (path.length - 1) * 8 + 1);
  const points = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = (i / (n - 1)) * total;
    while (j + 1 < cum.length - 1 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const f = Math.min(1, Math.max(0, (d - cum[j]) / seg));
    const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
    const u = a.u + (b.u - a.u) * f;
    const hk = hexes[Math.min(hexes.length - 1, Math.max(0, Math.round(u)))].kind;
    points.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, kind: hk });
  }
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y, points[i].z - points[i - 1].z);
  const cost = hexes.reduce((s, h) => s + (ECON.trackCostPerHex[h.kind] || 10), 0);
  return { from, to, style, hexes, points, length, cost };
}

// ------------------------------------------------------------ mock world

export const MOCK_STATIONS = [
  { title: 'Locomotive', q: 0, r: 0, pop: 0.8 },
  { title: 'Iron Bridge', q: -3, r: 6, pop: 0.55 },
  { title: 'Simplon Tunnel', q: 4, r: -9, pop: 0.7 },
  { title: 'Grand Canyon', q: 7, r: -4, pop: 0.9 },
  { title: 'Sahara', q: 9, r: 1, pop: 0.6 },
  { title: 'Amazon rainforest', q: -8, r: 9, pop: 0.75 },
  { title: 'Black Forest', q: -6, r: -1, pop: 0.4 },
];

export const MOCK_GHOSTS = [
  { title: 'Steam engine', q: 3, r: 3, parent: 'Locomotive' },
  { title: 'Rail transport', q: -2, r: -4, parent: 'Locomotive' },
  { title: 'Danube', q: 4, r: 6, parent: 'Iron Bridge' },
  { title: 'Matterhorn', q: 9, r: -10, parent: 'Simplon Tunnel' },
  { title: 'Colorado River', q: 11, r: -6, parent: 'Grand Canyon' },
  { title: 'Oasis', q: 12, r: 3, parent: 'Sahara' },
  { title: 'Jaguar', q: -12, r: 12, parent: 'Amazon rainforest' },
  { title: 'Cuckoo clock', q: -10, r: -3, parent: 'Black Forest' },
];

export const MOCK_TRACKS = [
  ['Locomotive', 'Iron Bridge'],
  ['Locomotive', 'Simplon Tunnel'],
  ['Locomotive', 'Grand Canyon'],
  ['Grand Canyon', 'Sahara'],
  ['Iron Bridge', 'Amazon rainforest'],
  ['Locomotive', 'Black Forest'],
];

export function createMockWorld({ seed = 7 } = {}) {
  const cache = new Map();
  const revealed = new Map();
  const placements = new Map();
  const terrainAt = (q, r) => {
    const k = hexKey(q, r);
    let t = cache.get(k);
    if (!t) { t = Object.freeze(mockTerrain(q, r, seed)); cache.set(k, t); }
    return t;
  };
  const reveal = (q, r, radius) => {
    const out = [];
    for (const h of hexSpiral(q, r, radius)) {
      const k = hexKey(h.q, h.r);
      if (revealed.has(k)) continue;
      const t = terrainAt(h.q, h.r);
      revealed.set(k, t);
      out.push(t);
    }
    return out;
  };
  const posOf = (title) => {
    const p = placements.get(title);
    if (!p) throw new Error(`not placed: ${title}`);
    return p;
  };
  const world = {
    placements,
    terrainAt,
    isRevealed: (q, r) => revealed.has(hexKey(q, r)),
    revealedTiles: () => [...revealed.values()],
    placeStart(title) {
      const s = MOCK_STATIONS.find((m) => m.title === title) || { q: 0, r: 0 };
      const placement = { title, q: s.q, r: s.r, state: 'built', parent: null };
      placements.set(title, placement);
      return { placement, revealed: reveal(s.q, s.r, WORLD.revealStation + 1) };
    },
    placeGhosts(parentTitle, titles) {
      const out = [], rev = [];
      for (const t of titles) {
        if (placements.has(t)) continue;
        const def = [...MOCK_STATIONS, ...MOCK_GHOSTS].find((m) => m.title === t);
        if (!def) continue;
        const p = { title: t, q: def.q, r: def.r, state: 'ghost', parent: parentTitle };
        placements.set(t, p);
        out.push(p);
        rev.push(...reveal(def.q, def.r, WORLD.revealGhost));
      }
      return { placements: out, revealed: rev };
    },
    setBuilt(title) {
      const p = posOf(title);
      p.state = 'built';
      return { revealed: reveal(p.q, p.r, WORLD.revealStation) };
    },
    findRoutes(fromTitle, toTitle) {
      const a = posOf(fromTitle), b = posOf(toTitle);
      const direct = makeRoute(fromTitle, toTitle, dedupe(hexLine(a, b)), terrainAt, 'direct');
      // cheap: bend through a waypoint off to one side
      const mid = { q: Math.round((a.q + b.q) / 2), r: Math.round((a.r + b.r) / 2) };
      const off = { q: mid.q + Math.round((b.r - a.r) * 0.35), r: mid.r - Math.round((b.q - a.q) * 0.35) };
      const path = dedupe([...hexLine(a, off), ...hexLine(off, b).slice(1)]);
      const cheap = makeRoute(fromTitle, toTitle, path, terrainAt, 'cheap');
      return { cheap, direct, same: false };
    },
    commitRoute(route) {
      const rev = [];
      for (const h of route.hexes) rev.push(...reveal(h.q, h.r, WORLD.revealTrack));
      return { revealed: rev };
    },
    _reveal: reveal,
  };
  return world;
}

// ------------------------------------------------------------ mock game

/** Lead links: the station's own ghosts and its track neighbours; links: those plus every other mock title. */
export function mockLinks(title) {
  const lead = [
    ...MOCK_GHOSTS.filter((g) => g.parent === title).map((g) => g.title),
    ...MOCK_TRACKS.filter(([a, b]) => a === title || b === title).map(([a, b]) => (a === title ? b : a)),
  ];
  const links = [...lead];
  for (const m of [...MOCK_GHOSTS, ...MOCK_STATIONS]) if (m.title !== title && !links.includes(m.title)) links.push(m.title);
  return { leadLinks: lead, links };
}

// Starting levels of the mock tracks once the network is built: bare, local, express
// (offering the final choice), freight and bullet, so every tag and train shows up.
export const MOCK_START_LEVELS = [2, 1, 3, 3, 0, 1];
const FINALS = ['freight', 'bullet'];

export function createMockGame({ world, buildInterval = 1.1, money = 400 }) {
  const handlers = new Map();
  const emit = (name, payload) => { for (const h of handlers.get(name) || []) h(payload); };
  const state = {
    phase: 'idle', time: 0, speed: 1, money, score: 0, inflation: 1,
    payday: { period: ECON.paydaySeconds, in: ECON.paydaySeconds, income: 0, fares: 0, upkeep: 0, pending: 0, forecast: 0, last: null },
    delivered: 0, lost: 0, reputation: 0.5, uniqueLinks: 0, bankruptIn: null,
    goal: null, streak: 0, tickets: [],
    stations: new Map(), stubs: new Map(), tracks: [], trains: [], thoughts: [],
  };
  // goals: the tutorial's "put a train on a track", then deliveries that grow
  const GOALS = [
    { id: 'first-train', text: 'Put a train on a track', how: 'Click "Add train" over a track', target: 1, reward: 100 },
    { id: 'deliver-5', text: 'Deliver 5 passengers', how: 'Trains carry them for you', target: 5, reward: 150 },
    { id: 'deliver-15', text: 'Deliver 15 passengers', how: 'Upgrade busy tracks', target: 15, reward: 250 },
  ];
  let goalIndex = 0;
  const makeGoal = (i) => (GOALS[i] ? { ...GOALS[i], progress: 0 } : null);
  state.goal = makeGoal(0);
  function advanceGoal(amount = 1) {
    const g = state.goal;
    if (!g) return;
    g.progress = Math.min(g.target, g.progress + amount);
    if (g.progress < g.target) return;
    state.money += g.reward;
    goalIndex++;
    state.goal = makeGoal(goalIndex);
    emit('goalDone', { goal: g, reward: g.reward, next: state.goal });
  }
  let nextId = 1;
  let timeline = 0;
  let built = 1;
  let spawnT = 1.5, deliverT = 3;
  const runs = new Map(); // trainId -> {dwell}
  const rnd = mulberry32(99);

  const stub = (title, pop) => ({ title, kind: 'article', description: '', popularity: pop });
  for (const m of MOCK_STATIONS) state.stubs.set(m.title, stub(m.title, m.pop));
  for (const g of MOCK_GHOSTS) state.stubs.set(g.title, stub(g.title, (hashString(g.title) % 100) / 100));

  // tickets: a built start -> an unbuilt end, then an unbuilt start -> an unbuilt end
  const TICKET_POOL = [
    { from: 'Locomotive', to: 'Steam engine', links: 1, reward: 650 },
    { from: 'Rail transport', to: 'Danube', links: 3, reward: 900 },
    { from: 'Grand Canyon', to: 'Colorado River', links: 1, reward: 500 },
    { from: 'Sahara', to: 'Oasis', links: 1, reward: 480 },
  ];
  let ticketNext = 0, ticketId = 1;
  function addTicket() {
    if (state.tickets.length >= 3 || ticketNext >= TICKET_POOL.length) return;
    const t = { id: ticketId++, fromDescription: '', toDescription: '', time: 300, timeMax: 300, ...TICKET_POOL[ticketNext++] };
    state.tickets.push(t);
    emit('ticketAdded', { ticket: t });
  }
  function checkTickets(builtTitle) {
    for (const t of [...state.tickets]) {
      if (t.to !== builtTitle || !state.stations.has(t.from) || !trackBetween(t.from, t.to)) continue;
      state.tickets.splice(state.tickets.indexOf(t), 1);
      state.money += t.reward;
      emit('ticketDone', { ticket: t, reward: t.reward });
      addTicket();
    }
  }
  /** Thumbnails to exercise every case: a picture, none, and one that fails to load. */
  function mockThumbnail(title) {
    const h = hashString(title) % 3;
    if (title === 'Sahara') return 'https://upload.wikimedia.org/does-not-exist.jpg';
    if (h === 1) return null;
    const hue = hashString(title) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect width="200" height="150" fill="hsl(${hue},55%,60%)"/><circle cx="60" cy="50" r="28" fill="hsl(${hue},70%,85%)"/><path d="M0 150 L70 70 L120 120 L160 80 L200 150Z" fill="hsl(${hue},45%,32%)"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  function addStation(title) {
    const p = world.placements.get(title);
    const s = MOCK_STATIONS.find((m) => m.title === title);
    const pop = s ? s.pop : (state.stubs.get(title) ? state.stubs.get(title).popularity : 0.5);
    const st = {
      title, article: { ...stub(title, pop), summary: '', thumbnail: mockThumbnail(title), url: '', ...mockLinks(title) },
      q: p.q, r: p.r, uniqueLinks: 40, incomePerMin: 2, waiting: [], builtAt: state.time,
    };
    state.stations.set(title, st);
    return st;
  }

  function trackBetween(a, b) {
    return state.tracks.find((t) => (t.from === a && t.to === b) || (t.from === b && t.to === a)) || null;
  }

  function optionsFor(track) {
    const types = track.level === 0 ? ['local'] : track.level === 1 ? ['express'] : track.level === 2 ? FINALS : [];
    return types.map((id) => {
      const T = TRAIN_TYPES[id];
      const cost = Math.round(T.cost * state.inflation);
      return { typeId: id, name: T.name, blurb: T.blurb, cost, affordable: state.money >= cost };
    });
  }

  /** Put a train of typeId on the track (replacing its old one), free of charge. */
  function setTrain(track, typeId) {
    const old = state.trains.find((t) => t.trackId === track.id);
    const id = nextId++;
    const train = {
      id, typeId, trackId: track.id, state: 'dwelling',
      t: old ? old.t : 0, forward: old ? old.forward : true, atStation: old ? old.atStation : track.from, passengers: [],
    };
    if (old) { state.trains = state.trains.filter((t) => t !== old); runs.delete(old.id); }
    state.trains.push(train);
    runs.set(id, { dwell: 0.6 });
    track.level = typeId === 'local' ? 1 : typeId === 'express' ? 2 : 3;
    track.typeId = typeId;
    track.trainId = id;
    return train;
  }

  const game = {
    state,
    on(name, h) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(h);
      return () => handlers.get(name).delete(h);
    },
    async start() {
      state.phase = 'running';
      const first = MOCK_STATIONS[0].title;
      const { revealed } = world.placeStart(first);
      const st = addStation(first);
      emit('started', { station: st });
      emit('tilesRevealed', { tiles: revealed });
      const gs = world.placeGhosts(first, [...MOCK_STATIONS.slice(1).map((m) => m.title), ...MOCK_GHOSTS.map((g) => g.title)]);
      emit('ghostsAdded', { placements: gs.placements });
      if (gs.revealed.length) emit('tilesRevealed', { tiles: gs.revealed });
      addTicket(); addTicket();
    },
    quoteBuild(fromTitle, toTitle) {
      if (state.phase !== 'running') return { ok: false, reason: 'The game is not running.' };
      if (!state.stations.has(fromTitle)) return { ok: false, reason: 'Track must start at a built station.' };
      if (!world.placements.has(toTitle)) return { ok: false, reason: 'That article is not on the map yet.' };
      if (trackBetween(fromTitle, toTitle)) return { ok: false, reason: 'Track already joins these stations.' };
      let routes;
      try { routes = world.findRoutes(fromTitle, toTitle); } catch { return { ok: false, reason: 'No route can be found there.' }; }
      const stubTo = state.stubs.get(toTitle);
      const stationCost = state.stations.has(toTitle) ? 0 : Math.round((ECON.stationBaseCost + (stubTo ? stubTo.popularity : 0.5) * ECON.stationPopularityCost) * state.inflation);
      const mk = (style, route) => {
        const trackCost = Math.round(route.cost * state.inflation);
        const total = trackCost + stationCost;
        return { style, route, trackCost, stationCost, total, affordable: total <= state.money };
      };
      return { ok: true, cheap: mk('cheap', routes.cheap), direct: mk('direct', routes.direct), same: !!routes.same };
    },
    /** Builds at once (no article to load). Pays a route bonus when passengers were waiting for it. */
    async build(fromTitle, toTitle, style = 'cheap') {
      const q = game.quoteBuild(fromTitle, toTitle);
      if (!q.ok) return q;
      const quote = q[style] || q.cheap;
      if (!quote.affordable) return { ok: false, reason: `Not enough money: that costs ${quote.total}.` };
      state.money -= quote.total;
      const route = quote.route;
      const track = { id: nextId++, from: fromTitle, to: toTitle, route, level: 0, typeId: null, trainId: null };
      state.tracks.push(track);
      const r1 = world.commitRoute(route);
      const fresh = !state.stations.has(toTitle);
      const r2 = fresh ? world.setBuilt(toTitle) : { revealed: [] };
      const st = fresh ? addStation(toTitle) : state.stations.get(toTitle);
      emit('tilesRevealed', { tiles: [...r1.revealed, ...r2.revealed] });
      if (fresh) emit('stationBuilt', { station: st, track });
      emit('trackBuilt', { track });
      const waiting = state.thoughts.filter((t) => t.state === 'waiting' && t.to === toTitle);
      if (fresh && waiting.length) {
        const amount = Math.round(waiting.reduce((a, t) => a + t.fare, 0) * ECON.routeBonusFraction);
        state.money += amount;
        emit('routeBonus', { station: toTitle, count: waiting.length, amount });
      }
      checkTickets(toTitle);
      return { ok: true };
    },
    quoteUpgrade(trackId) {
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return { ok: false, reason: 'No such track.' };
      const options = optionsFor(track);
      if (!options.length) return { ok: false, reason: 'This track is fully upgraded.' };
      return { ok: true, options };
    },
    upgradeTrack(trackId, typeId) {
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return { ok: false, reason: 'No such track.' };
      const options = optionsFor(track);
      const opt = typeId ? options.find((o) => o.typeId === typeId) : options.length === 1 ? options[0] : null;
      if (!opt) return { ok: false, reason: 'That upgrade is not on offer.' };
      if (!opt.affordable) return { ok: false, reason: 'Not enough gold yet.' };
      state.money -= opt.cost;
      const wasBare = track.level === 0;
      const train = setTrain(track, opt.typeId);
      emit('trackUpgraded', { track, train });
      emit('trainsChanged', {});
      if (wasBare && state.goal && state.goal.id === 'first-train') advanceGoal(1);
      return { ok: true };
    },
    update(dtReal) {
      if (state.phase !== 'running') return;
      const dt = dtReal * state.speed;
      state.time += dt;
      timeline += dt;
      state.payday.in -= dt;
      if (state.payday.in <= 0) {
        state.payday.in += state.payday.period;
        const amount = 25;
        state.money += amount;
        state.payday.last = { amount, income: amount, fares: 0, upkeep: 0, time: state.time };
        emit('payday', { amount, income: amount, fares: 0, upkeep: 0 });
      }
      // build the network over the first seconds
      if (built < MOCK_STATIONS.length && timeline >= built * buildInterval) {
        const [from, to] = MOCK_TRACKS[built - 1];
        const routes = world.findRoutes(from, to);
        const route = routes.direct;
        const track = { id: nextId++, from, to, route, level: 0, typeId: null, trainId: null };
        state.tracks.push(track);
        const r1 = world.commitRoute(route);
        const r2 = world.setBuilt(to);
        const st = addStation(to);
        emit('tilesRevealed', { tiles: [...r1.revealed, ...r2.revealed] });
        emit('stationBuilt', { station: st, track });
        emit('trackBuilt', { track });
        built++;
        if (built === MOCK_STATIONS.length) {
          state.tracks.forEach((tr, i) => {
            const lvl = MOCK_START_LEVELS[i] || 0;
            if (lvl >= 1) setTrain(tr, lvl === 1 ? 'local' : lvl === 2 ? 'express' : FINALS[i % 2]);
          });
          emit('trainsChanged', {});
        }
      }
      // each train shuttles along its own track
      for (const train of state.trains) {
        const run = runs.get(train.id);
        const tr = state.tracks.find((t) => t.id === train.trackId);
        if (!run || !tr) continue;
        if (run.dwell > 0) { run.dwell -= dt; train.state = 'dwelling'; continue; }
        train.state = 'moving';
        const step = (TRAIN_TYPES[train.typeId].speed * dt) / tr.route.length;
        train.t += train.forward ? step : -step;
        if (train.t >= 1 || train.t <= 0) {
          train.t = train.t >= 1 ? 1 : 0;
          train.atStation = train.t === 1 ? tr.to : tr.from;
          train.forward = !train.forward;
          train.state = 'dwelling';
          run.dwell = ECON.dwellSeconds;
        }
      }
      // thoughts appear and get delivered
      spawnT -= dt;
      if (spawnT <= 0 && state.stations.size) {
        spawnT = 0.8 + rnd() * 1.4;
        const list = [...state.stations.values()];
        const st = list[Math.floor(rnd() * list.length)];
        if (st.waiting.length < ECON.maxWaitingPerStation) {
          const pm = 40 + rnd() * 60;
          // about half want an unbuilt link (so signposts show who is waiting for them)
          const ghosts = [...world.placements.values()].filter((p) => p.state === 'ghost').map((p) => p.title);
          const to = ghosts.length && rnd() < 0.55 ? ghosts[Math.floor(rnd() * Math.min(ghosts.length, 4))] : 'Somewhere';
          const th = { id: nextId++, from: st.title, to, toDescription: '', hops: 2, fare: 25 + Math.round(rnd() * 60), patience: pm, patienceMax: pm, state: 'waiting', at: st.title, trainId: null };
          state.thoughts.push(th);
          st.waiting.push(th.id);
          emit('thoughtSpawned', { thought: th });
        }
      }
      for (const th of state.thoughts) th.patience = Math.max(0, th.patience - dt);
      // passengers who ran out of patience give up (and break the streak)
      for (const th of state.thoughts.filter((t) => t.state === 'waiting' && t.patience <= 0)) {
        state.thoughts = state.thoughts.filter((t) => t !== th);
        const st = state.stations.get(th.at);
        if (st) st.waiting = st.waiting.filter((id) => id !== th.id);
        state.lost++;
        state.streak = 0;
        emit('thoughtLost', { thought: { ...th, state: 'lost' } });
      }
      deliverT -= dt;
      if (deliverT <= 0) {
        deliverT = 1.5 + rnd() * 2;
        // only passengers bound for somewhere already built get delivered
        const list = [...state.stations.values()].filter((s) => s.waiting.some((id) => { const t = state.thoughts.find((x) => x.id === id); return t && t.to === 'Somewhere'; }));
        if (list.length) {
          const st = list[Math.floor(rnd() * list.length)];
          const idx = st.waiting.findIndex((id) => { const t = state.thoughts.find((x) => x.id === id); return t && t.to === 'Somewhere'; });
          const id = st.waiting.splice(idx, 1)[0];
          const th = state.thoughts.find((t) => t.id === id);
          state.thoughts = state.thoughts.filter((t) => t.id !== id);
          state.delivered++;
          const dest = [...state.stations.keys()][Math.floor(rnd() * state.stations.size)];
          if (th) {
            state.streak++;
            const fare = Math.round(th.fare * (1 + Math.min(ECON.streakFareMax, ECON.streakFarePerStep * state.streak)));
            state.payday.fares += fare;
            emit('thoughtDelivered', { thought: { ...th, state: 'delivered' }, fare, station: dest, streak: state.streak });
            if (state.goal && state.goal.id.startsWith('deliver')) advanceGoal(1);
          }
        }
      }
    },
    setSpeed(s) { state.speed = s; },
    trackBetween,
    _emit: emit,
  };
  return game;
}

/** Reveal a big disc (performance test). Returns the new tiles. */
export function revealDisc(world, radius) {
  return world._reveal(0, 0, radius);
}

export { worldToHex };
