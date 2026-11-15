// Node smoke tests for the non-GPU parts of the renderer: run with `node --test src/render/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BIOMES, TRAIN_TYPES, WORLD } from '../config.js';
import { hexToWorld, hexSpiral } from '../hex.js';
import { sampleRoute, routeLength, RAIL_LIFT } from './rail.js';
import { createMockWorld, createMockGame, MOCK_TRACKS, mockTerrain } from './mock.js';
import { tileColors } from './palette.js';
import { layoutTileProps, buildPropGeometryBuilders, PROP_TYPES } from './props.js';
import { Terrain } from './terrain.js';
import { Surface, gridToWorld, EDGE_SINK } from './surface.js';
import { gradeSegments, TUNNEL_COVER } from './track.js';
import { sampleRoute as sampleRaw } from '../route.js';
import { createSharedUniforms, createMaterials } from './materials.js';
import { buildTrack, buildRibbon, vertexCountAt, resample, TRACK } from './track.js';
import { carOffsets, placeCars, TrainsView, vehicleBuilders, drawableType, trainWidth, CAR_SPECS } from './trains.js';
import { Network, LANES, nearestOther, planSupports } from './lanes.js';
import { UpgradeTags, tagAnchor, quoteOptions } from './upgrades.js';
import { MOCK_START_LEVELS } from './mock.js';
import { buildStationBuilder, chooseStationYaw, StationsView, trackDirsAt, signpostLinks, layoutSignposts, MAX_SIGNPOSTS, SIGN_RING } from './stations.js';
import { TracksView } from './tracks-view.js';
import { cullOverlaps } from './labels.js';
import { Particles } from './dynamic.js';

const finiteArr = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const l2 = abx * abx + aby * aby + abz * abz || 1;
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(a.x + abx * t - p.x, a.y + aby * t - p.y, a.z + abz * t - p.z));
  }
  return best;
}

function mockRoutes() {
  const world = createMockWorld();
  const game = createMockGame({ world });
  game.start();
  for (let i = 0; i < 400; i++) game.update(0.05); // 20 s: whole network built, trains running
  return { world, game };
}

test('mock terrain covers all seven biomes, has water and snow', () => {
  const seen = new Set();
  let water = 0, high = 0;
  for (const h of hexSpiral(0, 0, 24)) {
    const t = mockTerrain(h.q, h.r);
    seen.add(t.biome);
    if (t.water) water++;
    if (t.elevation >= 3) high++;
    assert.ok(t.elevation >= 0 && t.elevation <= 4);
  }
  for (const b of BIOMES) assert.ok(seen.has(b), `missing biome ${b}`);
  assert.ok(water > 20, 'expected a river');
  assert.ok(high > 5, 'expected high mountains');
});

test('tile colours are finite and in [0,1]', () => {
  for (const h of hexSpiral(0, 0, 18)) {
    const c = tileColors(mockTerrain(h.q, h.r));
    for (const v of [...c.top, ...c.side]) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
  }
  // garbage input still yields a colour
  const c = tileColors({ q: 0, r: 0, biome: 'nope', elevation: NaN, water: false, detail: undefined });
  assert.ok(finiteArr(c.top));
});

test('prop layout is deterministic and stays inside the hex', () => {
  let total = 0;
  const types = new Set();
  for (const h of hexSpiral(0, 0, 18)) {
    const t = mockTerrain(h.q, h.r);
    const a = layoutTileProps(t, { nearWater: true });
    const b = layoutTileProps(t, { nearWater: true });
    assert.deepEqual(a, b);
    const c = hexToWorld(t.q, t.r);
    for (const p of a) {
      assert.ok(PROP_TYPES.includes(p.type));
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isFinite(p.yaw) && p.scale > 0);
      assert.ok(Math.hypot(p.x - c.x, p.z - c.z) <= 0.75, 'prop outside hex');
      assert.equal(p.y, t.elevation);
      types.add(p.type);
    }
    if (t.water) assert.equal(a.length, 0);
    total += a.length;
  }
  assert.ok(total > 1000, `few props: ${total}`);
  for (const must of ['broadleaf', 'pine', 'palm', 'cactus', 'dune', 'reeds', 'willow', 'mesa', 'spire', 'jungle']) assert.ok(types.has(must), `no ${must}`);
});

test('prop geometries are finite and non-empty', () => {
  const b = buildPropGeometryBuilders();
  for (const t of PROP_TYPES) {
    assert.ok(b[t].vertexCount > 0 && b[t].vertexCount % 3 === 0, t);
    assert.ok(finiteArr(b[t].pos) && finiteArr(b[t].nor) && finiteArr(b[t].col), t);
  }
});

test('surface: hex centres are vertices at their elevation, river beds sit under water', () => {
  const world = createMockWorld();
  const S = new Surface((q, r) => world.terrainAt(q, r));
  let worst = 0, beds = 0;
  for (const h of hexSpiral(0, 0, 12)) {
    const t = world.terrainAt(h.q, h.r);
    S.revealHex(h.q, h.r);
    const n = S.natural(h.q * 3, h.r * 3);
    const g = gridToWorld(h.q * 3, h.r * 3), w = hexToWorld(h.q, h.r);
    assert.ok(Math.abs(g.x - w.x) < 1e-9 && Math.abs(g.z - w.z) < 1e-9, 'hex centre is a grid vertex');
    if (t.water) { beds++; assert.ok(n.h < t.elevation - 0.25, 'bed below the water'); assert.ok(Number.isFinite(n.wl)); }
    else worst = Math.max(worst, Math.abs(n.h - t.elevation));
  }
  assert.ok(beds > 3);
  assert.ok(worst < 0.3, `centre height off by ${worst}`); // blended, not stepped
  // drawn = natural inside revealed land, sunk into the mist far outside
  assert.ok(Math.abs(S.groundAt(0, 0) - S.naturalAt(0, 0)) < 1e-6);
  assert.ok(Math.abs(S.groundAt(200, 200) - (S.naturalAt(200, 200) - EDGE_SINK)) < 1e-6);
  // groundAt interpolates the drawn vertices exactly
  const v = S.heightAt(7, 5), p = gridToWorld(7, 5);
  assert.ok(Math.abs(S.groundAt(p.x, p.z) - v) < 1e-6);
});

test('terrain: 4000+ tiles as one surface, water ribbons, props seated on land', () => {
  const world = createMockWorld();
  const tiles = hexSpiral(0, 0, 37).map((h) => world.terrainAt(h.q, h.r));
  assert.ok(tiles.length >= 4000);
  const parent = new THREE.Group();
  const materials = createMaterials(createSharedUniforms());
  const terrain = new Terrain({ parent, materials, world });
  const t0 = Date.now();
  terrain.reveal(tiles.slice(0, 3000), { animate: false });
  terrain.reveal(tiles.slice(3000), { animate: true, origin: { x: 0, z: 0 } });
  const ms = Date.now() - t0;
  const st = terrain.stats();
  assert.equal(st.tiles, tiles.length);
  assert.ok(st.props > 5000, `props ${st.props}`);
  assert.ok(st.landTris > tiles.length * 14 && st.landTris < tiles.length * 30, `land tris ${st.landTris}`);
  assert.ok(st.waterTris > 100, `water tris ${st.waterTris}`);
  assert.ok(st.meshes < 160, `meshes ${st.meshes}`);
  assert.ok(st.animating > 0);
  for (let i = 0; i < 40; i++) terrain.update(0.05);
  assert.equal(terrain.stats().animating, 0);
  for (const m of terrain.meshes.values()) for (const x of [m.land, m.water]) if (x) {
    for (const name of ['position', 'aPrev', 'aBorn']) assert.ok(finiteArr(x.geometry.getAttribute(name).array), name);
  }
  // every visible prop stands on the drawn land, never in the water
  let checked = 0;
  for (const rec of terrain.tiles.values()) {
    for (const p of rec.props) {
      if (p.hidden) continue;
      assert.ok(Math.abs(p.y + 0.01 - terrain.groundAt(p.x, p.z)) < 1e-6);
      assert.equal(terrain.waterAt(p.x, p.z), null);
      checked++;
    }
  }
  assert.ok(checked > 4000);
  assert.equal(terrain.reveal(tiles.slice(0, 10)), 0);
  assert.ok(ms < 8000, `reveal took ${ms} ms`);
  terrain.dispose();
});

