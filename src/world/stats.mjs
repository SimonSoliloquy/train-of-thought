// Route and layout statistics over simulated games: node src/world/stats.mjs [seeds] [stations]
// Grows each network the way the sim does: placeStart, noteLinks, placeGhosts(8 lead links);
// then breadth-first, each built station builds to its lead links in reading order until
// `stations` are built (findRoutes, setBuilt, commitRoute(cheap), noteLinks, placeGhosts).
// Articles come from a small synthetic link graph with topical locality, so links are shared.
// "drama" lines measure the cheap routes (the ones the game builds): real tunnels (cover over
// the rail, as the renderer draws it, of at least REAL_COVER), bridges and their height above
// the bed, rail climb per route, station elevation spread, and the first 8 routes per seed.

import { pathToFileURL } from 'node:url';
import { createWorld } from './index.js';
import { WORLD } from '../config.js';
import { hexDistance, hashString, hexKey, mulberry32 } from '../hex.js';
import { measureNetwork } from './measure.mjs';

const SEEDS = Number(process.argv[2] ?? 24);
const TARGET = Number(process.argv[3] ?? 15);
const LEAD = WORLD.ghostsPerStation;

/** Synthetic article graph: article n links mostly to topical neighbours, plus a few hubs. */
export function fakeLinks(title, graphSeed) {
  const n = Number(title.slice(1));
  const rnd = mulberry32(hashString(`${graphSeed}:${title}`));
  const out = [];
  const seen = new Set([title]);
  const add = (t) => { if (!seen.has(t)) { seen.add(t); out.push(t); } };
  for (let i = 0; i < 60; i++) {
    const r = rnd();
    if (r < 0.05) add(`A${Math.floor(rnd() * 12)}`);                       // widely shared hubs
    else add(`A${Math.max(0, n + Math.round((rnd() - 0.5) * 800))}`);    // topical neighbours
  }
  return out;
}

export function simulate(seed, target = TARGET, graphSeed = seed) {
  const world = createWorld({ seed });
  const links = new Map();
  const linksOf = (t) => { if (!links.has(t)) links.set(t, fakeLinks(t, graphSeed)); return links.get(t); };
  const start = `A${500 + (hashString(String(seed)) % 500)}`;
  world.placeStart(start);
  world.noteLinks?.(start, linksOf(start));
  world.placeGhosts(start, linksOf(start).slice(0, LEAD));
  const built = [start];
  const results = [];
  const timings = [];
  for (let bi = 0; bi < built.length && built.length < target; bi++) {
    const from = built[bi];
    for (const to of linksOf(from).slice(0, LEAD)) {
      if (built.length >= target) break;
      const p = world.placements.get(to);
      if (!p || p.state === 'built') continue;
      const t0 = performance.now();
      const res = world.findRoutes(from, to);
      timings.push(performance.now() - t0);
      results.push({ ...res, gap: hexDistance(world.placements.get(from), p) });
      world.setBuilt(to);
      world.commitRoute(res.cheap);
      world.noteLinks?.(to, linksOf(to));
      world.placeGhosts(to, linksOf(to).slice(0, LEAD));
      built.push(to);
    }
  }
  return { world, results, timings, built, linksOf };
}

// ---- drama measures (what the player sees) -------------------------------------------

/** Natural land height at a hex centre as the renderer draws it (gaussian blend, render/surface.js). */
const KERNEL_SIGMA = 0.95, BED_DROP = 0.42;
const RING_W = Math.exp(-3 / (KERNEL_SIGMA * KERNEL_SIGMA)); // neighbours sit at sqrt 3
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export function drawnHeight(world, q, r) {
  const h = (t) => (t.water ? t.elevation - BED_DROP : t.elevation);
  let s = h(world.terrainAt(q, r)), w = 1;
  for (const [dq, dr] of DIRS) { s += RING_W * h(world.terrainAt(q + dq, r + dr)); w += RING_W; }
  return s / w;
}
/** Cover the renderer needs over the rail to draw a real tunnel (render TUNNEL_COVER 0.55, plus margin). */
export const REAL_COVER = 0.6;

