import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './index.js';
import { createTerrain, ELEV_STEP } from './terrain.js';
import { createRouter, classify, MAX_RISE_PER_HEX, TUNNEL_DEPTH_LEVELS, LEDGE_SIDE_SLOPE } from './router.js';
import { simulate, routeDrama, REAL_COVER } from './stats.mjs';
import { RESERVATION_SPACING, RESERVATION_REACH } from './layout.js';
import { WORLD, ECON, BIOMES } from '../config.js';
import { hexDistance, hexToWorld, hexSpiral, worldToHex } from '../hex.js';
import { routeLength } from '../route.js';

// ---- helpers --------------------------------------------------------------------

/** Plays a deterministic little game: builds `steps` ghosts outward, with shared links (loops). */
function grow(world, steps = 14, linksPer = 10) {
  const links = (t) => {
    const out = [];
    for (let i = 0; i < linksPer; i++) out.push(`${t}>${i}`);
    out.splice(3, 0, `Shared ${t.length % 4}`); // some titles recur across articles
    return out;
  };
  world.placeStart('Root');
  world.noteLinks('Root', links('Root'));
  world.placeGhosts('Root', links('Root'));
  const built = ['Root'];
  const routes = [];
  for (let s = 0; s < steps; s++) {
    const from = built[(s * 7) % built.length];
    const ghost = [...world.placements.values()].find((p) => p.state === 'ghost' && p.parent === from)
      || [...world.placements.values()].find((p) => p.state === 'ghost');
    const res = world.findRoutes(ghost.parent, ghost.title);
    routes.push(res);
    world.setBuilt(ghost.title);
    world.commitRoute(res.cheap);
    built.push(ghost.title);
    world.noteLinks(ghost.title, links(ghost.title));
    world.placeGhosts(ghost.title, links(ghost.title));
  }
  return routes;
}

const isNeighbour = (a, b) => hexDistance(a, b) === 1;

function checkRoute(world, route, terrain) {
  const from = world.placements.get(route.from), to = world.placements.get(route.to);
  const hx = route.hexes;
  assert.ok(hx.length >= 2);
  assert.deepEqual([hx[0].q, hx[0].r], [from.q, from.r], 'starts at from');
  assert.deepEqual([hx.at(-1).q, hx.at(-1).r], [to.q, to.r], 'ends at to');
  for (let i = 1; i < hx.length; i++) assert.ok(isNeighbour(hx[i - 1], hx[i]), 'contiguous');
  assert.equal(new Set(hx.map((h) => `${h.q},${h.r}`)).size, hx.length, 'no repeated hex');
  // never through a third built station (unbuilt reservations are invisible and move off track)
  for (const p of world.placements.values()) {
    if (p.title === route.from || p.title === route.to || p.state !== 'built') continue;
    assert.ok(!hx.some((h) => h.q === p.q && h.r === p.r), `route passes through station ${p.title}`);
  }
  // cost
  assert.equal(route.cost, hx.reduce((s, h) => s + ECON.trackCostPerHex[h.kind], 0));
  // points
  const pts = route.points;
  assert.equal(pts.length, (hx.length - 1) * 8 + 1);
  const fw = hexToWorld(from.q, from.r), tw = hexToWorld(to.q, to.r);
  assert.ok(Math.abs(pts[0].x - fw.x) < 1e-9 && Math.abs(pts[0].z - fw.z) < 1e-9);
  assert.ok(Math.abs(pts.at(-1).x - tw.x) < 1e-9 && Math.abs(pts.at(-1).z - tw.z) < 1e-9);
  assert.ok(Math.abs(pts[0].y - terrain(from.q, from.r).elevation) < 1e-9, 'ground level at from');
  assert.ok(Math.abs(pts.at(-1).y - terrain(to.q, to.r).elevation) < 1e-9, 'ground level at to');
  assert.ok(Math.abs(route.length - routeLength({ points: pts })) < 1e-9, 'length matches polyline');
  // smooth: no kinks between consecutive segments (ground plane)
  for (let i = 1; i < pts.length - 1; i++) {
    const ax = pts[i].x - pts[i - 1].x, az = pts[i].z - pts[i - 1].z;
    const bx = pts[i + 1].x - pts[i].x, bz = pts[i + 1].z - pts[i].z;
    const cos = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz));
    assert.ok(cos > Math.cos((35 * Math.PI) / 180), `kink at point ${i}: ${Math.acos(cos)}`);
    assert.ok(['ground', 'ledge', 'bridge', 'tunnel'].includes(pts[i].kind));
  }
  // kinds consistent with terrain + rail height, grade limit
  for (let i = 0; i < hx.length; i++) {
    const c = pts[i * 8];
    const w = hexToWorld(hx[i].q, hx[i].r);
    assert.ok(Math.abs(c.x - w.x) < 1e-9 && Math.abs(c.z - w.z) < 1e-9, 'passes through hex centres');
    const t = terrain(hx[i].q, hx[i].r);
    const rail = Math.round(c.y / ELEV_STEP);
    const ground = Math.round(t.elevation / ELEV_STEP);
    if (t.water) assert.equal(hx[i].kind, 'bridge', 'water needs a bridge');
    if (hx[i].kind === 'tunnel') assert.ok(t.elevation - c.y >= TUNNEL_DEPTH_LEVELS * ELEV_STEP - 1e-9, 'tunnel runs below ground');
    if (hx[i].kind === 'bridge') assert.ok(t.water || c.y - t.elevation >= 0.6 - 1e-9, 'bridge spans water or a gap');
    if (t.water) assert.ok(c.y > t.elevation, 'bridge above water');
    assert.ok(Math.abs(ground - rail) <= 1 || hx[i].kind !== 'ground', 'ground track sits at ground');
    if (i > 0) {
      const p = pts[(i - 1) * 8];
      assert.ok(Math.abs(c.y - p.y) <= MAX_RISE_PER_HEX + 1e-9, 'grade limit');
    }
  }
  for (let i = 1; i < pts.length; i++) {
    assert.ok(Math.abs(pts[i].y - pts[i - 1].y) <= MAX_RISE_PER_HEX + 1e-9, 'grade limit between points');
  }
}