test('mock network builds: tracks with bridge, tunnel and ledge stretches', () => {
  const { game } = mockRoutes();
  const st = game.state;
  assert.equal(st.stations.size, 7);
  assert.equal(st.tracks.length, MOCK_TRACKS.length);
  assert.equal(st.lines, undefined, 'no lines in the game any more');
  // one train per upgraded track, none on bare track
  assert.equal(st.trains.length, MOCK_START_LEVELS.filter((l) => l > 0).length);
  for (const tr of st.tracks) {
    const train = st.trains.find((t) => t.trackId === tr.id);
    if (tr.level === 0) { assert.equal(train, undefined); assert.equal(tr.typeId, null); }
    else { assert.ok(train); assert.equal(train.typeId, tr.typeId); assert.equal(tr.trainId, train.id); }
  }
  const kinds = new Set();
  for (const t of st.tracks) for (const p of t.route.points) kinds.add(p.kind);
  for (const k of ['ground', 'bridge', 'tunnel', 'ledge']) assert.ok(kinds.has(k), `no ${k} in mock routes`);
});

test('track geometry: finite, ordered marks, portals at tunnels, piers on bridges', () => {
  const { world, game } = mockRoutes();
  const terrain = new Terrain({ parent: new THREE.Group(), materials: createMaterials(createSharedUniforms()), world });
  terrain.reveal(world.revealedTiles());
  let portals = 0, bridges = 0;
  for (const t of game.state.tracks) {
    const out = buildTrack(t.route, { groundAt: (x, z) => terrain.groundAt(x, z), naturalAt: (x, z) => terrain.naturalAt(x, z) });
    const b = out.builder;
    assert.ok(b.vertexCount > 100 && b.vertexCount % 3 === 0);
    assert.ok(finiteArr(b.pos) && finiteArr(b.nor) && finiteArr(b.col));
    for (let i = 1; i < out.marks.length; i++) {
      assert.ok(out.marks[i].s >= out.marks[i - 1].s);
      assert.ok(out.marks[i].v >= out.marks[i - 1].v);
    }
    assert.equal(out.marks[out.marks.length - 1].v, b.vertexCount);
    let prev = 0;
    for (let k = 0; k <= 20; k++) {
      const v = vertexCountAt(out.marks, (k / 20) * out.length);
      assert.ok(v >= prev && v <= b.vertexCount && v % 3 === 0);
      prev = v;
    }
    assert.equal(vertexCountAt(out.marks, out.length + 1), b.vertexCount);
    const hasTunnel = t.route.points.some((p) => p.kind === 'tunnel');
    if (hasTunnel) assert.ok(out.portals.length >= 2, 'tunnel needs two portals');
    portals += out.portals.length;
    if (t.route.points.some((p) => p.kind === 'bridge')) bridges++;
    // ribbons
    for (const mode of ['preview', 'highlight']) {
      const rb = buildRibbon(t.route, { groundAt: (x, z) => terrain.groundAt(x, z), mode, chevrons: true });
      assert.ok(rb.vertexCount > 0 && finiteArr(rb.pos));
    }
    const rs = resample(t.route);
    assert.ok(Math.abs(rs[rs.length - 1].s - routeLength(t.route)) < 1e-9);
  }
  assert.ok(portals >= 2);
  assert.ok(bridges >= 1);
});

test('tracks view: animated build draws progressively and clears props', () => {
  const { world, game } = mockRoutes();
  const parent = new THREE.Group();
  const materials = createMaterials(createSharedUniforms());
  const terrain = new Terrain({ parent, materials, world });
  terrain.reveal(world.revealedTiles());
  const before = terrain.stats().props;
  const view = new TracksView({ parent, materials, terrain });
  view.sync(game.state.tracks, true);
  assert.equal(view.tracks.size, game.state.tracks.length);
  assert.ok(terrain.stats().props < before, 'props on the line should be removed');
  const rec = [...view.tracks.values()][0];
  view.update(rec.dur * 0.5);
  const mid = rec.mesh.geometry.drawRange.count;
  assert.ok(mid > 0 && mid < rec.total);
  view.update(rec.dur);
  assert.equal(rec.mesh.geometry.drawRange.count, Infinity);
  view.setPreview([world.findRoutes('Iron Bridge', 'Danube').cheap], 'cheap');
  assert.equal(view.preview.length, 1);
  // glow on chosen tracks, fading out when no longer wanted
  const ids = game.state.tracks.slice(0, 2).map((t) => t.id);
  view.setGlow(new Map([[ids[0], { hovered: false }], [ids[1], { hovered: true }]]));
  view.update(0.5);
  assert.equal(view.glows.size, 2);
  assert.ok(view.glows.get(ids[1]).material.opacity > view.glows.get(ids[0]).material.opacity, 'hovered glows stronger');
  view.setGlow(new Map());
  for (let i = 0; i < 40; i++) view.update(0.1);
  assert.equal(view.glows.size, 0);
  view.dispose();
});

test('train cars sit on the centreline, spaced, facing the direction of travel', () => {
  const { game } = mockRoutes();
  for (const track of game.state.tracks) {
    const pts = track.route.points;
    for (const typeId of Object.keys(TRAIN_TYPES)) {
      const offs = carOffsets(typeId);
      assert.equal(offs.length, 1 + TRAIN_TYPES[typeId].cars);
      for (const t of [0, 0.1, 0.5, 0.93, 1]) {
        for (const forward of [true, false]) {
          const cars = placeCars(track.route, t, forward, offs, null);
          assert.equal(cars.length, offs.length);
          for (const c of cars) {
            assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z));
            assert.ok(distToPolyline({ ...c, y: c.y - RAIL_LIFT }, pts) < 1e-6, 'car off the centreline');
            assert.ok(Math.abs(Math.hypot(c.dx, c.dy, c.dz) - 1) < 1e-6);
          }
          // head faces travel direction
          const s = sampleRoute(track.route, t);
          const sign = forward ? 1 : -1;
          assert.ok(cars[0].dx * s.dx * sign + cars[0].dz * s.dz * sign > 0.5);
          // mid-route: consecutive centres spaced by about the offset difference
          if (t === 0.5 && routeLength(track.route) > 4) {
            for (let i = 1; i < cars.length; i++) {
              const d = Math.hypot(cars[i].x - cars[i - 1].x, cars[i].y - cars[i - 1].y, cars[i].z - cars[i - 1].z);
              const want = offs[i].centre - offs[i - 1].centre;
              assert.ok(d <= want + 1e-6 && d > want * 0.8, `spacing ${d} vs ${want}`);
            }
            assert.ok(cars.every((c) => !c.hidden));
          }
        }
      }
      // at t = 0 going forward, trailing cars clamp at the start and hide
      const atStart = placeCars(track.route, 0, true, offs, null);
      assert.ok(atStart.slice(1).every((c) => c.hidden));
    }
  }
});

