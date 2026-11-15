// The 3D view: a low-poly diorama in three.js. Implements `Renderer` from src/types.js.
// Importing this module has no side effects; everything happens in createRenderer().
import * as THREE from 'three';
import { SKY } from './palette.js';
import { createSharedUniforms, createMaterials, createSkyMaterial, addMist } from './materials.js';
import { Terrain, buildCloudGeometry } from './terrain.js';
import { StationsView } from './stations.js';
import { TracksView } from './tracks-view.js';
import { TrainsView, disposeTrainGeometries } from './trains.js';
import { Particles, DynamicInstances } from './dynamic.js';
import { LabelLayer } from './labels.js';
import { CameraRig } from './camera.js';
import { hexToWorld, worldToHex, hexKey, mulberry32 } from '../hex.js';

const SUN_DIR = new THREE.Vector3(0.55, 0.78, 0.32).normalize();

/**
 * @param {{container: HTMLElement, game: import('../types.js').Game, world: import('../types.js').World}} opts
 * @returns {import('../types.js').Renderer}
 */
export function createRenderer({ container, game, world }) {
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
  const materials = createMaterials(uniforms);

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
  const terrain = new Terrain({ parent: world3d, materials, world });
  const smoke = new Particles(world3d, new THREE.IcosahedronGeometry(1, 0), materials.smoke, { kind: 'smoke', capacity: 256, renderOrder: 8 });
  const sparkles = new Particles(world3d, new THREE.OctahedronGeometry(1, 0), materials.sparkle, { kind: 'sparkle', capacity: 256, renderOrder: 9 });
  const stations = new StationsView({
    parent: world3d, materials, world, labels,
    onBuiltFx: (x, y, z) => {
      sparkles.burst(x, y + 0.3, z, 26, '#fff0b8', { speed: 1.0, up: 1.6 });
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        smoke.emit(x + Math.cos(a) * 0.3, y + 0.05, z + Math.sin(a) * 0.3, 1, { vx: Math.cos(a) * 0.5, vz: Math.sin(a) * 0.5, vy: 0.12, size: 0.09, grow: 0.12, life: 0.8 });
      }
    },
  });
  stations.blockFn = (circles) => terrain.block(circles);
  const tracks = new TracksView({
    parent: world3d, materials, terrain,
    fx: (x, y, z, kind) => {
      if (Math.random() < 0.5) sparkles.emit(x, y + 0.05, z, 1, { vx: (Math.random() - 0.5) * 0.6, vy: 0.6 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.6, size: 0.03, life: 0.5, color: kind === 'tunnel' ? '#c7a6ff' : '#ffe08a', gravity: 1.5 });
    },
  });
  const trains = new TrainsView({
    parent: world3d, materials, smoke,
    groundAt: (x, z) => terrain.groundAt(x, z),
    makePaintMaterial: () => addMist(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), uniforms),
  });
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
  const pickHandlers = new Set();
  let selection = null;
  let lineHighlight = null;
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
    safe('reconcile highlight', () => tracks.setHighlight(lineHighlight, S()));
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
      tracks.setHighlight(lineHighlight, S());
    }
  });
  on('linesChanged', () => { tracks.highlight.key = '__dirty'; tracks.setHighlight(lineHighlight, S()); });
  on('trainsChanged', () => {});
  on('thoughtDelivered', (p) => {
    const pos = placementPos(p.station);
    if (pos) {
      sparkles.burst(pos.x, pos.y + 0.55, pos.z, 18, '#ffd966', { speed: 0.7, up: 1.4, life: 0.8 });
      sparkles.burst(pos.x, pos.y + 0.55, pos.z, 8, '#9ff3ff', { speed: 0.5, up: 1.8, life: 0.7 });
    }
  });

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
    for (const s of stations.pickables()) consider(s, s.r, { kind: s.kind, title: s.title });
    // passengers are small, so they only win when the click is right on them
    for (const p of stations.passengerPickables()) consider(p, 0.16, { kind: 'thought', thoughtId: p.thoughtId });
    return best || { kind: 'none' };
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
    const pick = pickAt(e.clientX, e.clientY);
    for (const h of [...pickHandlers]) safe('pick handler', () => h(pick));
  };
  const onPointerLeave = () => { hoverPt = null; setHover(null); };
  const onWheel = () => { if (rig.followId != null) rig.stopFollow(true); };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: true });

  let hoverKey = null;
  function setHover(pick) {
    const title = pick && (pick.kind === 'station' || pick.kind === 'ghost') ? pick.title : null;
    stations.hover = title;
    const key = pick && pick.kind !== 'none' ? (pick.title || (pick.kind === 'thought' ? `p${pick.thoughtId}` : `t${pick.trainId}`)) : null;
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
    safe('particles', () => { smoke.update(dt); sparkles.update(dt); });
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
    setRoutePreview(routes, activeStyle) {
      safe('route preview', () => tracks.setPreview(routes || null, activeStyle));
    },
    setLineHighlight(lineId) {
      lineHighlight = lineId == null ? null : lineId;
      safe('line highlight', () => tracks.setHighlight(lineHighlight, S()));
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
      tracks.dispose();
      stations.dispose();
      terrain.dispose();
      smoke.dispose();
      sparkles.dispose();
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
    _debug: { scene, camera, renderer, terrain, stations, tracks, trains, rig, hexKey },
  };
}