function checkPair(res) {
  assert.ok(res.cheap.cost <= res.direct.cost, 'cheap.cost <= direct.cost');
  assert.ok(res.direct.hexes.length <= res.cheap.hexes.length, 'direct no longer than cheap');
  assert.equal(res.cheap.style, 'cheap');
  assert.equal(res.direct.style, 'direct');
  const sameHexes = JSON.stringify(res.cheap.hexes) === JSON.stringify(res.direct.hexes);
  if (res.same) assert.ok(sameHexes, 'same => identical hexes');
}

// ---- determinism ------------------------------------------------------------------

test('determinism: same seed and calls give identical placements, tiles and routes', () => {
  const a = createWorld({ seed: 42 }), b = createWorld({ seed: 42 });
  const ra = grow(a), rb = grow(b);
  assert.deepEqual([...a.placements.values()], [...b.placements.values()]);
  assert.deepEqual(a.revealedTiles(), b.revealedTiles());
  assert.deepEqual(ra, rb);
  for (let q = -20; q < 20; q += 3) for (let r = -20; r < 20; r += 3) assert.deepEqual(a.terrainAt(q, r), b.terrainAt(q, r));
  // terrainAt is independent of call order / history
  const c = createWorld({ seed: 42 });
  assert.deepEqual(c.terrainAt(17, -9), a.terrainAt(17, -9));
});

test('determinism: different seeds give different terrain; string seeds work', () => {
  const a = createWorld({ seed: 1 }), b = createWorld({ seed: 2 }), s = createWorld({ seed: 'hello' });
  let diff = 0, n = 0;
  for (let q = -30; q < 30; q += 2) for (let r = -30; r < 30; r += 2) {
    n++;
    const ta = a.terrainAt(q, r), tb = b.terrainAt(q, r);
    if (ta.biome !== tb.biome || ta.elevation !== tb.elevation || ta.water !== tb.water) diff++;
  }
  assert.ok(diff > n * 0.5, `only ${diff}/${n} tiles differ`);
  assert.deepEqual(s.terrainAt(5, 5), createWorld({ seed: 'hello' }).terrainAt(5, 5));
});

// ---- terrain ---------------------------------------------------------------------

test('terrain: valid tiles, all biomes occur, rivers and lakes exist', () => {
  const seen = new Set();
  let water = 0, n = 0;
  for (const seed of [1, 2, 3, 4]) {
    const w = createWorld({ seed });
    for (let q = -60; q <= 60; q += 1) for (let r = -60; r <= 60; r += 2) {
      const t = w.terrainAt(q, r);
      n++;
      assert.equal(t.q, q); assert.equal(t.r, r);
      assert.ok(BIOMES.includes(t.biome));
      assert.ok(t.elevation >= 0 && t.elevation <= WORLD.maxElevation);
      assert.ok(t.detail >= 0 && t.detail < 1);
      assert.equal(typeof t.water, 'boolean');
      seen.add(t.biome);
      if (t.water) water++;
    }
  }
  assert.deepEqual([...seen].sort(), [...BIOMES].sort());
  assert.ok(water / n > 0.02 && water / n < 0.2, `water share ${water / n}`);
  const t = createWorld({ seed: 1 }).terrainAt(1e6, -1e6); // far away still works
  assert.ok(BIOMES.includes(t.biome));
});