test('trains view follows the mock game without errors', () => {
  const { game } = mockRoutes();
  const parent = new THREE.Group();
  const materials = createMaterials(createSharedUniforms());
  const smoke = new Particles(parent, new THREE.IcosahedronGeometry(1, 0), materials.smoke);
  const view = new TrainsView({ parent, materials, smoke, makePaintMaterial: () => new THREE.MeshLambertMaterial({ vertexColors: true }) });
  const flourishes = [];
  view.onTypeChange = (x, y, z, typeId) => flourishes.push(typeId);
  for (let i = 0; i < 120; i++) { game.update(0.05); view.update(game.state, 0.05); smoke.update(0.05); }
  assert.equal(view.trains.size, game.state.trains.length);
  // painted in the type's colour
  for (const rec of view.trains.values()) assert.equal(rec.color, TRAIN_TYPES[rec.typeId].color);
  // upgrading a track swaps its train for the new type, with a flourish
  const t2 = game.state.tracks.find((t) => t.level === 1);
  game.state.money = 1e6;
  assert.ok(game.upgradeTrack(t2.id).ok);
  view.update(game.state, 0.05);
  const rec2 = [...view.trains.values()].find((r) => r.trackId === t2.id);
  assert.equal(rec2.typeId, 'express');
  assert.deepEqual(flourishes, ['express']);
  assert.equal(drawableType('hauler'), 'freight');
  const picks = view.pickables();
  assert.ok(picks.length >= 3);
  for (const p of picks) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  for (const id of game.state.trains.map((t) => t.id)) assert.ok(view.head(id));
  assert.ok(smoke.list.length > 0, 'locos should puff');
  const n = view.trains.size;
  game.state.trains.pop();
  view.update(game.state, 0.05);
  assert.equal(view.trains.size, n - 1);
  for (const typeId of Object.keys(TRAIN_TYPES)) {
    for (const kind of ['loco', 'car']) {
      const b = vehicleBuilders(typeId, kind, 1);
      assert.ok(b.paint.vertexCount > 0 && b.trim.vertexCount > 0 && finiteArr(b.paint.pos) && finiteArr(b.trim.pos));
    }
  }
  view.dispose();
});

test('track grading: rails sit on the land, tunnels stay under the hill', () => {
  const { world, game } = mockRoutes();
  const parent = new THREE.Group();
  const materials = createMaterials(createSharedUniforms());
  const terrain = new Terrain({ parent, materials, world });
  terrain.reveal(world.revealedTiles());
  const view = new TracksView({ parent, materials, terrain });
  view.sync(game.state.tracks, false);
  let n = 0, worst = 0, tunnels = 0;
  for (const t of game.state.tracks) {
    const segs = gradeSegments(t.route, (x, z) => terrain.naturalAt(x, z));
    assert.ok(segs.length > 0);
    for (let k = 1; k < 40; k++) {
      const p = sampleRaw(t.route, k / 40);
      const nat = terrain.naturalAt(p.x, p.z);
      if (p.kind === 'bridge') continue;
      if (p.kind === 'tunnel' && nat > p.y + 0.075 + TUNNEL_COVER + 0.15) { tunnels++; continue; }
      if (p.kind === 'tunnel') continue; // near a portal
      const gap = p.y - terrain.groundAt(p.x, p.z);
      worst = Math.max(worst, Math.abs(gap - 0.03));
      n++;
    }
  }
  assert.ok(n > 50);
  assert.ok(worst < 0.06, `rail to ground gap off by ${worst}`);
  assert.ok(tunnels > 0, 'some tunnel stretch is under the hill');
  view.dispose();
  terrain.dispose();
});

test('stations view: built stations, no fog markers, signposts around the selected station', () => {
  const { world, game } = mockRoutes();
  const parent = new THREE.Group();
  const materials = createMaterials(createSharedUniforms());
  const terrain = new Terrain({ parent, materials, world });
  terrain.reveal(world.revealedTiles());
  const clicks = [];
  const view = new StationsView({ parent, materials, world, labels: null, terrain, onSignClick: (t) => clicks.push(t) });
  view.sync(game.state, false);
  assert.equal(view.built.size, 7);
  const ghosts = [...world.placements.values()].filter((p) => p.state === 'ghost');
  assert.ok(ghosts.length > 0);
  for (let i = 0; i < 5; i++) view.update(0.05, game.state);
  // nothing in the fog: no ghost markers, no ghost picks
  assert.equal(view.target.visible, false);
  assert.ok(view.pickables().every((p) => p.kind === 'station'));
  // selecting a built station stands signposts for its unbuilt links, lead links first
  const st = game.state.stations.get('Locomotive');
  const links = signpostLinks(st, world.placements);
  assert.deepEqual(links.slice(0, 2), st.article.leadLinks.filter((t) => world.placements.get(t)?.state === 'ghost').slice(0, 2));
  assert.ok(links.length > 2 && links.length <= MAX_SIGNPOSTS);
  view.selection = 'Locomotive';
  for (let i = 0; i < 10; i++) view.update(0.05, game.state);
  assert.equal(view.signs.size, links.length);
  const s = view.built.get('Locomotive');
  for (const g of view.signs.values()) {
    assert.ok(Math.abs(Math.hypot(g.x - s.x, g.z - s.z) - SIGN_RING) < 1e-6);
    assert.ok(Number.isFinite(g.y));
    assert.ok(!view.built.has(g.title));
  }
  const signPicks = view.pickables().filter((p) => p.kind === 'ghost');
  assert.equal(new Set(signPicks.map((p) => p.title)).size, links.length);
  // selecting an unbuilt link: signposts go, its marker shows at its (fresh) position
  const target = links[0];
  view.selection = target;
  view.update(0.05, game.state);
  assert.equal(view.signs.size, 0);
  assert.ok(view.target.visible);
  const pl = world.placements.get(target);
  pl.q += 1; // reservations may move
  view.update(0.05, game.state);
  const w = hexToWorld(pl.q, pl.r);
  assert.ok(Math.abs(view.target.position.x - w.x) < 1e-9 && Math.abs(view.target.position.z - w.z) < 1e-9);
  pl.q -= 1;
  view.selection = null;
  view.update(0.05, game.state);
  assert.equal(view.target.visible, false);
  // orientation away from track; station pads are flat
  for (const [title, b] of view.built) {
    const dirs = trackDirsAt(title, game.state.tracks);
    const bx = Math.cos(b.yaw), bz = -Math.sin(b.yaw);
    for (const [ux, uz] of dirs) assert.ok(ux * bx + uz * bz < 0.9, `${title} building sits on a track`);
    assert.ok(Math.abs(terrain.groundAt(b.x + 0.3, b.z) - b.y) < 0.03, `${title} pad not flat`);
  }
  assert.ok(buildStationBuilder('Test', 0.9).vertexCount > 0);
  assert.ok(Number.isFinite(chooseStationYaw('x', [])));
  view.dispose();
});

