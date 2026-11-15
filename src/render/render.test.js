// Node smoke tests for the non-GPU parts of the renderer: run with `node --test src/render/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BIOMES, TRAIN_TYPES } from '../config.js';
import { hexToWorld, hexSpiral } from '../hex.js';
import { sampleRoute, routeLength, RAIL_LIFT } from './rail.js';
import { createMockWorld, createMockGame, MOCK_TRACKS, mockTerrain } from './mock.js';
import { tileColors } from './palette.js';
import { layoutTileProps, buildPropGeometryBuilders, PROP_TYPES } from './props.js';
import { Terrain, tileTransforms, buildCapGeometry, buildWallGeometry } from './terrain.js';
import { createSharedUniforms, createMaterials } from './materials.js';
import { buildTrack, buildRibbon, vertexCountAt, resample } from './track.js';
import { carOffsets, placeCars, previousTrack, TrainsView, vehicleBuilders } from './trains.js';
import { buildStationBuilder, chooseStationYaw, StationsView, trackDirsAt } from './stations.js';
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

test('prop, cap and wall geometries are finite and non-empty', () => {
  const b = buildPropGeometryBuilders();
  for (const t of PROP_TYPES) {
    assert.ok(b[t].vertexCount > 0 && b[t].vertexCount % 3 === 0, t);
    assert.ok(finiteArr(b[t].pos) && finiteArr(b[t].nor) && finiteArr(b[t].col), t);
  }
  for (const g of [buildCapGeometry(), buildWallGeometry()]) assert.ok(g.vertexCount > 0 && finiteArr(g.pos));
});

test('terrain instancing: 4000+ tiles, finite matrices, reveal animation settles', () => {
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
  assert.ok(st.water > 50);
  assert.ok(st.clouds > 50);
  assert.ok(st.animating > 0);
  for (let i = 0; i < 40; i++) terrain.update(0.05); // 2 s > 0.9 s ripple
  assert.equal(terrain.stats().animating, 0);
  for (const pool of [terrain.capPool, terrain.wallPool, terrain.waterPool, ...Object.values(terrain.propPools)]) {
    for (const ch of pool.chunks) assert.ok(finiteArr(ch.mesh.instanceMatrix.array.subarray(0, ch.mesh.count * 16)), pool.name);
  }
  // re-reveal is a no-op
  assert.equal(terrain.reveal(tiles.slice(0, 10)), 0);
  // a settled tile's cap sits at its elevation
  const tr = tileTransforms(tiles[5], 1);
  assert.ok(Math.abs(tr.capY - (tiles[5].water ? tiles[5].elevation - 0.42 : tiles[5].elevation)) < 1e-9);
  assert.ok(ms < 5000, `reveal took ${ms} ms`);
  terrain.dispose();
});