test('terrain: biome regions are coherent (most neighbours share the biome)', () => {
  const w = createWorld({ seed: 9 });
  let same = 0, n = 0;
  for (let q = -40; q < 40; q++) for (let r = -40; r < 40; r++) {
    n++;
    if (w.terrainAt(q, r).biome === w.terrainAt(q + 1, r).biome) same++;
  }
  // mountain ranges are long bands a few hexes wide, so they add border; regions stay large
  assert.ok(same / n > 0.75, `neighbour agreement ${same / n}`);
});

test('terrain: rivers are long connected lines of water', () => {
  for (const seed of [1, 5, 11]) {
    const w = createWorld({ seed });
    const R = 45;
    const isW = (q, r) => hexDistance({ q, r }, { q: 0, r: 0 }) <= R && w.terrainAt(q, r).water;
    const seen = new Set();
    let largest = 0;
    for (const h of hexSpiral(0, 0, R)) {
      const k = `${h.q},${h.r}`;
      if (seen.has(k) || !isW(h.q, h.r)) continue;
      let size = 0, minQ = h.q, maxQ = h.q, minR = h.r, maxR = h.r;
      const stack = [h];
      seen.add(k);
      while (stack.length) {
        const c = stack.pop();
        size++;
        minQ = Math.min(minQ, c.q); maxQ = Math.max(maxQ, c.q); minR = Math.min(minR, c.r); maxR = Math.max(maxR, c.r);
        for (const d of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
          const nq = c.q + d[0], nr = c.r + d[1], nk = `${nq},${nr}`;
          if (!seen.has(nk) && isW(nq, nr)) { seen.add(nk); stack.push({ q: nq, r: nr }); }
        }
      }
      largest = Math.max(largest, Math.max(maxQ - minQ, maxR - minR));
    }
    assert.ok(largest >= 30, `seed ${seed}: longest water body spans only ${largest} hexes`);
  }
});

test('terrain: the start hex and its ring are dry and buildable for every seed', () => {
  for (let seed = 0; seed < 60; seed++) {
    const w = createWorld({ seed });
    for (const h of hexSpiral(0, 0, 1)) assert.equal(w.terrainAt(h.q, h.r).water, false, `seed ${seed}`);
    const terrain = createTerrain(seed);
    assert.ok(terrain.isBuildable(0, 0), `seed ${seed} origin not buildable`);
    w.placeStart('S');
    w.placeGhosts('S', Array.from({ length: 12 }, (_, i) => `L${i}`));
  }
});

// ---- layout --------------------------------------------------------------------

test('layout: placeStart at origin, built, reveals revealStation', () => {
  const w = createWorld({ seed: 3 });
  const { placement, revealed } = w.placeStart('Alpha');
  assert.deepEqual(placement, { title: 'Alpha', q: 0, r: 0, state: 'built', parent: null });
  assert.equal(revealed.length, hexSpiral(0, 0, WORLD.revealStation).length);
  assert.equal(w.placements.get('Alpha'), placement);
  assert.throws(() => w.placeStart('Beta'));
});

test('layout: spacing, dry buildable hexes, built stations never move', () => {
  for (const seed of [1, 7, 23]) {
    const w = createWorld({ seed });
    grow(w, 20);
    const terrain = createTerrain(seed);
    const all = [...w.placements.values()];
    for (let i = 0; i < all.length; i++) {
      assert.ok(!w.terrainAt(all[i].q, all[i].r).water, 'not on water');
      assert.ok(terrain.isBuildable(all[i].q, all[i].r), 'not on an extreme tile');
      for (let j = i + 1; j < all.length; j++) {
        const need = all[i].state === 'built' || all[j].state === 'built' ? WORLD.minStationSpacing : RESERVATION_SPACING;
        assert.ok(hexDistance(all[i], all[j]) >= need, `${all[i].title} too close to ${all[j].title}`);
      }
    }
    // existing titles are not returned; built stations never move (reservations may)
    const before = all.filter((p) => p.state === 'built').map((p) => ({ ...p }));
    const parent = all.find((p) => p.state === 'built' && p.title !== 'Root');
    const res = w.placeGhosts(parent.title, [all[0].title, all[3].title, 'Brand new']);
    assert.deepEqual(res.placements.map((p) => p.title), ['Brand new']);
    for (const p of before) assert.deepEqual({ ...w.placements.get(p.title) }, p);
    assert.equal(w.placements.get('Brand new').parent, parent.title);
  }
});