test('signposts take evenly spaced slots in bearing order', () => {
  const targets = [0.3, 2.0, -2.5, 1.0, -0.9].map((a, k) => ({ title: `t${k}`, x: Math.cos(a) * 6, z: Math.sin(a) * 6 }));
  const lay = layoutSignposts(0, 0, targets, 2.5);
  assert.equal(lay.length, 5);
  for (let k = 1; k < lay.length; k++) {
    assert.ok(lay[k].bearing > lay[k - 1].bearing);
    const d = lay[k].slot - lay[k - 1].slot;
    assert.ok(Math.abs(d - (Math.PI * 2) / 5) < 1e-9);
  }
  for (const L of lay) {
    let diff = Math.abs(L.slot - L.bearing) % (Math.PI * 2);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    assert.ok(diff < 0.9, `${L.title} slot far from its bearing`);
  }
});

test('label culling keeps the higher priority of overlapping labels', () => {
  const show = cullOverlaps([
    { x: 100, y: 100, w: 80, h: 20, priority: 1 },
    { x: 110, y: 104, w: 80, h: 20, priority: 5 },
    { x: 400, y: 100, w: 80, h: 20, priority: 0 },
  ]);
  assert.ok(show.has(1) && show.has(2) && !show.has(0));
  // pinned labels always show and win their space
  const pinned = cullOverlaps([
    { x: 100, y: 100, w: 80, h: 20, priority: 9 },
    { x: 105, y: 100, w: 80, h: 20, priority: 0, pinned: true },
    { x: 110, y: 100, w: 80, h: 20, priority: 0, pinned: true },
  ]);
  assert.ok(pinned.has(1) && pinned.has(2) && !pinned.has(0));
});

test('render/index.js imports in Node without touching the DOM', async () => {
  const mod = await import('./index.js');
  assert.equal(typeof mod.createRenderer, 'function');
});

test('waiting passengers grow more agitated as patience runs out', async () => {
  const { passengerPose, personBodyBuilder, personHeadBuilder } = await import('./stations.js');
  assert.equal(passengerPose(0.9, 1, 0).mood, 0);
  assert.equal(passengerPose(0.4, 1, 0).mood, 1);
  assert.equal(passengerPose(0.1, 1, 0).mood, 2);
  let calmHop = 0, restlessHop = 0, franticHop = 0;
  for (let t = 0; t < 10; t += 0.05) {
    for (const f of [0.9, 0.4, 0.1]) {
      const p = passengerPose(f, t, 1.3);
      for (const v of [p.look, p.hop, p.tilt, p.pace]) assert.ok(Number.isFinite(v));
      assert.ok(p.hop >= 0, 'never sinks into the platform');
    }
    calmHop = Math.max(calmHop, passengerPose(0.9, t, 1.3).hop);
    restlessHop = Math.max(restlessHop, passengerPose(0.4, t, 1.3).hop);
    franticHop = Math.max(franticHop, passengerPose(0.1, t, 1.3).hop);
  }
  assert.equal(calmHop, 0);
  assert.ok(restlessHop > 0 && franticHop > restlessHop * 2);
  for (const g of [personBodyBuilder().toGeometry(), personHeadBuilder().toGeometry()]) {
    assert.ok(g.getAttribute('position').count > 0);
    assert.ok(g.getAttribute('color'), 'needs vertex colours for the shared station material');
  }
});

test('upgrade tags: one per upgradeable track, two for the final choice, glow where affordable', () => {
  const { world, game } = mockRoutes();
  const parent = new THREE.Group();
  const materials = createMaterials(createSharedUniforms());
  const terrain = new Terrain({ parent, materials, world });
  terrain.reveal(world.revealedTiles());
  const clicks = [];
  const tags = new UpgradeTags({ game, labels: null, groundAt: (x, z) => terrain.groundAt(x, z), onClick: (id, typeId) => clicks.push([id, typeId]) });
  game.state.money = 400; // local and express affordable, the finals not
  tags.update(0.016, game.state);
  const st = game.state;
  const upgradeable = st.tracks.filter((t) => t.level < 3);
  assert.equal(tags.tags.size, upgradeable.length);
  for (const tr of st.tracks) {
    const tag = tags.tags.get(tr.id);
    if (tr.level >= 3) { assert.equal(tag, undefined, 'fully upgraded: no tag'); continue; }
    const want = tr.level === 2 ? ['freight', 'bullet'] : tr.level === 1 ? ['express'] : ['local'];
    assert.deepEqual(tag.options.map((o) => o.typeId), want);
    for (const o of tag.options) assert.equal(o.affordable, st.money >= o.cost);
    // floats above the rail over the middle of the track
    const a = tagAnchor(tr.route, (x, z) => terrain.groundAt(x, z));
    assert.ok(Math.abs(tag.x - a.x) < 1e-9 && tag.y > a.railY);
  }
  const glow = tags.glowWanted();
  for (const tr of upgradeable) assert.equal(glow.has(tr.id), tags.tags.get(tr.id).afford);
  assert.ok([...glow.keys()].length > 0 && [...glow.keys()].length < upgradeable.length, 'some affordable, some not');
  assert.ok(tags.pickables().length >= upgradeable.length);
  // buying the last upgrade removes the tag after the next quote
  st.money = 1e6;
  const fin = st.tracks.find((t) => t.level === 2);
  assert.ok(game.upgradeTrack(fin.id, 'bullet').ok);
  tags.refresh();
  tags.update(0.016, st);
  assert.equal(tags.tags.has(fin.id), false);
  assert.deepEqual(quoteOptions({ ok: false, reason: 'x' }), []);
  tags.dispose();
  terrain.dispose();
});

// ------------------------------------------------------------ rewards, plain-word tags, signposts, height

test('signposts say the price and who is waiting to go there', async () => {
  const { signpostInfo } = await import('./stations.js');
  const { world, game } = mockRoutes();
  const st = game.state.stations.get('Locomotive');
  const titles = signpostLinks(st, world.placements);
  assert.ok(titles.length >= 2);
  const thoughts = [
    { id: 1, state: 'waiting', to: titles[0], fare: 100 },
    { id: 2, state: 'waiting', to: titles[0], fare: 110 },
    { id: 3, state: 'riding', to: titles[0], fare: 500 },
    { id: 4, state: 'waiting', to: 'Elsewhere', fare: 50 },
  ];
  game.state.money = 1e6;
  const info = signpostInfo(game, 'Locomotive', titles, thoughts);
  assert.deepEqual([info.get(titles[0]).waiting, info.get(titles[0]).fares], [2, 210]);
  assert.equal(info.get(titles[1]).waiting, 0);
  for (const t of titles) {
    const q = game.quoteBuild('Locomotive', t);
    assert.equal(info.get(t).price, q.cheap.total);
    assert.equal(info.get(t).afford, true);
  }
  game.state.money = 0;
  assert.equal(signpostInfo(game, 'Locomotive', titles, []).get(titles[0]).afford, false);
  // no game, or a quote that fails: no price, nothing thrown
  assert.equal(signpostInfo(null, 'Locomotive', titles, thoughts).get(titles[0]).price, null);
  assert.equal(signpostInfo({ quoteBuild: () => { throw new Error('x'); } }, 'Locomotive', titles, []).get(titles[0]).price, null);
  // the view reads them: waiting passengers in the mock want signposted links
  const view = new StationsView({ parent: new THREE.Group(), materials: createMaterials(createSharedUniforms()), world, labels: null, terrain: null, game });
  view.sync(game.state, false);
  game.state.thoughts.push({ id: 999, from: 'Iron Bridge', to: titles[1], fare: 80, patience: 50, patienceMax: 60, state: 'waiting', at: 'Iron Bridge', trainId: null });
  view.selection = 'Locomotive';
  for (let i = 0; i < 5; i++) view.update(0.05, game.state);
  assert.ok(view.signs.get(titles[1]).want, 'a signpost passengers want stands out');
  view.dispose();
});