test('mock network builds: tracks with bridge, tunnel and ledge stretches', () => {
  const { game } = mockRoutes();
  const st = game.state;
  assert.equal(st.stations.size, 7);
  assert.equal(st.tracks.length, MOCK_TRACKS.length);
  assert.equal(st.lines.length, 2);
  assert.equal(st.trains.length, 3);
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
    const out = buildTrack(t.route, { groundAt: (x, z) => terrain.groundAt(x, z) });
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
  view.setPreview(world.findRoutes('Iron Bridge', 'Danube') ? Object.values(world.findRoutes('Iron Bridge', 'Danube')).filter((r) => r && r.points) : null, 'direct');
  assert.equal(view.preview.length, 2);
  view.setHighlight(1, game.state);
  assert.ok(view.highlight.meshes.length >= 3);
  view.setHighlight(null, game.state);
  assert.equal(view.highlight.meshes.length, 0);
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

test('trailing cars continue onto the previous track of the line', () => {
  const { game } = mockRoutes();
  const st = game.state;
  const line = st.lines[0];
  const a = line.stations[0], b = line.stations[1], c = line.stations[2];
  const t1 = game.trackBetween(a, b), t2 = game.trackBetween(b, c);
  const forward = t2.from === b;
  const train = { id: 99, typeId: 'hauler', lineId: line.id, trackId: t2.id, t: forward ? 0 : 1, forward, atStation: b };
  const prev = previousTrack(st, train, t2);
  assert.ok(prev && prev.route === t1.route);
  const cars = placeCars(t2.route, train.t, forward, carOffsets('hauler'), prev);
  for (const car of cars.slice(1)) {
    assert.ok(!car.hidden);
    assert.ok(distToPolyline({ ...car, y: car.y - RAIL_LIFT }, t1.route.points) < 1e-6, 'trailing car should be on the previous track');
  }
});

test('trains view follows the mock game without errors', () => {
  const { game } = mockRoutes();
  const parent = new THREE.Group();
  const materials = createMaterials(createSharedUniforms());
  const smoke = new Particles(parent, new THREE.IcosahedronGeometry(1, 0), materials.smoke);
  const view = new TrainsView({ parent, materials, smoke, makePaintMaterial: () => new THREE.MeshLambertMaterial({ vertexColors: true }) });
  for (let i = 0; i < 120; i++) { game.update(0.05); view.update(game.state, 0.05); smoke.update(0.05); }
  assert.equal(view.trains.size, 3);
  const picks = view.pickables();
  assert.ok(picks.length >= 3);
  for (const p of picks) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  for (const id of game.state.trains.map((t) => t.id)) assert.ok(view.head(id));
  assert.ok(smoke.list.length > 0, 'locos should puff');
  game.state.trains.pop();
  view.update(game.state, 0.05);
  assert.equal(view.trains.size, 2);
  for (const typeId of Object.keys(TRAIN_TYPES)) {
    for (const kind of ['loco', 'car']) {
      const b = vehicleBuilders(typeId, kind, 1);
      assert.ok(b.paint.vertexCount > 0 && b.trim.vertexCount > 0 && finiteArr(b.paint.pos) && finiteArr(b.trim.pos));
    }
  }
  view.dispose();
});

test('stations view: built, ghosts, bubbles, orientation away from track', () => {
  const { world, game } = mockRoutes();
  const parent = new THREE.Group();
  const materials = createMaterials(createSharedUniforms());
  const view = new StationsView({ parent, materials, world, labels: null });
  view.sync(game.state, false);
  assert.equal(view.built.size, 7);
  assert.equal(view.ghosts.size, 8);
  view.selection = 'Locomotive';
  view.hover = 'Danube';
  for (let i = 0; i < 10; i++) view.update(0.05, game.state);
  assert.ok(view.selectMesh.visible);
  const waiting = [...game.state.stations.values()].reduce((s, x) => s + Math.min(8, x.waiting.length), 0);
  assert.equal(view.bubbles.mesh.count, waiting);
  for (const p of view.pickables()) assert.ok(Number.isFinite(p.x + p.y + p.z));
  // building direction keeps away from every track leaving the station
  for (const [title, s] of view.built) {
    const dirs = trackDirsAt(title, game.state.tracks);
    const bx = Math.cos(s.yaw), bz = -Math.sin(s.yaw);
    for (const [ux, uz] of dirs) assert.ok(ux * bx + uz * bz < 0.9, `${title} building sits on a track`);
  }
  const b = buildStationBuilder('Test', 0.9);
  assert.ok(b.vertexCount > 0 && finiteArr(b.pos));
  assert.ok(Number.isFinite(chooseStationYaw('x', [])));
  view.dispose();
});

test('label culling keeps the higher priority of overlapping labels', () => {
  const show = cullOverlaps([
    { x: 100, y: 100, w: 80, h: 20, priority: 1 },
    { x: 110, y: 104, w: 80, h: 20, priority: 5 },
    { x: 400, y: 100, w: 80, h: 20, priority: 0 },
  ]);
  assert.ok(show.has(1) && show.has(2) && !show.has(0));
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