test('layout: same parent, titles and map give the same positions; stable headings', () => {
  const a = createWorld({ seed: 5 }), b = createWorld({ seed: 5 });
  a.placeStart('X'); b.placeStart('X');
  const ra = a.placeGhosts('X', ['a', 'b', 'c', 'd']);
  const rb = b.placeGhosts('X', ['a', 'b', 'c', 'd']);
  assert.deepEqual(ra, rb);
  assert.throws(() => a.placeGhosts('Nope', ['z']), /not on the map/);
  // duplicates within one call are placed once
  const c = createWorld({ seed: 5 });
  c.placeStart('X');
  assert.equal(c.placeGhosts('X', ['p', 'p', 'q']).placements.length, 2);
});

test('layout: earlier links nearer, later links farther (on average)', () => {
  let early = 0, late = 0, cnt = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const w = createWorld({ seed });
    w.placeStart('R');
    const titles = Array.from({ length: 12 }, (_, i) => `t${i}`);
    w.placeGhosts('R', titles);
    const d = (t) => hexDistance(w.placements.get(t), { q: 0, r: 0 });
    for (let i = 0; i < 4; i++) { early += d(titles[i]); late += d(titles[11 - i]); cnt++; }
  }
  early /= cnt; late /= cnt;
  assert.ok(early < late - 1.5, `early ${early} late ${late}`);
  assert.ok(early >= WORLD.ghostMinDist - 1 && late <= WORLD.ghostMaxDist + 2, `early ${early} late ${late}`);
});

test('layout: the fan points away from the grandparent', () => {
  let outward = 0, total = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const w = createWorld({ seed });
    grow(w, 12);
    for (const p of w.placements.values()) {
      const par = p.parent && w.placements.get(p.parent);
      const gp = par && par.parent && w.placements.get(par.parent);
      if (!gp) continue;
      const P = hexToWorld(par.q, par.r), G = hexToWorld(gp.q, gp.r), C = hexToWorld(p.q, p.r);
      const dot = (P.x - G.x) * (C.x - P.x) + (P.z - G.z) * (C.z - P.z);
      total++;
      if (dot > 0) outward++;
    }
  }
  assert.ok(total > 50);
  assert.ok(outward / total > 0.8, `outward share ${outward}/${total}`);
});

test('layout: a crowded map still finds a spot for every link', () => {
  const w = createWorld({ seed: 8 });
  w.placeStart('Hub');
  for (let round = 0; round < 8; round++) {
    const res = w.placeGhosts('Hub', Array.from({ length: 16 }, (_, i) => `r${round}-${i}`));
    assert.equal(res.placements.length, 16);
  }
  const all = [...w.placements.values()];
  assert.equal(all.length, 1 + 8 * 16);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const need = all[i].state === 'built' || all[j].state === 'built' ? WORLD.minStationSpacing : RESERVATION_SPACING;
    assert.ok(hexDistance(all[i], all[j]) >= need);
  }
});

test('layout: reservations stay within reach of their linker when room exists', () => {
  for (const seed of [1, 2, 3, 8]) {
    const w = createWorld({ seed });
    w.placeStart('Hub');
    const terrain = createTerrain(seed);
    const room = hexSpiral(0, 0, RESERVATION_REACH).filter((h) => hexDistance(h, { q: 0, r: 0 }) >= WORLD.minStationSpacing && terrain.isBuildable(h.q, h.r)).length;
    const want = Math.min(40, room);
    w.placeGhosts('Hub', Array.from({ length: want }, (_, i) => `t${i}`));
    for (const p of w.placements.values()) {
      assert.ok(hexDistance(p, { q: 0, r: 0 }) <= RESERVATION_REACH, `seed ${seed}: ${p.title} at ${hexDistance(p, { q: 0, r: 0 })} (room ${room})`);
    }
  }
});

// ---- relatedness (noteLinks) and reservations -------------------------------------

/** Two built stations A (start) and B, both linking to S; S was first put on the map by A. */
function twoLinkers(seed, withNote) {
  const w = createWorld({ seed });
  w.placeStart('A');
  const aLinks = ['B', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'S'];
  if (withNote) w.noteLinks('A', aLinks);
  w.placeGhosts('A', aLinks);
  const res = w.findRoutes('A', 'B');
  w.setBuilt('B');
  w.commitRoute(res.cheap);
  const bLinks = ['y1', 'S', 'y2', 'y3'];
  if (withNote) w.noteLinks('B', bLinks);
  w.placeGhosts('B', bLinks);
  return w;
}