/** Per-route drama: rail levels, climb, real tunnels, bridge runs and heights above the bed. */
export function routeDrama(world, route) {
  const rail = route.hexes.map((_, i) => route.points[i * 8].y);
  let climb = 0;
  for (let i = 1; i < rail.length; i++) climb += Math.abs(rail[i] - rail[i - 1]);
  const runs = { tunnel: 0, realTunnel: 0, bridge: 0 };
  const bridgeHeights = [];
  let maxCover = 0;
  for (let i = 0; i < route.hexes.length; i++) {
    const h = route.hexes[i];
    const t = world.terrainAt(h.q, h.r);
    const startsRun = i === 0 || route.hexes[i - 1].kind !== h.kind;
    if (h.kind === 'tunnel') {
      const cover = drawnHeight(world, h.q, h.r) - rail[i];
      if (startsRun) { runs.tunnel++; runs._real = false; }
      if (cover >= REAL_COVER && !runs._real) { runs._real = true; runs.realTunnel++; }
      maxCover = Math.max(maxCover, cover);
    } else if (h.kind === 'bridge') {
      if (startsRun) runs.bridge++;
      bridgeHeights.push(rail[i] - (t.water ? t.elevation - BED_DROP : t.elevation));
    }
  }
  return { climb, runs, bridgeHeights, maxCover };
}