test('track tags read as instructions; the first-train goal picks one bare track', async () => {
  const { tagChoices, FIRST_TRAIN_GOAL } = await import('./upgrades.js');
  const opt = (typeId) => ({ typeId, name: TRAIN_TYPES[typeId].name, blurb: TRAIN_TYPES[typeId].blurb, cost: TRAIN_TYPES[typeId].cost, affordable: true });
  assert.equal(tagChoices(0, [opt('local')])[0].title, 'Add train · 120 gold');
  assert.match(tagChoices(0, [opt('local')])[0].sub, /Local/);
  assert.equal(tagChoices(1, [opt('express')])[0].title, 'Upgrade · Express 320 gold');
  assert.deepEqual(tagChoices(2, [opt('freight'), opt('bullet')]).map((o) => o.title), ['Freight 520 gold', 'Bullet 520 gold']);
  const { world, game } = mockRoutes();
  const tags = new UpgradeTags({ game, labels: null, groundAt: () => 0 });
  game.state.goal = { id: FIRST_TRAIN_GOAL, text: '', how: '', progress: 0, target: 1, reward: 1 };
  tags.update(0.016, game.state);
  const bare = game.state.tracks.find((t) => t.level === 0);
  assert.equal(tags.goalTrack, bare.id);
  assert.ok(tags.glowWanted().has(bare.id));
  game.state.goal = { id: 'deliver-5', text: '', how: '', progress: 0, target: 5, reward: 1 };
  tags.update(0.016, game.state);
  assert.equal(tags.goalTrack, null);
  assert.ok(world);
});

test('label placement: a tag steps aside from a signpost instead of covering it', async () => {
  const { placeLabels } = await import('./labels.js');
  const sign = { x: 100, y: 100, w: 120, h: 44, priority: 1e5, pinned: true };
  const tag = { x: 110, y: 104, w: 130, h: 40, priority: 5e4, pinned: true, movable: true };
  const out = placeLabels([sign, tag]);
  assert.ok(out.has(0) && out.has(1));
  assert.deepEqual(out.get(0), { dx: 0, dy: 0 });
  const o = out.get(1);
  assert.ok(o.dx || o.dy, 'tag moved');
  const l1 = 110 + o.dx - 65, r1 = 110 + o.dx + 65, t1 = 104 + o.dy - 20, b1 = 104 + o.dy + 20;
  assert.ok(r1 <= 40 || l1 >= 160 || b1 <= 78 || t1 >= 122, 'no longer overlapping the sign');
  // a dim (not pinned) tag with no free spot yields
  const crowd = [sign];
  for (let dx = -400; dx <= 400; dx += 60) for (let dy = -300; dy <= 300; dy += 30) if (dx || dy) crowd.push({ x: 100 + dx, y: 100 + dy, w: 58, h: 28, priority: 2e5, pinned: true });
  crowd.push({ ...tag, pinned: false, priority: 600 });
  assert.equal(placeLabels(crowd).has(crowd.length - 1), false);
});

test('delivery float shows the streak from 2 and grows with it', async () => {
  const { deliveryFloat } = await import('./index.js');
  assert.deepEqual(deliveryFloat(0), {});
  assert.deepEqual(deliveryFloat(1), {});
  const a = deliveryFloat(2), b = deliveryFloat(6);
  assert.equal(a.streak.trim(), '×2');
  assert.ok(b.scale > a.scale && b.scale <= 1.6);
});

test('mock game: goal, streak, route bonus and goalDone events', async () => {
  const world = createMockWorld();
  const game = createMockGame({ world });
  const seen = { goalDone: [], routeBonus: [], delivered: [] };
  game.on('goalDone', (p) => seen.goalDone.push(p));
  game.on('routeBonus', (p) => seen.routeBonus.push(p));
  game.on('thoughtDelivered', (p) => seen.delivered.push(p));
  await game.start();
  for (let i = 0; i < 600; i++) game.update(0.05);
  assert.equal(game.state.goal.id, 'first-train');
  assert.ok(seen.delivered.length > 0 && seen.delivered.every((p) => Number.isFinite(p.streak) && p.streak >= 1));
  assert.ok(game.state.thoughts.some((t) => t.state === 'waiting' && world.placements.get(t.to)?.state === 'ghost'), 'someone waits for an unbuilt link');
  game.state.money = 1e6;
  const bare = game.state.tracks.find((t) => t.level === 0);
  assert.ok(game.upgradeTrack(bare.id).ok);
  assert.equal(seen.goalDone.length, 1);
  assert.equal(seen.goalDone[0].goal.id, 'first-train');
  const wanted = game.state.thoughts.find((t) => t.state === 'waiting' && world.placements.get(t.to)?.state === 'ghost');
  const linkFrom = [...game.state.stations.values()].find((s) => s.article.links.includes(wanted.to));
  const res = await game.build(linkFrom.title, wanted.to);
  assert.ok(res.ok, res.reason);
  assert.equal(seen.routeBonus.length, 1);
  assert.ok(seen.routeBonus[0].amount > 0 && seen.routeBonus[0].station === wanted.to);
});

test('height: the surface keeps peaks and gorges at their true height; reveals rise without spikes', () => {
  const world = createMockWorld();
  const S = new Surface((q, r) => world.terrainAt(q, r));
  let worst = 0;
  for (const h of hexSpiral(0, 0, 14)) {
    const t = world.terrainAt(h.q, h.r);
    if (t.water) continue;
    worst = Math.max(worst, Math.abs(S.natural(h.q * 3, h.r * 3).h - t.elevation));
  }
  assert.ok(worst < 0.12, `hex centre off its elevation by ${worst}`);
  // reveal next to land that is already drawn: no vertex starts far below where it ends
  const terrain = new Terrain({ parent: new THREE.Group(), materials: createMaterials(createSharedUniforms()), world });
  terrain.reveal(hexSpiral(0, -9, 3).map((h) => world.terrainAt(h.q, h.r)), { animate: false });
  terrain.reveal(hexSpiral(4, -9, 6).map((h) => world.terrainAt(h.q, h.r)), { animate: true, origin: { x: 0, z: 0 } });
  let jump = 0;
  for (const c of terrain.surface.chunks.values()) {
    for (let k = 0; k < c.h.length; k++) if (c.rho[k] > 0.01) jump = Math.max(jump, c.h[k] - c.prev[k]);
  }
  assert.ok(jump < EDGE_SINK + 0.6, `a vertex rises ${jump} during the reveal`);
  terrain.dispose();
});