test('noteLinks: a link shared by two built stations moves towards the second linker', () => {
  let closer = 0, n = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const plain = createWorld({ seed });
    plain.placeStart('A');
    plain.placeGhosts('A', ['B', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'S']);
    const w = twoLinkers(seed, true);
    const B = w.placements.get('B'), S = w.placements.get('S'), S0 = plain.placements.get('S');
    assert.equal(S.state, 'ghost');
    assert.equal(S.parent, 'A', 'first linker stays the parent');
    n++;
    if (hexDistance(S, B) < hexDistance(S0, B)) closer++;
    assert.ok(hexDistance(S, B) <= RESERVATION_REACH + 4, `seed ${seed}: S is ${hexDistance(S, B)} from B`);
  }
  assert.ok(closer >= n * 0.8, `only ${closer}/${n} moved closer to B`);
});

test('noteLinks: shared links become junctions between their linkers', () => {
  // S linked from A and B sits nearer the A-B midpoint than A's unshared links do
  let ok = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const w = twoLinkers(seed, true);
    const A = hexToWorld(0, 0), Bp = w.placements.get('B'), B = hexToWorld(Bp.q, Bp.r);
    const mid = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 };
    const dist = (t) => { const p = w.placements.get(t), q = hexToWorld(p.q, p.r); return Math.hypot(q.x - mid.x, q.z - mid.z); };
    const unshared = ['x4', 'x5', 'x6'].map(dist).reduce((a, b) => a + b) / 3;
    if (dist('S') < unshared) ok++;
  }
  assert.ok(ok >= 15, `${ok}/20`);
});

test('noteLinks: deterministic, built stations never move, optional', () => {
  const a = twoLinkers(3, true), b = twoLinkers(3, true);
  assert.deepEqual([...a.placements.values()], [...b.placements.values()]);
  const B = { ...a.placements.get('B') };
  a.noteLinks('Q', ['B', 'A']); // an unplaced title noting links: harmless
  a.noteLinks('B', ['A', 'x1', 'x2']);
  assert.deepEqual({ ...a.placements.get('B') }, B);
  assert.deepEqual({ ...a.placements.get('A') }, { title: 'A', q: 0, r: 0, state: 'built', parent: null });
  // without noteLinks the world still works (placeGhosts counts the parent as a linker)
  const c = twoLinkers(3, false);
  assert.ok(c.placements.get('S'));
  assert.ok(c.findRoutes('A', 'S').cheap.hexes.length >= 2);
});

test('reservations: re-placed off new track and away from newly built stations; findRoutes uses current positions', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const w = createWorld({ seed });
    grow(w, 10);
    const trackHexes = new Set();
    // replay: every committed route's hexes are free of reservations
    const built = [...w.placements.values()].filter((p) => p.state === 'built');
    for (let i = 1; i < built.length; i++) {
      const res = w.findRoutes(built[i - 1].title, built[i].title);
      w.commitRoute(res.cheap);
      for (const h of res.cheap.hexes) trackHexes.add(`${h.q},${h.r}`);
    }
    for (const p of w.placements.values()) {
      if (p.state === 'ghost') assert.ok(!trackHexes.has(`${p.q},${p.r}`), `reservation ${p.title} on track`);
    }
    // routes end where the placement is now
    const ghost = [...w.placements.values()].find((p) => p.state === 'ghost' && w.placements.get(p.parent).state === 'built');
    const res = w.findRoutes(ghost.parent, ghost.title);
    assert.deepEqual([res.cheap.hexes.at(-1).q, res.cheap.hexes.at(-1).r], [ghost.q, ghost.r]);
  }
});