function layoutMeasures(world, built, linksOf) {
  const shared = [], unsharedD = [], parentD = [], nearestD = [];
  for (const p of world.placements.values()) {
    if (p.state !== 'ghost') continue;
    const linkers = built.filter((b) => linksOf(b).includes(p.title)); // in build order
    const par = world.placements.get(p.parent);
    parentD.push(hexDistance(p, par));
    nearestD.push(Math.min(...linkers.map((b) => hexDistance(p, world.placements.get(b))), hexDistance(p, par)));
    if (linkers.length >= 2) {
      const second = linkers.find((b) => b !== p.parent);
      shared.push(hexDistance(p, world.placements.get(second)));
    } else if (linkers.length === 1) {
      unsharedD.push(hexDistance(p, world.placements.get(linkers[0])));
    }
  }
  return { shared, unsharedD, parentD, nearestD };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const agg = { cheap: [], direct: [] };
  const allT = [];
  const seedKinds = [];
  const L = { shared: [], unshared: [], parent: [], nearest: [] };
  const D = { routes: [], first8: [], stationSd: [], stationRange: [], stationElev: [] };
  const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const M = [];
  for (let s = 0; s < SEEDS; s++) {
    const { world, results, timings, built, linksOf } = simulate(s + 1);
    allT.push(...timings);
    const stationHexes = new Set(built.map((t) => { const p = world.placements.get(t); return hexKey(p.q, p.r); }));
    M.push(measureNetwork(results.map((r) => r.cheap), stationHexes));
    const kinds = new Set();
    for (const r of results) {
      agg.cheap.push(r.cheap); agg.direct.push(r.direct);
      for (const h of r.cheap.hexes) kinds.add(h.kind);
      for (const h of r.direct.hexes) kinds.add(h.kind);
    }
    seedKinds.push({ seed: s + 1, bridge: kinds.has('bridge'), tunnel: kinds.has('tunnel'), stations: built.length });
    // drama of the cheap routes (the ones the game builds)
    let first8 = { realTunnel: 0, bridge: 0 };
    results.forEach((r, i) => {
      const d = routeDrama(world, r.cheap);
      D.routes.push(d);
      if (i < 8) { first8.realTunnel += d.runs.realTunnel; first8.bridge += d.runs.bridge; }
    });
    D.first8.push({ seed: s + 1, ...first8 });
    const elev = built.map((t) => { const p = world.placements.get(t); return world.terrainAt(p.q, p.r).elevation; });
    const mean = avg(elev);
    D.stationSd.push(Math.sqrt(avg(elev.map((e) => (e - mean) ** 2))));
    D.stationRange.push(Math.max(...elev) - Math.min(...elev));
    D.stationElev.push(...elev);
    const m = layoutMeasures(world, built, linksOf);
    L.shared.push(...m.shared); L.unshared.push(...m.unsharedD); L.parent.push(...m.parentD); L.nearest.push(...m.nearestD);
  }
  const pct = (a, f) => `${((a.filter(f).length / a.length) * 100).toFixed(0)}%`;
  const has = (k) => (r) => r.hexes.some((h) => h.kind === k);
  console.log(`${SEEDS} seeds, ${TARGET} stations each, ${agg.cheap.length} routes`);
  for (const st of ['cheap', 'direct']) {
    const a = agg[st];
    console.log(`${st.padEnd(6)}: bridge ${pct(a, has('bridge'))}, tunnel ${pct(a, has('tunnel'))}, ledge ${pct(a, has('ledge'))}, ` +
      `bridge-or-tunnel ${pct(a, (r) => has('bridge')(r) || has('tunnel')(r))}, avg cost ${avg(a.map((r) => r.cost)).toFixed(1)}, ` +
      `avg hexes ${avg(a.map((r) => r.hexes.length)).toFixed(1)}, avg length ${avg(a.map((r) => r.length)).toFixed(1)}`);
  }
  const both = seedKinds.filter((k) => k.bridge && k.tunnel).length;
  console.log(`seeds with both bridges and tunnels: ${both}/${SEEDS}` +
    (both < SEEDS ? ` (missing: ${seedKinds.filter((k) => !(k.bridge && k.tunnel)).map((k) => `${k.seed}${k.bridge ? '' : ':no bridge'}${k.tunnel ? '' : ':no tunnel'}`).join(', ')})` : ''));
  // drama of cheap routes
  const R = D.routes;
  const bh = R.flatMap((d) => d.bridgeHeights);
  console.log(`drama (cheap routes): real tunnel (cover >= ${REAL_COVER}) ${pct(R, (d) => d.runs.realTunnel > 0)}, ` +
    `any tunnel ${pct(R, (d) => d.runs.tunnel > 0)}, bridge ${pct(R, (d) => d.runs.bridge > 0)}, ` +
    `avg climb ${avg(R.map((d) => d.climb)).toFixed(2)} per route, avg max tunnel cover ${avg(R.filter((d) => d.runs.tunnel).map((d) => d.maxCover)).toFixed(2)}`);
  console.log(`  bridge hexes: ${bh.length}, avg rail above bed ${avg(bh).toFixed(2)}, ` +
    `>= 1.0 above bed ${pct(bh, (h) => h >= 1.0)}, >= 1.5 ${pct(bh, (h) => h >= 1.5)}`);
  console.log(`  stations: elevation sd per seed ${avg(D.stationSd).toFixed(2)}, range per seed ${avg(D.stationRange).toFixed(2)}, ` +
    `all ${Math.min(...D.stationElev).toFixed(1)}..${Math.max(...D.stationElev).toFixed(1)}`);
  const weak = D.first8.filter((f) => f.realTunnel < 2 || f.bridge < 2);
  console.log(`  first 8 routes per seed with >= 2 real tunnels and >= 2 bridges: ${SEEDS - weak.length}/${SEEDS}` +
    (weak.length ? ` (short: ${weak.map((f) => `${f.seed}:T${f.realTunnel}B${f.bridge}`).join(' ')})` : ''));
  // tracks: do they lie on one another, cross at grade, come too close? (committed cheap routes)
  const sum = (k) => M.reduce((a, m) => a + m[k], 0);
  console.log(`tracks: ${(sum('stacked') / sum('routeHexes') * 100).toFixed(1)}% of committed route hexes (outside stations) on another track's centreline; ` +
    `${sum('atGrade')} same-height crossings of ${sum('crossings')} (min clearance ${Math.min(...M.map((m) => m.minClear).filter((x) => !Number.isNaN(x))).toFixed(2)})`);
  console.log(`  shared corridors: ${sum('laneRoutes')}/${sum('routes')} routes run in a lane, ${sum('laneHexes')} lane hexes ` +
    `(${(sum('laneHexes') / Math.max(1, sum('laneRoutes'))).toFixed(1)} per such route); over ${sum('over')}, under ${sum('under')}; ` +
    `min distance between tracks outside stations ${Math.min(...M.map((m) => m.minDist)).toFixed(3)} (laneSpacing ${WORLD.laneSpacing}), ` +
    `seeds under 0.8 x laneSpacing: ${M.filter((m) => m.minDist < 0.8 * WORLD.laneSpacing).length}/${SEEDS}`);
  allT.sort((a, b) => a - b);
  console.log(`findRoutes: avg ${avg(allT).toFixed(2)} ms, median ${allT[allT.length >> 1].toFixed(2)} ms, p95 ${allT[Math.floor(allT.length * 0.95)].toFixed(2)} ms, max ${allT.at(-1).toFixed(2)} ms (includes cold terrain)`);
  const meanUnshared = avg(L.unshared);
  console.log(`layout: ${L.shared.length} shared reservations (>=2 built linkers), ${L.unshared.length} unshared`);
  console.log(`  shared link nearer its second linker than the mean unshared link-to-linker distance (${meanUnshared.toFixed(2)}): ` +
    `${pct(L.shared, (d) => d < meanUnshared)} (mean ${avg(L.shared).toFixed(2)})`);
  const hist = {};
  for (const d of L.parent) { const b = d >= 14 ? '14+' : String(d); hist[b] = (hist[b] || 0) + 1; }
  const keys = Object.keys(hist).sort((a, b) => parseInt(a) - parseInt(b));
  console.log(`  parent->reservation distance: ${keys.map((k) => `${k}:${hist[k]}`).join(' ')}; ` +
    `max ${Math.max(...L.parent)}`);
  console.log(`  nearest built linker within ghostMaxDist+2 (${WORLD.ghostMaxDist + 2}): ${pct(L.nearest, (d) => d <= WORLD.ghostMaxDist + 2)}, max ${Math.max(...L.nearest)}`);
}