test('tunnels: trains stay hidden for the whole drawn tunnel', async () => {
  const { buriedSegments, buriedIntervals } = await import('./track.js');
  const { world, game } = mockRoutes();
  const terrain = new Terrain({ parent: new THREE.Group(), materials: createMaterials(createSharedUniforms()), world });
  terrain.reveal(world.revealedTiles());
  const view = new TracksView({ parent: new THREE.Group(), materials: createMaterials(createSharedUniforms()), terrain });
  view.sync(game.state.tracks, false);
  let inside = 0;
  for (const t of game.state.tracks) {
    const rec = view.tracks.get(t.id);
    const S = resample(t.route);
    const { buried } = buriedSegments(t.route, S, (x, z) => terrain.naturalAt(x, z));
    assert.deepEqual(rec.buried, buriedIntervals(S, buried));
    const L = routeLength(t.route);
    for (const [a, b] of rec.buried) {
      for (let s = a + 0.6; s < b - 0.6; s += 0.25) {
        const cars = placeCars(t.route, s / L, true, carOffsets('local'), null, (p) => view.buriedAt(t.id, p.s));
        assert.ok(cars[0].inTunnel, 'loco hidden inside the tunnel');
        inside++;
      }
    }
  }
  assert.ok(inside > 0);
  view.dispose();
});

test('camera: lifts out of hills between it and its target', async () => {
  const { sightLift } = await import('./camera.js');
  const flat = () => 0;
  assert.equal(sightLift({ x: 0, y: 5, z: 0 }, { x: 10, y: 0, z: 0 }, flat), 0);
  const hill = (x) => (x > 3 && x < 5 ? 4 : 0);
  const need = sightLift({ x: 0, y: 3, z: 0 }, { x: 10, y: 0, z: 0 }, hill);
  assert.ok(need > 0);
  assert.equal(sightLift({ x: 0, y: 3 + need + 1e-6, z: 0 }, { x: 10, y: 0, z: 0 }, hill) < 1e-6, true);
});

test('tall bridges: trestles and stone viaduct piers build finite geometry', () => {
  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const u = i / 80;
    pts.push({ x: -6 + u * 9, z: 4, y: 0.2 + Math.sin(u * Math.PI) * 3.5, kind: u > 0.1 && u < 0.9 ? 'bridge' : 'ground' });
  }
  const route = { from: 'a', to: 'b', style: 'cheap', hexes: [], points: pts, length: 0, cost: 0 };
  const out = buildTrack(route, { groundAt: () => 0, naturalAt: () => 0 });
  assert.ok(out.builder.vertexCount > 1000 && finiteArr(out.builder.pos) && finiteArr(out.builder.nor));
  assert.equal(out.portals.length, 0);
  assert.deepEqual(out.buried, []);
});

test('gold: every amount reads as gold, never dollars', async () => {
  const { gold } = await import('./format.js');
  assert.equal(gold(326), '326 gold');
  assert.equal(gold(1234.6), '1,235 gold');
  assert.equal(`+${gold(140)}`, '+140 gold');
  assert.ok(!gold(5).includes('$'));
  assert.equal(`Add train · ${gold(120)}`, 'Add train · 120 gold');
});

test('tickets: a destination reads "Ticket · +N gold", an unbuilt start "Ticket start"', async () => {
  const { ticketBadge } = await import('./format.js');
  const tickets = [
    { id: 1, from: 'A', to: 'B', reward: 650 },
    { id: 2, from: 'C', to: 'B', reward: 700 },
    { id: 3, from: 'B', to: 'D', reward: 100 },
  ];
  assert.deepEqual(ticketBadge('B', tickets), { kind: 'to', reward: 700, text: 'Ticket · +700 gold' });
  assert.equal(ticketBadge('C', tickets).text, 'Ticket start');
  assert.equal(ticketBadge('D', tickets).kind, 'to');
  assert.equal(ticketBadge('Z', tickets), null);
  assert.equal(ticketBadge('B', undefined), null);
});

test('mock game: tickets exist, complete with ticketDone, and stations have mixed thumbnails', async () => {
  const world = createMockWorld();
  const game = createMockGame({ world });
  const seen = { added: [], done: [] };
  game.on('ticketAdded', (p) => seen.added.push(p));
  game.on('ticketDone', (p) => seen.done.push(p));
  await game.start();
  assert.ok(game.state.tickets.length > 0 && game.state.tickets.length <= 3);
  assert.equal(seen.added.length, game.state.tickets.length);
  game.state.money = 1e6;
  const t = game.state.tickets.find((x) => game.state.stations.has(x.from));
  const res = await game.build(t.from, t.to);
  assert.ok(res.ok, res.reason);
  assert.equal(seen.done.length, 1);
  assert.equal(seen.done[0].ticket.to, t.to);
  assert.ok(!game.state.tickets.includes(t));
  const thumbs = [...game.state.stations.values()].map((s) => s.article.thumbnail);
  assert.ok(thumbs.some((x) => x) );
});

test('article cards: pose floats above the station and turns; crop covers; initial letter', async () => {
  const { cardPose, coverCrop, cardInitial, ArticleCards, CARD_LIFT, CARD_PICK_R } = await import('./cards.js');
  const st = { x: 2, y: 1, z: -3 };
  const a = cardPose(st, 0, 0), b = cardPose(st, 2, 0);
  assert.ok(a.y > st.y + CARD_LIFT - 0.1 && a.y < st.y + CARD_LIFT + 0.1);
  assert.equal(a.x, 2); assert.equal(a.z, -3);
  assert.ok(b.yaw > a.yaw);
  const wide = coverCrop(400, 100), tall = coverCrop(100, 400);
  assert.ok(wide.rx < 1 && wide.ry === 1 && Math.abs(wide.ox - (1 - wide.rx) / 2) < 1e-9);
  assert.ok(tall.ry < 1 && tall.rx === 1);
  assert.deepEqual(coverCrop(0, 0), { rx: 1, ry: 1, ox: 0, oy: 0 });
  assert.equal(cardInitial('  steam engine'), 'S');
  assert.equal(cardInitial(''), '?');

  // a card per built station; falls back to a letter when there is no picture; picks as 'article'
  const loads = [];
  const cards = new ArticleCards({
    parent: new THREE.Group(),
    loadTexture: (url, ok, fail) => loads.push({ url, ok, fail }),
    letterTexture: () => new THREE.Texture(),
  });
  const built = new Map([['A', { x: 0, y: 0, z: 0, born: null }], ['B', { x: 5, y: 0, z: 0, born: null }]]);
  const state = { stations: new Map([['A', { article: { thumbnail: 'https://upload.wikimedia.org/a.jpg' } }], ['B', { article: { thumbnail: null } }]]) };
  cards.update(0.016, built, state);
  assert.equal(cards.cards.size, 2);
  assert.deepEqual(loads.map((l) => l.url), ['https://upload.wikimedia.org/a.jpg']);
  assert.ok(cards.cards.get('A').tex && cards.cards.get('B').tex, 'both show something at once');
  loads[0].fail();
  assert.ok(cards.cards.get('A').tex, 'a failed picture keeps the letter card');
  const picks = cards.pickables();
  assert.equal(picks.length, 2);
  assert.equal(picks[0].kind, 'article');
  assert.equal(picks[0].title, 'A');
  assert.ok(picks[0].r >= CARD_PICK_R && picks[0].y > 1);
  built.delete('B');
  cards.update(0.016, built, state);
  assert.equal(cards.cards.size, 1);
  cards.dispose();
});