test('reveal: unbuilt links reveal nothing when revealGhost < 0', () => {
  assert.ok(WORLD.revealGhost < 0, 'config expects hidden ghosts');
  const w = createWorld({ seed: 2 });
  const start = w.placeStart('S').revealed.length;
  const g = w.placeGhosts('S', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(g.revealed, []);
  assert.equal(w.revealedTiles().length, start);
  for (const p of g.placements) {
    if (hexDistance(p, { q: 0, r: 0 }) > WORLD.revealStation) assert.equal(w.isRevealed(p.q, p.r), false);
  }
});

// ---- routes ---------------------------------------------------------------------

test('routes: network routes satisfy all route rules', () => {
  for (const seed of [1, 7, 23, 99]) {
    const w = createWorld({ seed });
    const routes = grow(w, 16);
    for (const res of routes) {
      checkPair(res);
      checkRoute(w, res.cheap, w.terrainAt);
      checkRoute(w, res.direct, w.terrainAt);
    }
    // also routes between arbitrary built pairs (third stations in the way)
    const built = [...w.placements.values()].filter((p) => p.state === 'built');
    for (let i = 0; i + 3 < built.length; i += 3) {
      const res = w.findRoutes(built[i].title, built[i + 3].title);
      checkPair(res);
      checkRoute(w, res.cheap, w.terrainAt);
      checkRoute(w, res.direct, w.terrainAt);
    }
  }
});

test('routes: rough terrain uses bridges, tunnels and ledges consistently', () => {
  // drive the router directly between hexes in rough country, with a third station in the way
  const kinds = new Set();
  let sameCount = 0, total = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const terrain = createTerrain(seed);
    const stations = new Map();
    const stationAt = (q, r) => stations.get(`${q},${r}`) ?? null;
    const router = createRouter(terrain, stationAt, new Map());
    // a fake World shell so checkRoute can read placements
    const placements = new Map();
    // pairs 8 apart whose straight line crosses rough or wet country
    const pairs = [];
    for (let q = -80; q <= 80 && pairs.length < 10; q += 5) for (let r = -80; r <= 80 && pairs.length < 10; r += 7) {
      const a = { q, r }, b = { q: q + 8, r: r - 3 }, mid = { q: q + 4, r: r - 1 };
      if (!terrain.isBuildable(a.q, a.r) || !terrain.isBuildable(b.q, b.r) || !terrain.isBuildable(mid.q, mid.r)) continue;
      let rough = 0;
      for (let i = 1; i < 8; i++) {
        const t = terrain.terrainAt(q + i, r - Math.round((i * 3) / 8));
        if (t.water || t.biome === 'mountains' || t.biome === 'canyon') rough++;
      }
      if (rough >= 3) pairs.push([a, b, mid]);
    }
    for (const [a, b, mid] of pairs) {
      stations.clear(); placements.clear();
      stations.set(`${a.q},${a.r}`, 'A'); stations.set(`${b.q},${b.r}`, 'B'); stations.set(`${mid.q},${mid.r}`, 'M');
      placements.set('A', { title: 'A', ...a }); placements.set('B', { title: 'B', ...b }); placements.set('M', { title: 'M', ...mid });
      const res = router.findRoutes('A', a, 'B', b);
      total++;
      if (res.same) sameCount++;
      checkPair(res);
      for (const r of [res.cheap, res.direct]) {
        checkRoute({ placements }, r, terrain.terrainAt);
        for (const h of r.hexes) kinds.add(h.kind);
      }
    }
  }
  assert.ok(total >= 40, `only ${total} rough pairs`);
  for (const k of ['ground', 'ledge', 'bridge', 'tunnel']) assert.ok(kinds.has(k), `never produced ${k}`);
  assert.ok(sameCount < total, 'cheap and direct never differ');
});

test('routes: classify obeys the documented thresholds', () => {
  assert.equal(classify(5, true, 0, 5), -1);          // rail must clear water
  assert.equal(classify(5, true, 0, 6), 2);           // bridge
  assert.equal(classify(10, false, 0, 7), 3);         // 3 levels below -> tunnel
  assert.equal(classify(6, false, 0, 4), 3);          // 2 levels below -> tunnel
  assert.equal(classify(4, false, 0, 7), 2);          // 3 levels above -> viaduct
  assert.equal(classify(5, false, 0, 7), 1);          // 2 above -> ledge (embankment)
  assert.equal(classify(5, false, LEDGE_SIDE_SLOPE, 5), 1); // steep side slope -> ledge
  assert.equal(classify(5, false, LEDGE_SIDE_SLOPE - 0.2, 5), 0); // a slope a station may stand on -> ground
  assert.equal(classify(5, false, 0.2, 4), 0);        // ground
});

test('routes: throws for unplaced titles', () => {
  const w = createWorld({ seed: 1 });
  w.placeStart('A');
  w.placeGhosts('A', ['B']);
  assert.throws(() => w.findRoutes('A', 'Zed'), /"Zed" is not on the map/);
  assert.throws(() => w.findRoutes('Zed', 'A'), /"Zed" is not on the map/);
  assert.throws(() => w.setBuilt('Zed'), /not on the map/);
  assert.ok(w.findRoutes('A', 'B').cheap);
});

