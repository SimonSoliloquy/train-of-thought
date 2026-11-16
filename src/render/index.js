// The 3D view: a low-poly diorama in three.js. Implements `Renderer` from src/types.js.
// Importing this module has no side effects; everything happens in createRenderer().
import * as THREE from 'three';
import { SKY } from './palette.js';
import { createSharedUniforms, createMaterials, createSkyMaterial, addMist } from './materials.js';
import { Terrain, buildCloudGeometry, REVEAL_DUR } from './terrain.js';
import { StationsView } from './stations.js';
import { TracksView } from './tracks-view.js';
import { TrainsView, disposeTrainGeometries } from './trains.js';
import { Particles, DynamicInstances } from './dynamic.js';
import { LabelLayer } from './labels.js';
import { CameraRig } from './camera.js';
import { UpgradeTags } from './upgrades.js';
import { ArticleCards } from './cards.js';
import { gold } from './format.js';
import { hexToWorld, worldToHex, hexKey, mulberry32 } from '../hex.js';
import { TRAIN_TYPES } from '../config.js';

const SUN_DIR = new THREE.Vector3(0.55, 0.78, 0.32).normalize();

/** How the rising "+N gold" looks for a delivery at a given streak: "×3" shown from 2, growing a little. Pure. */
export function deliveryFloat(streak) {
  const s = Number.isFinite(streak) ? Math.floor(streak) : 0;
  if (s < 2) return {};
  return { streak: ` \u00d7${s}`, scale: 1 + Math.min(0.55, (s - 1) * 0.07), rise: 0.9 + Math.min(0.5, s * 0.04) };
}

/**
 * @param {{container: HTMLElement, game: import('../types.js').Game, world: import('../types.js').World}} opts
 * @returns {import('../types.js').Renderer}
 */