// ------------------------------------------------------------ lanes and crossings

/** A straight route from (x0, z0) to (x1, z1); y(u) gives the rail height, kind(u) its kind. */
function lineRoute(x0, z0, x1, z1, y, kind = () => 'ground', n = 80) {
  const points = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    points.push({ x: x0 + (x1 - x0) * u, z: z0 + (z1 - z0) * u, y: typeof y === 'function' ? y(u) : y, kind: kind(u) });
  }
  return { from: 'a', to: 'b', style: 'cheap', hexes: [], points, length: 0, cost: 0 };
}
const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const lowerDist = (p, route) => {
  let best = Infinity;
  for (let i = 0; i + 1 < route.points.length; i++) {
    const a = route.points[i], b = route.points[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z));
  }
  return best;
};

test('piers skip every spot within a track-width of another track beneath the bridge', () => {
  // a ground track along x at rail height 0.3; another crosses over it on a bridge (not flagged anywhere:
  // the check is geometric, against all built tracks), standing 1.5 above the land
  const lower = lineRoute(-4, 0, 4, 0, 0.3);
  const upper = lineRoute(0.0, -5, 0.0, 5, (u) => 1.8, (u) => (u > 0.1 && u < 0.9 ? 'bridge' : 'ground'), 200);
  const net = new Network();
  net.set('lower', lower); net.set('upper', upper);
  const env = { groundAt: () => 0.2, naturalAt: () => 0.2, network: net, id: 'upper' };
  const withNet = buildTrack(upper, env);
  const bare = buildTrack(upper, { groundAt: env.groundAt, naturalAt: env.naturalAt });
  assert.ok(bare.supports.some((s) => Math.abs(s.z) < LANES.pierClear), 'without the lower track a pier would stand on it');
  assert.ok(withNet.supports.length >= 4, 'piers elsewhere along the bridge');
  for (const s of withNet.supports) assert.ok(lowerDist(s, lower) >= LANES.pierClear - 1e-9, `support at z=${s.z} too close to the lower track`);
  const abut = withNet.supports.filter((s) => s.type === 'abutment');
  assert.equal(abut.length, 2, 'an abutment each side of the span');
  assert.ok(abut[0].z * abut[1].z < 0, 'one either side');
  assert.ok(finiteArr(withNet.builder.pos));
});

test('a track passing under a bridge is not touched: its own piers and grading stay clear', () => {
  const lower = lineRoute(-4, 0, 4, 0, 0.3, (u) => (u > 0.3 && u < 0.7 ? 'bridge' : 'ground'));
  const upper = lineRoute(0.0, -5, 0.0, 5, (u) => 1.8, (u) => (u > 0.1 && u < 0.9 ? 'bridge' : 'ground'), 200);
  const net = new Network(); net.set('lower', lower); net.set('upper', upper);
  // seen from below, the upper track is above it, not under it: the lower bridge keeps its piers
  const S = resample(lower);
  const kinds = S.slice(0, -1).map((p) => p.kind);
  const sup = planSupports({ S, kinds, buried: kinds.map(() => false), groundAt: () => 0.2, net, selfId: 'lower' });
  assert.ok(sup.some((p) => p.type === 'pier'));
  // the upper track's ramps are not graded up over the lower track, and nothing is graded where it bridges
  const segs = gradeSegments(upper, () => 0.2, { network: net, id: 'upper' });
  for (const sg of segs) assert.ok(Math.min(Math.abs(sg.az), Math.abs(sg.bz)) > 0.5, 'graded under the lower track');
  const plain = gradeSegments(upper, () => 0.2);
  assert.ok(plain.length >= segs.length);
});

test('mock flyover: marked over, clear of the lower rails, nothing stands within a track-width of them', () => {
  const { game } = mockRoutes();
  const st = game.state;
  const net = new Network();
  for (const t of st.tracks) net.set(t.id, t.route);
  const fly = st.tracks.find((t) => t.route.hexes.some((h) => h.over));
  assert.ok(fly, 'the demo has a flyover');
  const lowerT = st.tracks.find((t) => t.route.hexes.some((h) => h.under));
  assert.ok(lowerT && lowerT !== fly);
  assert.ok(fly.route.points.some((p) => p.kind === 'bridge'));
  // geometric crossing: where the two centrelines meet, the upper rail is at least crossingClearance higher
  let found = null;
  const F = fly.route.points, B = lowerT.route.points;
  for (let i = 0; i + 1 < F.length && !found; i++) for (let j = 0; j + 1 < B.length && !found; j++) {
    const p = F[i], q = F[i + 1], r = B[j], s = B[j + 1];
    const d1x = q.x - p.x, d1z = q.z - p.z, d2x = s.x - r.x, d2z = s.z - r.z, den = d1x * d2z - d1z * d2x;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((r.x - p.x) * d2z - (r.z - p.z) * d2x) / den, u = ((r.x - p.x) * d1z - (r.z - p.z) * d1x) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) found = { fy: p.y + (q.y - p.y) * t, by: r.y + (s.y - r.y) * u };
  }
  assert.ok(found, 'the two tracks cross');
  assert.ok(found.fy - found.by >= WORLD.crossingClearance, `clearance ${found.fy - found.by}`);
  // supports of every track keep clear of any track below them (not only at over hexes)
  for (const t of st.tracks) {
    const out = buildTrack(t.route, { groundAt: () => 0, naturalAt: () => 0, network: net, id: t.id });
    for (const sp of out.supports) {
      const y = t.route.points.reduce((b, p) => (distXZ(p, sp) < distXZ(b, sp) ? p : b)).y;
      const o = nearestOther(net, t.id, sp.x, sp.z, LANES.pierClear, { below: y - LANES.sameLevel });
      assert.equal(o, null, `support of track ${t.id} stands within ${LANES.pierClear} of track ${o && o.id}`);
    }
    if (t === fly) {
      assert.ok(out.supports.some((sp) => sp.type === 'abutment'), 'flyover has abutments');
      assert.ok(finiteArr(out.builder.pos) && finiteArr(out.builder.nor));
    }
  }
});

test('mock shared rails: routes ride the trunk, fork off tangentially, and draw no second set of rails', () => {
  const { game } = mockRoutes();
  const st = game.state;
  const trunk = st.tracks.find((t) => t.from === 'Locomotive' && t.to === 'Grand Canyon');
  const riders = st.tracks.filter((t) => t.route.hexes.some((h) => h.shared));
  assert.equal(riders.length, 3, 'three routes ride the trunk: two fork off, one joins');
  const net = new Network();
  for (const t of st.tracks) net.set(t.id, t.route);
  for (const t of riders) {
    const d = t.route.points.map((p) => lowerDist(p, trunk.route));
    const on = d.filter((x) => x < 0.03).length;
    assert.ok(on >= 20, `track ${t.id} runs on the trunk's rails (${on} points)`);
    // the fork: its own rails start on the trunk's centreline and leave smoothly (no jump)
    const first = d.findIndex((x, i) => i > 4 && x >= 0.03), last = d.length - 1 - [...d].reverse().findIndex((x, i) => i > 4 && x >= 0.03);
    const edge = t.from === 'Iron Bridge' ? last : first;
    assert.ok(d[edge + (edge === last ? 1 : -1)] < 0.03, 'the diverging rails start on the trunk centreline');
    assert.ok(Math.abs(d[edge] - d[edge + (edge === last ? 1 : -1)]) < 0.2, 'and leave it without a jump');
    assert.ok(Math.max(...d) > 3, 'then really split away');
    // drawn once: no vertices for the shared segments
    const out = buildTrack(t.route, { groundAt: () => 0, naturalAt: () => 0, network: net, id: t.id });
    const full = buildTrack(t.route, { groundAt: () => 0, naturalAt: () => 0 });
    assert.ok(out.builder.vertexCount < full.builder.vertexCount * 0.85, 'shared stretch not drawn again');
    const idle = out.marks.filter((m, i) => i > 0 && m.v === out.marks[i - 1].v).length;
    assert.ok(idle >= 15, `${idle} shared segments emit nothing`);
    assert.ok(finiteArr(out.builder.pos));
  }
  // the trunk itself is whole (it was drawn first)
  const tOut = buildTrack(trunk.route, { groundAt: () => 0, naturalAt: () => 0, network: net, id: trunk.id });
  assert.equal(tOut.marks.filter((m, i) => i > 0 && m.v === tOut.marks[i - 1].v).length, 0);
});