test('routes: prefer not to run along existing track', () => {
  // Same pair routed twice: once on a clean map, once after committing its own cheap route.
  // With track down, the new cheap route should overlap it no more than before (it may
  // still reuse it when that is genuinely cheaper; the penalty only discourages it).
  const w = createWorld({ seed: 4 });
  grow(w, 6);
  const built = [...w.placements.values()].filter((p) => p.state === 'built');
  const res1 = w.findRoutes(built[0].title, built[built.length - 1].title);
  w.commitRoute(res1.cheap);
  const res2 = w.findRoutes(built[0].title, built[built.length - 1].title);
  assert.ok(res2.cheap.cost >= res1.cheap.cost, 'committed track does not change construction cost');
  checkPair(res2);
});

// ---- drama: ordinary links cross dramatic land -------------------------------------

/** Cheap routes of simulated games (the game always builds the cheap one), with per-seed data. */
const DRAMA = (() => {
  const seeds = [];
  for (let seed = 1; seed <= 16; seed++) {
    const { world, results, built } = simulate(seed, 12);
    const elev = built.map((t) => { const p = world.placements.get(t); return world.terrainAt(p.q, p.r).elevation; });
    seeds.push({ seed, routes: results.map((r) => routeDrama(world, r.cheap)), elev });
  }
  return seeds;
})();
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

test('drama: cheap routes tunnel (real cover) and bridge often, and climb', () => {
  const all = DRAMA.flatMap((s) => s.routes);
  const tunnel = all.filter((d) => d.runs.realTunnel > 0).length / all.length;
  const bridge = all.filter((d) => d.runs.bridge > 0).length / all.length;
  const climb = mean(all.map((d) => d.climb));
  assert.ok(tunnel >= 0.35, `real tunnels (cover >= ${REAL_COVER}) on only ${(tunnel * 100).toFixed(0)}% of cheap routes`);
  assert.ok(bridge >= 0.5, `bridges on only ${(bridge * 100).toFixed(0)}% of cheap routes`);
  assert.ok(climb >= 1.5, `average rail climb per route only ${climb.toFixed(2)}`);
});

test('drama: every seed has 2+ real tunnels and 2+ bridges on the routes to its first 8 stations', () => {
  for (const s of DRAMA) {
    const first = s.routes.slice(0, 8);
    const t = first.reduce((n, d) => n + d.runs.realTunnel, 0), b = first.reduce((n, d) => n + d.runs.bridge, 0);
    assert.ok(t >= 2 && b >= 2, `seed ${s.seed}: ${t} real tunnels, ${b} bridges`);
  }
});

test('drama: bridges stand well above the bed; stations sit at different heights', () => {
  const heights = DRAMA.flatMap((s) => s.routes.flatMap((d) => d.bridgeHeights));
  assert.ok(mean(heights) >= 1.1, `bridge rail only ${mean(heights).toFixed(2)} above the bed on average`);
  assert.ok(heights.filter((h) => h >= 1.0).length / heights.length >= 0.6, 'most bridges span a real drop');
  const sd = mean(DRAMA.map((s) => { const m = mean(s.elev); return Math.sqrt(mean(s.elev.map((e) => (e - m) ** 2))); }));
  assert.ok(sd >= 0.6, `station elevations spread only ${sd.toFixed(2)} (sd per seed)`);
});

test('terrain: the start sits in a basin ringed by a rim (or a river) in nearly every direction', () => {
  for (let seed = 0; seed < 40; seed++) {
    const terrain = createTerrain(seed);
    const e0 = terrain.terrainAt(0, 0).elevation;
    let closed = 0;
    for (let a = 0; a < 12; a++) {
      const th = (a / 12) * 2 * Math.PI;
      let top = 0, water = false;
      for (let d = 2.5; d <= 9; d += 0.5) {
        const h = worldToHex(Math.cos(th) * d, Math.sin(th) * d);
        const t = terrain.terrainAt(h.q, h.r);
        water ||= t.water;
        top = Math.max(top, t.elevation);
      }
      if (top - e0 >= 1.0 || water) closed++;
    }
    assert.ok(closed >= 9, `seed ${seed}: only ${closed}/12 directions leave the basin over a rim or a river`);
  }
});

test('terrain: enough land stays buildable for the layout', () => {
  let ok = 0, n = 0;
  for (const seed of [1, 2, 3, 4]) {
    const terrain = createTerrain(seed);
    for (let q = -50; q <= 50; q += 2) for (let r = -50; r <= 50; r += 2) { n++; if (terrain.isBuildable(q, r)) ok++; }
  }
  assert.ok(ok / n >= 0.4, `only ${(ok / n * 100).toFixed(0)}% of hexes are buildable`);
});

// ---- reveal ---------------------------------------------------------------------