// plain: show the map and the trains only: no station names, no prices, no gold anywhere
// (Rail Builder, github.com/SimonSoliloquy/railbuilder, which copies this engine).
export function createRenderer({ container, game, world, plain = false }) {
  const warned = new Set();
  const safe = (tag, fn) => {
    try { return fn(); } catch (err) {
      if (!warned.has(tag)) { warned.add(tag); console.error(`[render] ${tag} failed`, err); }
      return undefined;
    }
  };
  const S = () => (game && game.state) || {};

  // ------------------------------------------------------------ renderer, scene, camera
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY.mist);
  scene.fog = new THREE.Fog(new THREE.Color(SKY.mist), 30, 90);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1600);

  const uniforms = createSharedUniforms();
  const materials = createMaterials(uniforms, REVEAL_DUR);

  // sky dome + mist sea
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), createSkyMaterial(SUN_DIR));
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);
  const mist = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), materials.mistPlane);
  mist.rotation.x = -Math.PI / 2;
  mist.scale.set(1400, 1400, 1);
  mist.position.y = -1.0;
  mist.receiveShadow = false;
  scene.add(mist);

  // lights
  const hemi = new THREE.HemisphereLight(0xdbe9ff, 0x9a8466, 1.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe4bd, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 3;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 140;
  scene.add(sun, sun.target);
  let shadowExtent = 0;

  const world3d = new THREE.Group();
  world3d.name = 'world';
  scene.add(world3d);

  // ------------------------------------------------------------ subsystems
  const labels = new LabelLayer(container);
  if (plain) labels.floatText = () => {}; // sparkles still fly; nothing is written over the map
  const terrain = new Terrain({ parent: world3d, materials, world });
  const smoke = new Particles(world3d, new THREE.IcosahedronGeometry(1, 0), materials.smoke, { kind: 'smoke', capacity: 256, renderOrder: 8 });
  const sparkles = new Particles(world3d, new THREE.OctahedronGeometry(1, 0), materials.sparkle, { kind: 'sparkle', capacity: 256, renderOrder: 9 });
  // confetti: solid (not additive) paper flakes, so the colours stay bright over pale ground
  const confettiMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false });
  const confettiGeom = new THREE.PlaneGeometry(1, 0.55);
  const confettiFx = new Particles(world3d, confettiGeom, confettiMat, { kind: 'sparkle', capacity: 256, renderOrder: 9 });
  let buildOffer = null;      // {title, label, sub, affordable} from the UI: the on-map Build button
  let buildOfferShown = false;
  let holderKeys = new Set(); // labels of ticket holders currently shown
  const pickHandlers = new Set();
  const emitPick = (pick) => { for (const h of [...pickHandlers]) safe('pick handler', () => h(pick)); };
  const stations = new StationsView({
    parent: world3d, materials, world, labels, terrain, game, plain,
    onSignClick: (title) => emitPick({ kind: 'ghost', title }),
    onBuiltFx: (x, y, z) => {
      sparkles.burst(x, y + 0.3, z, 26, '#fff0b8', { speed: 1.0, up: 1.6 });
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        smoke.emit(x + Math.cos(a) * 0.3, y + 0.05, z + Math.sin(a) * 0.3, 1, { vx: Math.cos(a) * 0.5, vz: Math.sin(a) * 0.5, vy: 0.12, size: 0.09, grow: 0.12, life: 0.8 });
      }
    },
  });
  stations.blockFn = (circles) => terrain.block(circles);
  stations.isClear = (x, z) => terrain.isClear(x, z);
  const tracks = new TracksView({
    parent: world3d, materials, terrain,
    fx: (x, y, z, kind) => {
      if (Math.random() < 0.5) sparkles.emit(x, y + 0.05, z, 1, { vx: (Math.random() - 0.5) * 0.6, vy: 0.6 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.6, size: 0.03, life: 0.5, color: kind === 'tunnel' ? '#c7a6ff' : '#ffe08a', gravity: 1.5 });
    },
  });
  const trains = new TrainsView({
    parent: world3d, materials, smoke,
    // hide cars exactly where the drawn track goes underground, for the whole tunnel
    buriedAt: (trackId, s) => tracks.buriedAt(trackId, s),
    groundAt: (x, z) => terrain.groundAt(x, z),
    naturalAt: (x, z) => terrain.naturalAt(x, z),
    makePaintMaterial: () => addMist(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), uniforms),
    // a track's train was replaced by an upgrade: a little flourish where it stood
    onTypeChange: (x, y, z, typeId) => {
      sparkles.burst(x, y + 0.25, z, 30, TRAIN_TYPES[typeId] ? TRAIN_TYPES[typeId].color : '#ffe08a', { speed: 1.1, up: 1.7, life: 0.9 });
      sparkles.burst(x, y + 0.25, z, 14, '#fff2b0', { speed: 0.7, up: 2.0, life: 0.8 });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        smoke.emit(x + Math.cos(a) * 0.2, y + 0.05, z + Math.sin(a) * 0.2, 1, { vx: Math.cos(a) * 0.45, vz: Math.sin(a) * 0.45, vy: 0.15, size: 0.07, grow: 0.1, life: 0.7 });
      }
    },
  });
  const cards = new ArticleCards({ parent: world3d });
  const upgrades = new UpgradeTags({
    game, labels, plain,
    groundAt: (x, z) => terrain.groundAt(x, z),
    network: tracks.network,
    onClick: (trackId, typeId) => emitPick({ kind: 'upgrade', trackId, typeId }),
  });
  terrain.onChange = (box) => tracks.terrainChanged(box);
  const rig = new CameraRig(camera, canvas);

  // ambient clouds drifting over the unrevealed void
  const ambientGeom = buildCloudGeometry().toGeometry();
  const ambient = new DynamicInstances(world3d, ambientGeom, materials.cloud, 64, { renderOrder: 3 });
  const ambientClouds = [];
  {
    const rnd = mulberry32(4242);
    for (let i = 0; i < 46; i++) {
      const a = rnd() * Math.PI * 2, r = 6 + rnd() * 46;
      ambientClouds.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, y: -0.45 + rnd() * 1.2, s: 1.4 + rnd() * 2.2, yaw: rnd() * 6, v: 0.05 + rnd() * 0.12, vis: 1 });
    }
  }
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  function updateAmbient(dt) {
    ambient.begin();
    for (const c of ambientClouds) {
      c.x += c.v * dt; c.z += c.v * 0.35 * dt;
      const tx = rig.target.x, tz = rig.target.z;
      if (c.x - tx > 55) c.x -= 110; else if (c.x - tx < -55) c.x += 110;
      if (c.z - tz > 55) c.z -= 110; else if (c.z - tz < -55) c.z += 110;
      const h = worldToHex(c.x, c.z);
      const over = terrain.has(h.q, h.r) || terrain.has(h.q + 1, h.r) || terrain.has(h.q - 1, h.r) || terrain.has(h.q, h.r + 1) || terrain.has(h.q, h.r - 1);
      c.vis += ((over ? 0 : 1) - c.vis) * Math.min(1, dt * 2);
      if (c.vis < 0.02) continue;
      const k = c.s * c.vis;
      _m.compose(_p.set(c.x, c.y, c.z), _q.setFromAxisAngle(UP, c.yaw), _s.set(k, k * 0.8, k));
      ambient.push(_m);
    }
    ambient.end();
  }

  // ------------------------------------------------------------ state
  let selection = null;
  let lastAction = null; // {x, z, at}
  let clock = 0;
  let reconcileT = 0;
  let disposed = false;

  function placementPos(title) {
    if (!title) return null;
    const p = stations.positionOf(title);
    if (p) return p;
    const st = S().stations && S().stations.get ? S().stations.get(title) : null;
    const pl = st || (world && world.placements && world.placements.get ? world.placements.get(title) : null);
    if (!pl || !Number.isFinite(pl.q)) return null;
    const w = hexToWorld(pl.q, pl.r);
    return { x: w.x, y: terrain.groundAt(w.x, w.z), z: w.z };
  }

  function markAction(title) {
    const p = placementPos(title);
    if (p) lastAction = { x: p.x, z: p.z, at: clock };
  }

  /** Where a reveal ripple starts: the latest action, else the built station nearest the new land. */
  function revealOrigin(tiles) {
    if (lastAction && clock - lastAction.at < 2) return { x: lastAction.x, z: lastAction.z };
    if (Array.isArray(tiles) && tiles.length) {
      let cx = 0, cz = 0, n = 0;
      for (const t of tiles) { if (!t) continue; const w = hexToWorld(t.q, t.r); cx += w.x; cz += w.z; n++; }
      if (n) {
        cx /= n; cz /= n;
        let best = null, bd = 10;
        for (const s of stations.built.values()) {
          const d = Math.hypot(s.x - cx, s.z - cz);
          if (d < bd) { bd = d; best = s; }
        }
        return best ? { x: best.x, z: best.z } : { x: cx, z: cz };
      }
    }
    return { x: rig.target.x, z: rig.target.z };
  }

  function reconcile(animate) {
    safe('reconcile tiles', () => {
      if (world && typeof world.revealedTiles === 'function') {
        const all = world.revealedTiles();
        if (Array.isArray(all) && all.length !== terrain.tileCount) {
          const fresh = all.filter((t) => t && !terrain.has(t.q, t.r));
          terrain.reveal(fresh, { animate, origin: animate ? revealOrigin(fresh) : null });
        }
      }
    });
    safe('reconcile stations', () => stations.sync(S(), animate));
    safe('reconcile tracks', () => tracks.sync(S().tracks, animate));
  }

  // initial draw: whatever is already there, without animation
  reconcile(false);

  // ------------------------------------------------------------ events
  const unsubs = [];
  const on = (name, fn) => {
    if (!game || typeof game.on !== 'function') return;
    const u = game.on(name, (payload) => { if (!disposed) safe(`event ${name}`, () => fn(payload || {})); });
    if (typeof u === 'function') unsubs.push(u);
  };
  on('started', (p) => {
    if (p.station) markAction(p.station.title);
    reconcile(true);
  });
  on('tilesRevealed', (p) => {
    if (Array.isArray(p.tiles)) {
      // the station or track this reveal belongs to may be announced after it: sync first
      stations.sync(S(), true);
      terrain.reveal(p.tiles, { animate: true, origin: revealOrigin(p.tiles) });
    }
  });
  on('ghostsAdded', () => stations.sync(S(), true));
  on('stationBuilt', (p) => {
    if (p.station) {
      stations.sync(S(), true);
      markAction(p.station.title);
    }
    if (p.track) { tracks.add(p.track, true); stations.sync(S(), false); }
  });
  on('trackBuilt', (p) => {
    if (p.track) {
      markAction(p.track.from);
      tracks.add(p.track, true);
      stations.sync(S(), false);
      upgrades.refresh();
    }
  });
  on('trackUpgraded', () => upgrades.refresh());
  on('trainsChanged', () => upgrades.refresh());
  on('thoughtDelivered', (p) => {
    const pos = placementPos(p.station);
    if (!pos) return;
    const streak = Number.isFinite(p.streak) ? Math.floor(p.streak) : 0;
    if (Number.isFinite(p.fare) && p.fare > 0) {
      labels.floatText(pos.x, pos.y + 1.15, pos.z, `+${gold(p.fare)}`, deliveryFloat(streak));
    }
    const extra = Math.min(16, Math.max(0, streak - 1) * 2);
    sparkles.burst(pos.x, pos.y + 0.55, pos.z, 18 + extra, '#ffd966', { speed: 0.7, up: 1.4, life: 0.8 });
    sparkles.burst(pos.x, pos.y + 0.55, pos.z, 8 + extra / 2, '#9ff3ff', { speed: 0.5, up: 1.8, life: 0.7 });
  });
  /** The big celebratory burst over a station: text, small line, sparkles and a ring. */
  function bigBurst(pos, text, sub) {
    if (text) labels.floatText(pos.x, pos.y + 1.4, pos.z, text, { cls: 'big', dur: 2.6, rise: 1.3, pop: true, sub });
    sparkles.burst(pos.x, pos.y + 0.6, pos.z, 46, '#ffd23f', { speed: 1.4, up: 2.4, life: 1.2, size: 0.06 });
    sparkles.burst(pos.x, pos.y + 0.6, pos.z, 22, '#fff6c8', { speed: 0.9, up: 3.0, life: 1.1 });
    ring(pos.x, pos.y + 0.1, pos.z, '#ffd23f', 20);
  }
  on('routeBonus', (p) => {
    const pos = placementPos(p.station);
    if (!pos) return;
    if (Number.isFinite(p.amount) && p.amount > 0) {
      const who = Number.isFinite(p.count) && p.count > 0 ? `${p.count} passenger${p.count === 1 ? '' : 's'} can travel` : '';
      bigBurst(pos, `+${gold(p.amount)} route opened`, who);
    } else bigBurst(pos, '', '');
  });
  on('surprise', (p) => {
    const pos = placementPos(p.station);
    if (!pos || !Number.isFinite(p.amount) || p.amount <= 0) return;
    bigBurst(pos, `+${gold(p.amount)}`, p.text || 'A surprise');
  });
  on('ticketDone', (p) => {
    const t = p.ticket;
    const pos = t && placementPos(t.to);
    if (!pos) return;
    const reward = Number.isFinite(p.reward) ? p.reward : t.reward;
    bigBurst(pos, `+${gold(reward)} \u00b7 ticket complete`, `${t.from} \u2192 ${t.to}`);
    confetti(pos.x, pos.y + 1.4, pos.z);
  });
  on('goalDone', (p) => {
    // a celebration where the player is looking
    const t = rig.followId != null && rig.chase ? rig.chase.look : rig.target;
    const x = t.x, z = t.z;
    const y = Math.max(t.y, safe('goal ground', () => terrain.groundAt(x, z)) ?? t.y);
    // several goals met at once stack their banners instead of printing over each other
    goalStack = clock - lastGoalAt < 2.5 ? goalStack + 1 : 0;
    lastGoalAt = clock;
    if (goalStack === 0) confetti(x, y + 1.6, z);
    const reward = Number.isFinite(p.reward) && p.reward > 0 ? `+${gold(p.reward)}` : '';
    const what = p.goal && p.goal.text ? p.goal.text : '';
    labels.floatText(x, y + 1.9 + goalStack * 0.75, z, 'Goal complete!', { cls: 'goal', dur: 3.0, rise: 1.0, pop: true, sub: [what, reward].filter(Boolean).join(' \u00b7 ') });
  });
  on('payday', (p) => {
    upgrades.refresh();
    if (!(Number.isFinite(p.amount) && p.amount > 0)) return;
    // a little coin sparkle at every station a train stops at (kept cheap: a few particles each)
    const served = new Set();
    for (const tr of S().tracks || []) if (tr && tr.level > 0) { served.add(tr.from); served.add(tr.to); }
    let n = 0;
    for (const title of served) {
      if (n++ >= 40) break;
      const pos = stations.positionOf(title);
      if (pos) sparkles.burst(pos.x, pos.y + 0.7, pos.z, 5, '#ffd23f', { speed: 0.35, up: 1.3, life: 0.6, size: 0.035 });
    }
  });

  let goalStack = 0, lastGoalAt = -1e9;

  /** Confetti: many colours, thrown up, falling slowly. */
  function confetti(x, y, z) {
    const cols = ['#ff5e7e', '#ffd23f', '#3fd2ff', '#7dff6a', '#c08bff', '#ffffff', '#ff9f43'];
    for (const c of cols) confettiFx.burst(x, y, z, 16, c, { speed: 2.0, up: 3.4, life: 2.4, size: 0.09, gravity: 2.6 });
    sparkles.burst(x, y, z, 30, '#fff2b0', { speed: 1.6, up: 2.6, life: 1.2, size: 0.05 });
    for (let i = 0; i < 3; i++) ring(x, y - 1.2, z, cols[i], 16);
  }
  /** A flat ring of sparkles spreading out along the ground. */
  function ring(x, y, z, color, n) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      sparkles.emit(x, y, z, 1, { vx: Math.cos(a) * 2.0, vz: Math.sin(a) * 2.0, vy: 0.5, size: 0.05, life: 0.7, color, gravity: 0.8 });
    }
  }

  // ------------------------------------------------------------ picking & hover
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const _c = new THREE.Vector3();
  let down = null;
  let hoverPt = null;

  function pickAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { kind: 'none' };
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const ray = raycaster.ray;
    let best = null, bestScore = Infinity;
    const consider = (c, r, pick) => {
      _c.set(c.x, c.y, c.z);
      const along = _c.clone().sub(ray.origin).dot(ray.direction);
      if (along <= 0) return;
      const d = Math.sqrt(ray.distanceSqToPoint(_c));
      if (d > r) return;
      const score = d / r + along * 0.002;
      if (score < bestScore) { bestScore = score; best = pick; }
    };
    for (const t of trains.pickables()) consider(t, 0.4, { kind: 'train', trainId: t.trainId });
    for (const g of upgrades.pickables()) {
      _c.set(g.x, g.y, g.z);
      const before = best;
      consider(g, g.r, { kind: 'upgrade', trackId: g.trackId, typeId: g.options[0].typeId });
      if (best !== before && g.options.length > 1) {
        // which chip: the one under the pointer, else left/right of the tag's centre
        const chip = labels.tagChipAt(`tag:${g.trackId}`, clientX, clientY);
        if (chip) best.typeId = chip;
        else {
          const v = new THREE.Vector3(g.x, g.y, g.z).project(camera);
          const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width;
          best.typeId = clientX < sx ? g.options[0].typeId : g.options[1].typeId;
        }
      }
    }
    for (const s of stations.pickables()) consider(s, s.r, { kind: s.kind, title: s.title });
    // passengers are small, so they only win when the click is right on them
    for (const p of stations.passengerPickables()) consider(p, 0.16, { kind: 'thought', thoughtId: p.thoughtId });
    // the floating article card wins over the station and signposts beneath it
    let cardPick = null;
    for (const c of cards.pickables()) {
      const before = best;
      consider(c, c.r, { kind: 'article', title: c.title });
      if (best !== before) cardPick = best;
    }
    if (cardPick && (!best || best.kind === 'station' || best.kind === 'ghost' || best.kind === 'article')) return cardPick;
    if (best) return best;
    // plain (the builder): a click on bare ground says where on the ground it landed
    if (plain) {
      const g = groundHit(ray);
      if (g) return { kind: 'ground', x: g.x, z: g.z };
    }
    return { kind: 'none' };
  }

  /** Where a ray first meets the ground: march along it, then narrow down the crossing. */
  function groundHit(ray) {
    const o = ray.origin, d = ray.direction;
    const above = (t) => o.y + d.y * t - (safe('ground', () => terrain.groundAt(o.x + d.x * t, o.z + d.z * t)) ?? 0);
    const step = 0.25, far = 400;
    let t0 = 0;
    if (above(0) <= 0) return null;
    for (let t = step; t <= far; t += step) {
      if (above(t) > 0) { t0 = t; continue; }
      let lo = t0, hi = t;
      for (let i = 0; i < 16; i++) { const m = (lo + hi) / 2; if (above(m) > 0) lo = m; else hi = m; }
      return { x: o.x + d.x * hi, z: o.z + d.z * hi };
    }
    return null;
  }

  const onPointerDown = (e) => {
    down = { x: e.clientX, y: e.clientY, id: e.pointerId, button: e.button, moved: false };
  };
  const onPointerMove = (e) => {
    hoverPt = { x: e.clientX, y: e.clientY };
    if (down && !down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
      down.moved = true;
      if (rig.followId != null) rig.stopFollow(true);
    }
  };
  const onPointerUp = (e) => {
    const d = down;
    down = null;
    if (!d || d.moved || d.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    emitPick(pickAt(e.clientX, e.clientY));
  };
  const onPointerLeave = () => { hoverPt = null; setHover(null); };
  const onWheel = () => { if (rig.followId != null) rig.stopFollow(true); };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: true });

  let hoverKey = null;
  let tagHover3d = false;
  function setHover(pick) {
    const title = pick && (pick.kind === 'station' || pick.kind === 'ghost') ? pick.title : null;
    stations.hover = title;
    if (pick && pick.kind === 'upgrade') { upgrades.hover = { trackId: pick.trackId, typeId: pick.typeId }; tagHover3d = true; }
    else if (tagHover3d) { upgrades.hover = null; tagHover3d = false; }
    const key = pick && pick.kind !== 'none' ? (pick.title || (pick.kind === 'thought' ? `p${pick.thoughtId}` : pick.kind === 'upgrade' ? `u${pick.trackId}:${pick.typeId}` : `t${pick.trainId}`)) : null;
    if (key !== hoverKey) {
      hoverKey = key;
      canvas.style.cursor = key ? 'pointer' : '';
    }
  }
  let hoverT = 0;

  // ------------------------------------------------------------ resize
  function resize() {
    const w = Math.max(1, container.clientWidth || window.innerWidth);
    const h = Math.max(1, container.clientHeight || window.innerHeight);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(resize); ro.observe(container); }
  window.addEventListener('resize', resize);

  // ------------------------------------------------------------ frame
  const focusKeys = new Set();
  const env = {
    head: (id) => trains.head(id),
    groundAt: (x, z) => terrain.groundAt(x, z),
    bounds: terrain.bounds,
  };

  function updateShadow() {
    const t = rig.followId != null && rig.chase ? rig.chase.look : rig.target;
    const dist = rig.followId != null ? 12 : rig.distance;
    const ext = Math.min(48, Math.max(10, dist * 0.95));
    if (Math.abs(ext - shadowExtent) > shadowExtent * 0.08) {
      shadowExtent = ext;
      const sc = sun.shadow.camera;
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
      sc.updateProjectionMatrix();
    }
    // snap to shadow texels to avoid shimmering while panning
    const texel = (2 * shadowExtent) / sun.shadow.mapSize.x;
    const tx = Math.round(t.x / texel) * texel, tz = Math.round(t.z / texel) * texel;
    sun.target.position.set(tx, t.y, tz);
    sun.position.set(tx + SUN_DIR.x * 50, t.y + SUN_DIR.y * 50, tz + SUN_DIR.z * 50);
    sun.target.updateMatrixWorld();
  }

  function update(dtIn) {
    if (disposed) return;
    const dt = Number.isFinite(dtIn) ? Math.min(0.1, Math.max(0, dtIn)) : 0.016;
    clock += dt;
    uniforms.uTime.value = clock;

    reconcileT -= dt;
    if (reconcileT <= 0) { reconcileT = 0.5; reconcile(true); }

    safe('terrain', () => terrain.update(dt));
    safe('tracks', () => tracks.update(dt));
    safe('trains', () => trains.update(S(), dt));
    safe('stations', () => stations.update(dt, S()));
    safe('cards', () => cards.update(dt, stations.built, S()));
    safe('upgrades', () => { upgrades.update(dt, S()); tracks.setGlow(upgrades.glowWanted()); });
    safe('ticket holders', () => {
      // A magnified circle over the station a ticket starts from: the passenger, ticket in hand,
      // waiting for a train to somewhere that does not exist yet.
      const live = new Set();
      const seen = new Map();
      const st8 = S();
      for (const t of (st8 && st8.tickets) || []) {
        const st = st8.stations.get(t.from);
        if (!st) continue;
        const n = seen.get(t.from) || 0;
        seen.set(t.from, n + 1);
        const w = hexToWorld(st.q, st.r);
        const frac = t.timeMax > 0 ? t.time / t.timeMax : 1;
        const key = `holder:${t.id}`;
        labels.upsert(key, {
          text: `\u2192 ${t.to}`,
          kind: 'holder' + (frac < 0.25 ? ' urgent' : frac < 0.5 ? ' restless' : ''),
          x: w.x, y: terrain.groundAt(w.x, w.z) + 2.5, z: w.z,
          priority: 2.5e5 - n, pinned: true, movable: true,
        });
        live.add(key);
      }
      for (const key of holderKeys) if (!live.has(key)) labels.remove(key);
      holderKeys = live;
    });
    safe('build offer', () => {
      // The one Build button lives on the map, over the place the track would go to.
      const pl = buildOffer && world && world.placements ? world.placements.get(buildOffer.title) : null;
      if (!buildOffer || !pl) { if (buildOfferShown) { labels.remove('build'); buildOfferShown = false; } return; }
      const w = hexToWorld(pl.q, pl.r);
      const title = buildOffer.title;
      labels.upsertTag('build', {
        x: w.x, y: terrain.groundAt(w.x, w.z) + 1.75, z: w.z,
        options: [{ typeId: 'build', title: buildOffer.label, sub: buildOffer.sub || '', affordable: buildOffer.affordable !== false }],
        pinned: true, priority: 3e5, goal: buildOffer.affordable !== false,
        onClick: () => emitPick({ kind: 'build', title }),
      });
      buildOfferShown = true;
    });
    safe('particles', () => { smoke.update(dt); sparkles.update(dt); confettiFx.update(dt); });
    safe('ambient', () => updateAmbient(dt));

    hoverT -= dt;
    if (hoverPt && !down && hoverT <= 0) {
      hoverT = 0.05;
      safe('hover', () => setHover(pickAt(hoverPt.x, hoverPt.y)));
    }

    safe('camera', () => rig.update(dt, env));
    safe('shadow', updateShadow);
    terrain.setDetail(rig.followId != null ? 0 : rig.distance);

    // atmosphere follows the zoom: near things crisp, far land melts into the haze
    const dist = rig.followId != null ? 6 : rig.distance;
    scene.fog.near = dist * 1.05 + 8;
    scene.fog.far = dist * 2.7 + 34;
    sky.position.copy(camera.position);
    mist.position.x = camera.position.x;
    mist.position.z = camera.position.z;

    renderer.render(scene, camera);
    focusKeys.clear();
    if (selection) { focusKeys.add(`s:${selection}`); focusKeys.add(`g:${selection}`); }
    if (stations.hover) { focusKeys.add(`s:${stations.hover}`); focusKeys.add(`g:${stations.hover}`); }
    safe('labels', () => labels.update(camera, dt, focusKeys));
  }

  // ------------------------------------------------------------ API
  return {
    update,
    onPick(handler) {
      if (typeof handler !== 'function') return () => {};
      pickHandlers.add(handler);
      return () => pickHandlers.delete(handler);
    },
    setSelection(title) {
      selection = title || null;
      stations.selection = selection;
    },
    setThoughtSelection(thoughtId) {
      stations.selectedThought = thoughtId == null ? null : thoughtId;
    },
    setBuildOffer(offer) {
      buildOffer = offer && offer.title ? offer : null;
    },
    setRoutePreview(routes, activeStyle) {
      safe('route preview', () => tracks.setPreview(routes || null, activeStyle));
    },
    focus(title) {
      const p = placementPos(title);
      if (p) rig.focus(p);
    },
    follow(trainId) {
      if (trainId == null) { rig.follow(null); return; }
      rig.follow(trainId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const u of unsubs) safe('unsubscribe', u);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      pickHandlers.clear();
      rig.dispose();
      trains.dispose();
      disposeTrainGeometries();
      upgrades.dispose();
      cards.dispose();
      tracks.dispose();
      stations.dispose();
      terrain.dispose();
      smoke.dispose();
      sparkles.dispose();
      confettiFx.dispose(); confettiGeom.dispose(); confettiMat.dispose();
      ambient.dispose();
      ambientGeom.dispose();
      labels.dispose();
      sky.geometry.dispose(); sky.material.dispose();
      mist.geometry.dispose();
      for (const m of Object.values(materials)) m.dispose();
      renderer.dispose();
      canvas.remove();
    },
    // not part of the contract: handy for debugging from the console
    _debug: { cards, scene, camera, renderer, terrain, stations, tracks, trains, upgrades, labels, rig, hexKey },
  };
}