test('lanes: tracks side by side keep a lane apart and their beds merge without overlap', () => {
  // two straight lanes: each bed stops at the line half way between them
  const a = lineRoute(-3, 0, 3, 0, 0.5), b = lineRoute(-3, WORLD.laneSpacing, 3, WORLD.laneSpacing, 0.5);
  const n2 = new Network(); n2.set('a', a); n2.set('b', b);
  const outA = buildTrack(a, { groundAt: () => 0.2, naturalAt: () => 0.2, network: n2, id: 'a' });
  const outB = buildTrack(b, { groundAt: () => 0.2, naturalAt: () => 0.2, network: n2, id: 'b' });
  const mid = WORLD.laneSpacing / 2;
  let maxA = -Infinity, minB = Infinity;
  for (let i = 2; i < outA.builder.pos.length; i += 3) maxA = Math.max(maxA, outA.builder.pos[i]);
  for (let i = 2; i < outB.builder.pos.length; i += 3) minB = Math.min(minB, outB.builder.pos[i]);
  assert.ok(maxA <= mid + 1e-6 && minB >= mid - 1e-6, `beds overlap: ${maxA} vs ${minB}`);
  // a lone track keeps its full bed
  const lone = buildTrack(a, { groundAt: () => 0.2, naturalAt: () => 0.2 });
  let maxLone = -Infinity;
  for (let i = 2; i < lone.builder.pos.length; i += 3) maxLone = Math.max(maxLone, lone.builder.pos[i]);
  assert.ok(maxLone > mid + 0.1);
});

test('trains in neighbouring lanes pass side by side without their meshes meeting', () => {
  for (const id of Object.keys(CAR_SPECS)) {
    assert.ok(trainWidth(id) <= WORLD.laneSpacing - 0.04, `${id} is ${trainWidth(id)} wide for a lane of ${WORLD.laneSpacing}`);
  }
  // two lanes round a bend, every train type against every other, cars shifted against each other
  const bend = (off) => {
    const points = [];
    for (let i = 0; i <= 120; i++) {
      const u = i / 120, a = u * 2.4;
      const R = 3 - off; // concentric: the inner lane is tighter
      points.push({ x: Math.sin(a) * R, z: -3 + Math.cos(a) * R, y: 0.3, kind: 'ground' });
    }
    return { from: 'a', to: 'b', style: 'cheap', hexes: [], points, length: 0, cost: 0 };
  };
  const laneA = bend(0), laneB = bend(WORLD.laneSpacing);
  const corners = (p, halfLen, halfW) => {
    const fx = p.dx, fz = p.dz, rx = -fz, rz = fx;
    return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [p.x + fx * halfLen * a + rx * halfW * b, p.z + fz * halfLen * a + rz * halfW * b]);
  };
  const sat = (P, Q) => {
    for (const poly of [P, Q]) {
      for (let i = 0; i < 4; i++) {
        const a = poly[i], b = poly[(i + 1) % 4];
        const nx = -(b[1] - a[1]), nz = b[0] - a[0];
        const proj = (pts) => { let lo = Infinity, hi = -Infinity; for (const c of pts) { const d = c[0] * nx + c[1] * nz; lo = Math.min(lo, d); hi = Math.max(hi, d); } return [lo, hi]; };
        const [l1, h1] = proj(P), [l2, h2] = proj(Q);
        if (h1 < l2 || h2 < l1) return false; // a separating axis: no overlap
      }
    }
    return true;
  };
  let overlaps = 0, checked = 0;
  for (const ta of Object.keys(CAR_SPECS)) for (const tb of Object.keys(CAR_SPECS)) {
    const oa = carOffsets(ta), ob = carOffsets(tb);
    for (let k = 0; k <= 12; k++) {
      const pa = placeCars(laneA, 0.5 + k * 0.03, true, oa), pb = placeCars(laneB, 0.6 + k * 0.02, true, ob);
      for (let i = 0; i < pa.length; i++) for (let j = 0; j < pb.length; j++) {
        checked++;
        if (sat(corners(pa[i], oa[i].half, trainWidth(ta) / 2), corners(pb[j], ob[j].half, trainWidth(tb) / 2))) overlaps++;
      }
    }
  }
  assert.ok(checked > 500);
  assert.equal(overlaps, 0, 'cars in neighbouring lanes intersect');
});

test('upgrade tags of tracks in one corridor hang over their own stretch, not on top of each other', () => {
  const { game } = mockRoutes();
  const st = game.state;
  const net = new Network();
  for (const t of st.tracks) net.set(t.id, t.route);
  const taken = [];
  const anchors = [];
  for (const t of st.tracks) {
    const a = tagAnchor(t.route, () => 0, { network: net, id: t.id, taken });
    taken.push(a); anchors.push({ id: t.id, a });
    assert.ok(lowerDist(a, t.route) < 0.02, 'the tag floats over its own track');
  }
  for (const k of anchors) {
    const near = nearestOther(net, k.id, k.a.x, k.a.z, 5);
    assert.ok(near, 'there is another track');
  }
  for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) {
    assert.ok(distXZ(anchors[i].a, anchors[j].a) > 0.8, `tags of tracks ${anchors[i].id} and ${anchors[j].id} are ${distXZ(anchors[i].a, anchors[j].a).toFixed(2)} apart`);
  }
  // the track that splits off north has a stretch of its own: its tag floats over that, not over the corridor
  const split = st.tracks.find((t) => t.from === 'Locomotive' && t.to === 'Simplon Tunnel');
  const at = anchors.find((k) => k.id === split.id).a;
  const o = nearestOther(net, split.id, at.x, at.z, 3);
  assert.ok(!o || o.d > 0.8, 'tag of the splitting track over a stretch where it runs alone');
});

test('a signpost the surveyor pointed at says so', async () => {
  const { ticketBadge } = await import('./format.js');
  const tickets = [{ id: 1, from: 'A', to: 'Far', reward: 900, hint: { from: 'A', to: 'Step' } }];
  assert.deepEqual(ticketBadge('Step', tickets), { kind: 'hint', text: 'Surveyor: build here next' });
  assert.equal(ticketBadge('Far', tickets).kind, 'to');
  assert.equal(ticketBadge('Other', tickets), null);
});