test('reveal: each call returns only newly revealed tiles', () => {
  const w = createWorld({ seed: 12 });
  const seen = new Set();
  const take = (tiles) => {
    for (const t of tiles) {
      const k = `${t.q},${t.r}`;
      assert.ok(!seen.has(k), `tile ${k} revealed twice`);
      seen.add(k);
      assert.ok(w.isRevealed(t.q, t.r));
      assert.deepEqual(t, w.terrainAt(t.q, t.r));
    }
    return tiles.length;
  };
  assert.equal(take(w.placeStart('S').revealed), 37);
  const g = w.placeGhosts('S', ['a', 'b', 'c', 'd', 'e', 'f']);
  take(g.revealed);
  if (WORLD.revealGhost >= 0) {
    for (const p of g.placements) for (const h of hexSpiral(p.q, p.r, WORLD.revealGhost)) assert.ok(w.isRevealed(h.q, h.r));
  }
  const res = w.findRoutes('S', 'a');
  const n1 = take(w.commitRoute(res.cheap).revealed);
  assert.ok(n1 > 0);
  for (const h of res.cheap.hexes) for (const x of hexSpiral(h.q, h.r, WORLD.revealTrack)) assert.ok(w.isRevealed(x.q, x.r));
  assert.equal(w.commitRoute(res.cheap).revealed.length, 0, 'committing again reveals nothing new');
  take(w.setBuilt('a').revealed);
  assert.equal(w.setBuilt('a').revealed.length, 0);
  assert.equal(w.revealedTiles().length, seen.size);
  assert.equal(w.isRevealed(500, 500), false);
});

// ---- performance -----------------------------------------------------------------

test('performance: terrainAt and findRoutes', (t) => {
  const w = createWorld({ seed: 77 });
  let t0 = performance.now();
  let n = 0;
  for (let q = 1000; q < 1100; q++) for (let r = 0; r < 50; r++) { w.terrainAt(q, r); n++; }
  const coldUs = ((performance.now() - t0) * 1000) / n;
  t0 = performance.now();
  for (let rep = 0; rep < 4; rep++) for (let q = 1000; q < 1100; q++) for (let r = 0; r < 50; r++) w.terrainAt(q, r);
  const warmUs = ((performance.now() - t0) * 1000) / (n * 4);
  t.diagnostic(`terrainAt: ${n} fresh tiles ${coldUs.toFixed(2)} us/tile; cached ${warmUs.toFixed(3)} us/tile`);
  assert.ok(coldUs < 50, `terrainAt too slow: ${coldUs} us`);

  // stations 8 hexes apart in varied terrain (router on bare terrain; positions are buildable hexes)
  const terrain = createTerrain(77);
  const router = createRouter(terrain, () => null, new Map());
  const pairs = [];
  for (let k = 0; pairs.length < 30 && k < 200; k++) {
    const a = { q: -60 + ((k * 13) % 120), r: -40 + ((k * 7) % 80) };
    const b = { q: a.q + 8 - (k % 5), r: a.r - (8 - (k % 5)) + (k % 5) };
    if (hexDistance(a, b) !== 8 || !terrain.isBuildable(a.q, a.r) || !terrain.isBuildable(b.q, b.r)) continue;
    pairs.push([a, b]);
  }
  for (const [a, b] of pairs) for (const h of hexSpiral(a.q, a.r, 20)) terrain.terrainAt(h.q, h.r); // warm terrain
  router.findRoutes('a', pairs[0][0], 'b', pairs[0][1]); // warm JIT
  const times = [];
  for (const [a, b] of pairs) {
    const s = performance.now();
    router.findRoutes('a', a, 'b', b);
    times.push(performance.now() - s);
  }
  times.sort((x, y) => x - y);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  t.diagnostic(`findRoutes (8 hexes apart, ${times.length} pairs, terrain cached): avg ${avg.toFixed(2)} ms, median ${times[times.length >> 1].toFixed(2)} ms, max ${times.at(-1).toFixed(2)} ms`);
  // cold terrain: a fresh world, first route includes generating the tiles
  const w2 = createWorld({ seed: 78 });
  w2.placeStart('S');
  w2.placeGhosts('S', Array.from({ length: 10 }, (_, i) => `L${i}`));
  const far = [...w2.placements.values()].at(-1);
  const s = performance.now();
  w2.findRoutes('S', far.title);
  t.diagnostic(`findRoutes on a fresh world (${hexDistance(far, { q: 0, r: 0 })} hexes, cold terrain): ${(performance.now() - s).toFixed(2)} ms`);
  assert.ok(avg < 60, `findRoutes too slow: ${avg} ms`);
});
