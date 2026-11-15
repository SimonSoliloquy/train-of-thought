// Built stations (one merged low-poly mesh each), ghost markers (instanced),
// waiting-thought bubbles, the selection ring, and the label data for both.
import * as THREE from 'three';
import { MeshBuilder, shade } from './builder.js';
import { hexToWorld, hashString } from '../hex.js';
import { DynamicInstances } from './dynamic.js';
import { BUBBLE_COLORS } from './palette.js';
import { easeOutBack } from './terrain.js';
import { gold, ticketBadge } from './format.js';

const ROOFS = ['#c4553b', '#3f6f8f', '#5d7d4a', '#8c5a9a', '#b8862f', '#4a5568', '#a8483e'];
const WALLS = ['#efe4cc', '#e9dcc0', '#b5643d', '#d8c7a5', '#f2ead8'];
export const STATION_SCALE = 1.2;

// Thoughts are drawn as passengers waiting on the platform.
const COATS = ['#d1495b', '#2e86ab', '#f3a712', '#76b041', '#8d6a9f', '#e07a5f', '#3d5a80', '#f2cc8f', '#43aa8b', '#b5651d'];
const SKINS = ['#f1c9a5', '#e0ac7e', '#c68655', '#8d5b3e', '#f6d7bd'];
const FLUSHED = new THREE.Color('#ff5a4e');
export const MAX_PASSENGERS_SHOWN = 8;
const PERSON_SCALE = 1.8;

/** Body of a waiting passenger, feet at the origin; white so the instance colour is the coat. Pure. */
export function personBodyBuilder() {
  const b = new MeshBuilder();
  b.box(-0.012, 0.02, 0, 0.016, 0.04, 0.02, '#55555f');
  b.box(0.012, 0.02, 0, 0.016, 0.04, 0.02, '#55555f');
  b.prism(0, 0.038, 0, 0.034, 0.024, 0.07, 6, '#ffffff');
  b.box(-0.035, 0.074, 0, 0.012, 0.05, 0.016, '#dcdcdc');
  b.box(0.035, 0.074, 0, 0.012, 0.05, 0.016, '#dcdcdc');
  return b;
}

/** Head of a waiting passenger; white so the instance colour is the skin tone. Pure. */
export function personHeadBuilder() {
  const b = new MeshBuilder();
  b.blob(0, 0.13, 0, 0.024, 0.026, 0.024, '#ffffff', null, 0, 0);
  return b;
}

/**
 * How a waiting passenger behaves for a given share of patience left (1 = just arrived).
 * mood 0 calm, 1 restless, 2 frantic. Pure.
 */
export function passengerPose(frac, t, phase) {
  const mood = frac > 0.5 ? 0 : frac > 0.22 ? 1 : 2;
  if (mood === 0) return { mood, look: Math.sin(t * 0.7 + phase) * 0.25, hop: 0, tilt: 0, pace: 0 };
  if (mood === 1) {
    return { mood, look: Math.sin(t * 2.2 + phase) * 0.8, hop: Math.max(0, Math.sin(t * 6 + phase)) * 0.012, tilt: 0, pace: Math.sin(t * 1.3 + phase) * 0.015 };
  }
  return { mood, look: Math.sin(t * 5 + phase) * 0.5, hop: Math.abs(Math.sin(t * 8 + phase)) * 0.05, tilt: Math.sin(t * 16 + phase) * 0.12, pace: Math.sin(t * 3 + phase) * 0.03 };
}

/**
 * Station building in its local frame: track runs along local z through the origin,
 * platform and building on the +x side. Pure.
 */
export function buildStationBuilder(title, popularity = 0.5) {
  const h = hashString(title || '?');
  const roof = ROOFS[h % ROOFS.length];
  const wall = WALLS[(h >>> 3) % WALLS.length];
  const size = popularity >= 0.66 ? 2 : popularity >= 0.33 ? 1 : 0;
  const b = new MeshBuilder();
  const len = [0.62, 0.8, 0.98][size];
  // platform
  b.box(0.31, 0.04, 0, 0.24, 0.08, len, '#cfc6b4', 0, { top: '#d9d1c0' });
  b.box(0.2, 0.081, 0, 0.022, 0.004, len, '#f1d36a');
  // building
  const bw = [0.2, 0.24, 0.28][size], bl = [0.3, 0.42, 0.5][size], bh = [0.16, 0.2, 0.24][size];
  const bx = 0.43 + bw / 2 - 0.02;
  b.box(bx, 0.08 + bh / 2, 0, bw, bh, bl, wall);
  // windows + door on the platform side
  const wn = size + 2;
  for (let i = 0; i < wn; i++) {
    const z = -bl / 2 + (bl / wn) * (i + 0.5);
    b.box(bx - bw / 2 - 0.003, 0.08 + bh * 0.55, z, 0.006, bh * 0.36, (bl / wn) * 0.45, i === Math.floor(wn / 2) ? '#5a3d2b' : '#f6e3a6');
  }
  // pitched roof (gable along z)
  const ry = 0.08 + bh, rh = 0.11 + size * 0.02, ov = 0.035;
  const x0 = bx - bw / 2 - ov, x1 = bx + bw / 2 + ov, xm = bx, z0 = -bl / 2 - ov, z1 = bl / 2 + ov;
  b.quad([x0, ry, z0], [x0, ry, z1], [xm, ry + rh, z1], [xm, ry + rh, z0], roof);
  b.quad([xm, ry + rh, z0], [xm, ry + rh, z1], [x1, ry, z1], [x1, ry, z0], shade(roof, 0.78));
  b.tri([x0, ry, z1], [x1, ry, z1], [xm, ry + rh, z1], shade(wall, 0.9));
  b.tri([x1, ry, z0], [x0, ry, z0], [xm, ry + rh, z0], shade(wall, 0.9));
  b.quad([x0, ry - 0.005, z0], [x1, ry - 0.005, z0], [x1, ry - 0.005, z1], [x0, ry - 0.005, z1], shade(roof, 0.5));
  // chimney
  b.box(bx + bw * 0.25, ry + rh * 0.7, -bl * 0.25, 0.04, 0.12, 0.04, '#8a4b35');
  // lamp posts at the platform ends (no canopy: waiting passengers must stay visible from above)
  for (const z of [-len / 2 + 0.05, len / 2 - 0.05]) {
    b.box(0.41, 0.08 + 0.1, z, 0.014, 0.2, 0.014, '#3c3f45');
    b.box(0.41, 0.29, z, 0.036, 0.026, 0.036, '#ffe9a8');
  }
  // station sign
  b.box(0.22, 0.2, len / 2 - 0.05, 0.012, 0.05, 0.12, '#2f4a7a');
  // clock tower on big stations
  if (size === 2) {
    const tx = bx, tz = bl / 2 + 0.06;
    b.box(tx, 0.08 + 0.22, tz, 0.11, 0.44, 0.11, wall);
    b.box(tx - 0.056, 0.42, tz, 0.004, 0.06, 0.06, '#fdf8e8');
    b.prism(tx, 0.52, tz, 0.09, 0, 0.12, 4, roof, { phase: Math.PI / 4 });
  }
  // lamp posts
  for (const z of [-len / 2 + 0.05, len / 2 - 0.05]) {
    b.box(0.39, 0.16, z, 0.012, 0.16, 0.012, '#2c2e33');
    b.box(0.39, 0.245, z, 0.03, 0.025, 0.03, '#fff2b0');
  }
  // a couple of benches and planters
  b.box(0.36, 0.1, -0.12, 0.04, 0.025, 0.12, '#7a5634');
  b.blob(0.42, 0.11, len / 2 - 0.12, 0.035, 0.03, 0.035, '#5aa83c');
  return b;
}

/** A wooden signpost: post at the origin, arrow board pointing along local +x. Pure. */
export function signpostBuilder() {
  const b = new MeshBuilder();
  b.box(0, 0.36, 0, 0.055, 0.72, 0.055, '#6b4a30');
  b.prism(0, 0, 0, 0.06, 0.045, 0.06, 5, '#8a6a46');
  // arrow board
  const y0 = 0.5, y1 = 0.7, z = 0.035;
  b.box(0.25, (y0 + y1) / 2, 0, 0.5, y1 - y0, z * 2, '#f4e6c2', 0, { side: '#c9b48a' });
  const tip = [0.66, (y0 + y1) / 2], t0 = [0.5, y0 - 0.03], t1 = [0.5, y1 + 0.03];
  for (const zz of [-z, z]) b.tri([t0[0], t0[1], zz], [tip[0], tip[1], zz], [t1[0], t1[1], zz], '#f4e6c2');
  b.quad([t0[0], t0[1], -z], [tip[0], tip[1], -z], [tip[0], tip[1], z], [t0[0], t0[1], z], '#c9b48a');
  b.quad([tip[0], tip[1], -z], [t1[0], t1[1], -z], [t1[0], t1[1], z], [tip[0], tip[1], z], '#c9b48a');
  // painted stripe
  b.box(0.27, (y0 + y1) / 2, 0, 0.36, 0.035, z * 2 + 0.004, '#b8452f');
  b.prism(0, 0.72, 0, 0.04, 0.0, 0.06, 4, '#5a3c26');
  return b;
}

/**
 * Unbuilt links of a built station that have a reserved spot: lead links first in reading
 * order, then any other link that is a ghost placement. Pure.
 */
export function signpostLinks(station, placements, max = 10) {
  const art = station && station.article;
  if (!art || !placements || typeof placements.get !== 'function') return [];
  const out = [], seen = new Set([station.title]);
  for (const list of [art.leadLinks || [], art.links || []]) {
    for (const t of list) {
      if (out.length >= max) return out;
      if (seen.has(t)) continue;
      seen.add(t);
      const pl = placements.get(t);
      if (pl && pl.state === 'ghost' && Number.isFinite(pl.q) && Number.isFinite(pl.r)) out.push(t);
    }
  }
  return out;
}

/**
 * Signposts on a ring around (cx, cz): evenly spaced slots, assigned in order of the true
 * bearing to each link's reserved spot, the ring turned to fit those bearings best. Pure.
 * @param {{title:string, x:number, z:number}[]} targets
 * @returns {{title:string, x:number, z:number, slot:number, bearing:number}[]}
 */
export function layoutSignposts(cx, cz, targets, radius = 2.5) {
  const n = targets.length;
  if (!n) return [];
  const step = (Math.PI * 2) / n;
  const items = targets.map((t) => ({ ...t, bearing: Math.atan2(t.z - cz, t.x - cx) }));
  items.sort((a, b) => a.bearing - b.bearing);
  let sx = 0, sy = 0;
  items.forEach((it, k) => { const a = it.bearing - k * step; sx += Math.cos(a); sy += Math.sin(a); });
  const base = n === 1 ? items[0].bearing : Math.atan2(sy, sx);
  return items.map((it, k) => {
    const slot = base + k * step;
    return { title: it.title, bearing: it.bearing, slot, x: cx + Math.cos(slot) * radius, z: cz + Math.sin(slot) * radius };
  });
}

function ghostRingBuilder() {
  const b = new MeshBuilder();
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a0 = (Math.PI / 180) * (60 * i - 30), a1 = (Math.PI / 180) * (60 * (i + 1) - 30);
    const p = (r, a) => [Math.cos(a) * r, 0, Math.sin(a) * r];
    // dashed: two dashes per edge
    for (const [u0, u1] of [[0.06, 0.44], [0.56, 0.94]]) {
      const lerp = (r, u) => { const A = p(r, a0), B = p(r, a1); return [A[0] + (B[0] - A[0]) * u, 0, A[2] + (B[2] - A[2]) * u]; };
      b.quad(lerp(0.62, u0), lerp(0.62, u1), lerp(0.72, u1), lerp(0.72, u0), [1, 1, 1]);
    }
  }
  return b;
}

function ghostBeamBuilder() {
  const b = new MeshBuilder();
  b.prism(0, 0, 0, 0.3, 0.12, 1.3, 6, [1, 1, 1], { capTop: false, phase: Math.PI / 6 });
  return b;
}

function gemBuilder() {
  const b = new MeshBuilder();
  const r = 0.11, h = 0.14;
  const pts = [];
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; pts.push([Math.cos(a) * r, 0, Math.sin(a) * r]); }
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    b.tri([0, h, 0], pts[j], pts[i], [1, 1, 1]);
    b.tri([0, -h, 0], pts[i], pts[j], [0.75, 0.75, 0.75]);
  }
  return b;
}

function ringBuilder(r0, r1, n = 40) {
  const b = new MeshBuilder();
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    b.quad([Math.cos(a0) * r0, 0, Math.sin(a0) * r0], [Math.cos(a1) * r0, 0, Math.sin(a1) * r0],
      [Math.cos(a1) * r1, 0, Math.sin(a1) * r1], [Math.cos(a0) * r1, 0, Math.sin(a0) * r1], [1, 1, 1]);
  }
  return b;
}

/** Outgoing horizontal directions (unit [x, z]) of every track at a station. */
export function trackDirsAt(title, tracks) {
  const out = [];
  for (const t of tracks || []) {
    const pts = t && t.route && t.route.points;
    if (!pts || pts.length < 2) continue;
    let a, b;
    if (t.from === title) { a = pts[0]; b = pts[Math.min(pts.length - 1, 6)]; }
    else if (t.to === title) { a = pts[pts.length - 1]; b = pts[Math.max(0, pts.length - 7)]; }
    else continue;
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
    if (l > 1e-6) out.push([dx / l, dz / l]);
  }
  return out;
}

/** Yaw for the station so the building avoids every track and the platform lines up with one. Pure. */
export function chooseStationYaw(title, dirs) {
  const h = hashString(title || '?');
  if (!dirs.length) return (Math.PI / 2) - (Math.PI / 3) * (h % 6);
  let best = 0, bestScore = -Infinity;
  for (let k = 0; k < 12; k++) {
    const th = (Math.PI / 2) - (Math.PI / 3) * (k % 6) + (k >= 6 ? Math.PI : 0);
    const bx = Math.cos(th), bz = -Math.sin(th);      // building direction (local +x)
    const ax = Math.sin(th), az = Math.cos(th);       // platform axis (local z)
    let minAng = Math.PI, align = 0;
    for (const [ux, uz] of dirs) {
      const ang = Math.acos(Math.max(-1, Math.min(1, ux * bx + uz * bz)));
      minAng = Math.min(minAng, ang);
      align = Math.max(align, Math.abs(ux * ax + uz * az));
    }
    const score = minAng + align * 0.6 + ((h + k) % 7) * 1e-3;
    if (score > bestScore) { bestScore = score; best = th; }
  }
  return best;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _e = new THREE.Euler();

export const SIGN_RING = 3.1;
export const MAX_SIGNPOSTS = 10;
export const SIGN_REQUERY = 1; // seconds between signpost price refreshes


/**
 * What each signpost round station `from` says: the price to build to that link
 * (game.quoteBuild -> cheap.total; null when it cannot be quoted) and whether it is affordable,
 * and how many passengers wait to go there with the sum of their fares. Pure.
 * @returns {Map<string, {price:number|null, afford:boolean, waiting:number, fares:number}>}
 */
export function signpostInfo(game, from, titles, thoughts) {
  const out = new Map();
  const want = new Set(titles);
  for (const t of titles) out.set(t, { price: null, afford: false, waiting: 0, fares: 0 });
  for (const th of thoughts || []) {
    if (!th || th.state !== 'waiting' || !want.has(th.to)) continue;
    const o = out.get(th.to);
    o.waiting++;
    o.fares += Number.isFinite(th.fare) ? th.fare : 0;
  }
  if (game && typeof game.quoteBuild === 'function' && from) {
    for (const t of titles) {
      let q = null;
      try { q = game.quoteBuild(from, t); } catch { q = null; }
      const c = q && q.ok && q.cheap ? q.cheap : null;
      if (c && Number.isFinite(c.total)) { const o = out.get(t); o.price = c.total; o.afford = !!c.affordable; }
    }
  }
  return out;
}

export class StationsView {
  constructor({ parent, materials, world, labels, onBuiltFx, terrain, onSignClick, game, plain = false }) {
    this.game = game || null;
    this.plain = !!plain; // no station names, no prices: signposts only say "Build station"
    this.signInfo = new Map();  // title -> {price, afford, waiting, fares}: what each signpost says
    this.signInfoT = 0;
    this.signInfoKey = '';
    this.group = new THREE.Group();
    this.group.name = 'stations';
    parent.add(this.group);
    this.materials = materials;
    this.world = world;
    this.labels = labels;
    this.terrain = terrain || null;
    this.onBuiltFx = onBuiltFx || null;
    this.onSignClick = onSignClick || null;
    this.built = new Map();  // title -> {mesh, x, y, z, yaw, born, dirsKey}
    this.signs = new Map();  // title -> {mesh, x, y, z, bearing, born}
    this.signFor = null;     // station whose signposts are standing
    this.geoms = {
      ring: ghostRingBuilder().toGeometry(),
      beam: ghostBeamBuilder().toGeometry(),
      gem: gemBuilder().toGeometry(),
      sign: signpostBuilder().toGeometry(),
      bubble: new THREE.IcosahedronGeometry(0.06, 1),
      personBody: personBodyBuilder().toGeometry(),
      personHead: personHeadBuilder().toGeometry(),
      halo: new THREE.IcosahedronGeometry(0.12, 1),
      select: ringBuilder(0.78, 0.9).toGeometry(),
      select2: ringBuilder(0.95, 0.99).toGeometry(),
    };
    // the one unbuilt placement ever drawn: the build target being priced
    this.target = new THREE.Group();
    this.target.name = 'build-target';
    this.targetRing = new THREE.Mesh(this.geoms.ring, materials.ghostSolid);
    this.targetBeam = new THREE.Mesh(this.geoms.beam, materials.ghostBeam);
    this.targetGem = new THREE.Mesh(this.geoms.gem, materials.ghostSolid);
    this.targetBeam.renderOrder = 5;
    this.target.add(this.targetRing, this.targetBeam, this.targetGem);
    this.target.visible = false;
    this.group.add(this.target);
    this.targetTitle = null;
    this.bubbles = new DynamicInstances(this.group, this.geoms.bubble, materials.bubble, 128);
    this.halos = new DynamicInstances(this.group, this.geoms.halo, materials.halo, 128, { renderOrder: 6 });
    this.people = new DynamicInstances(this.group, this.geoms.personBody, materials.station, 128, { castShadow: true });
    this.heads = new DynamicInstances(this.group, this.geoms.personHead, materials.station, 128, { castShadow: true });
    this.thoughtLabels = new Set();
    this.passengerPicks = [];   // {thoughtId, x, y, z} for this frame's passengers
    this.selectedThought = null; // thought id whose passenger gets the speech bubble
    this.selectMesh = new THREE.Group();
    this.selectMesh.add(new THREE.Mesh(this.geoms.select, materials.selection), new THREE.Mesh(this.geoms.select2, materials.selection));
    this.selectMesh.visible = false;
    this.selectMesh.renderOrder = 7;
    this.group.add(this.selectMesh);
    this.selection = null;
    this.hover = null;
    this.time = 0;
    this.blockFn = null;
    this.isClear = null; // (x, z) => boolean: no track there
  }

  _ground(x, z, fallback) {
    if (this.terrain && typeof this.terrain.groundAt === 'function') {
      const g = this.terrain.groundAt(x, z);
      if (Number.isFinite(g)) return g;
    }
    return fallback;
  }

  _tileY(q, r) {
    let tile = null;
    try { tile = this.world && this.world.terrainAt ? this.world.terrainAt(q, r) : null; } catch { tile = null; }
    const e = tile && Number.isFinite(tile.elevation) ? tile.elevation : 0;
    return tile && tile.water ? e + 0.1 : e;
  }

  /** Unbuilt placements may move: always read them fresh. */
  _placement(title) {
    const pl = this.world && this.world.placements && typeof this.world.placements.get === 'function' ? this.world.placements.get(title) : null;
    return pl && Number.isFinite(pl.q) && Number.isFinite(pl.r) ? pl : null;
  }

  _unbuiltPos(title) {
    const pl = this._placement(title);
    if (!pl || pl.state === 'built' || this.built.has(title)) return null;
    const { x, z } = hexToWorld(pl.q, pl.r);
    return { x, y: this._ground(x, z, this._tileY(pl.q, pl.r)), z };
  }

  positionOf(title) {
    const s = this.built.get(title);
    if (s) return { x: s.x, y: s.y, z: s.z };
    return this._unbuiltPos(title);
  }

  /** Reconcile built stations against game.state.stations and world.placements. */
  sync(state, animate) {
    const stations = (state && state.stations) || new Map();
    const tracks = (state && state.tracks) || [];
    const stubs = (state && state.stubs) || new Map();
    const placements = (this.world && this.world.placements) || new Map();
    const builtNow = new Set();
    for (const [title, st] of stations) {
      if (!st || !Number.isFinite(st.q) || !Number.isFinite(st.r)) continue;
      builtNow.add(title);
      if (!this.built.has(title)) this._addBuilt(title, st, stubs, tracks, animate);
    }
    for (const [title, pl] of placements) {
      if (pl && pl.state === 'built' && !builtNow.has(title) && Number.isFinite(pl.q)) {
        builtNow.add(title);
        if (!this.built.has(title)) this._addBuilt(title, pl, stubs, tracks, animate);
      }
    }
    for (const title of [...this.built.keys()]) if (!builtNow.has(title)) this._removeBuilt(title);
    for (const [title, s] of this.built) {
      const dirs = trackDirsAt(title, tracks);
      const key = dirs.map((d) => `${d[0].toFixed(2)},${d[1].toFixed(2)}`).join('|');
      if (key !== s.dirsKey) {
        s.dirsKey = key;
        s.yaw = chooseStationYaw(title, dirs);
        s.mesh.rotation.y = s.yaw;
      }
    }
  }

  _addBuilt(title, st, stubs, tracks, animate) {
    const stub = stubs.get(title) || (st.article ? st.article : null);
    const pop = stub && Number.isFinite(stub.popularity) ? stub.popularity : 0.5;
    const { x, z } = hexToWorld(st.q, st.r);
    const y = this._tileY(st.q, st.r);
    if (this.terrain && this.terrain.setPad) this.terrain.setPad(title, x, z, y);
    const geom = buildStationBuilder(title, pop).toGeometry();
    const mesh = new THREE.Mesh(geom, this.materials.station);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(x, y, z);
    const dirs = trackDirsAt(title, tracks);
    const yaw = chooseStationYaw(title, dirs);
    mesh.rotation.y = yaw;
    mesh.scale.setScalar(STATION_SCALE);
    if (animate) mesh.scale.set(STATION_SCALE, 0.001, STATION_SCALE);
    this.group.add(mesh);
    const rec = { title, mesh, x, y, z, yaw, born: animate ? this.time : null, pop, dirsKey: dirs.map((d) => `${d[0].toFixed(2)},${d[1].toFixed(2)}`).join('|') };
    this.built.set(title, rec);
    if (this.blockFn) this.blockFn([{ x, z, r: 0.95 }]);
    if (animate && this.onBuiltFx) this.onBuiltFx(x, y, z);
  }

  _removeBuilt(title) {
    const s = this.built.get(title);
    if (!s) return;
    this.group.remove(s.mesh);
    s.mesh.geometry.dispose();
    this.built.delete(title);
    if (this.terrain && this.terrain.setPad) this.terrain.setPad(title, 0, 0, NaN);
    if (this.labels) this.labels.remove(`s:${title}`);
  }

  /** Waiting passengers the player can click, as drawn this frame. */
  passengerPickables() { return this.passengerPicks; }

  pickables() {
    const out = [];
    for (const s of this.built.values()) out.push({ kind: 'station', title: s.title, x: s.x, y: s.y + 0.25, z: s.z, r: 0.85 });
    // signposts: generous proxies on the board and on the post
    for (const g of this.signs.values()) {
      out.push({ kind: 'ghost', title: g.title, x: g.x + Math.cos(g.bearing) * 0.25, y: g.y + 0.6, z: g.z + Math.sin(g.bearing) * 0.25, r: 0.6 });
      out.push({ kind: 'ghost', title: g.title, x: g.x, y: g.y + 0.25, z: g.z, r: 0.45 });
    }
    return out;
  }

  // ------------------------------------------------------------ signposts

  _signTargets(state) {
    const sel = this.selection;
    if (!sel || !this.built.has(sel)) return null;
    const st = state && state.stations && typeof state.stations.get === 'function' ? state.stations.get(sel) : null;
    const placements = this.world && this.world.placements;
    const titles = signpostLinks(st, placements, MAX_SIGNPOSTS).filter((t) => !this.built.has(t));
    const out = [];
    for (const t of titles) {
      const pl = this._placement(t);
      if (!pl) continue;
      const w = hexToWorld(pl.q, pl.r);
      out.push({ title: t, x: w.x, z: w.z });
    }
    return out;
  }

  /**
   * Price and waiting passengers for each standing signpost. Re-asked about once a second, and
   * at once when gold, the selection or the waiting crowd changes.
   */
  _refreshSignInfo(state, titles, dt) {
    this.signInfoT -= dt;
    const thoughts = (state && Array.isArray(state.thoughts)) ? state.thoughts : [];
    const key = `${this.selection}|${state && state.money}|${titles.join('\u0001')}|${thoughts.length}`;
    if (this.signInfoT > 0 && key === this.signInfoKey) return;
    this.signInfoT = SIGN_REQUERY;
    this.signInfoKey = key;
    this.signInfo = signpostInfo(this.game, this.selection, titles, thoughts);
  }

  _updateSigns(state, dt = 0) {
    const targets = this._signTargets(state);
    const live = new Set();
    if (targets && targets.length) {
      const s = this.built.get(this.selection);
      if (this.signFor !== this.selection) { this._clearSigns(); this.signFor = this.selection; this.signInfoT = 0; }
      this._refreshSignInfo(state, targets.map((t) => t.title), dt);
      const lay = layoutSignposts(s.x, s.z, targets, SIGN_RING);
      // keep posts off the track: slide a blocked post further out (or in) along its slot
      for (const L of lay) {
        if (!this.isClear) break;
        for (const r of [SIGN_RING, SIGN_RING + 0.55, SIGN_RING + 1.1, SIGN_RING - 0.5]) {
          const x = s.x + Math.cos(L.slot) * r, z = s.z + Math.sin(L.slot) * r;
          if (this.isClear(x, z)) { L.x = x; L.z = z; break; }
        }
      }
      lay.forEach((L, k) => {
        live.add(L.title);
        let g = this.signs.get(L.title);
        if (!g) {
          const mesh = new THREE.Mesh(this.geoms.sign, this.materials.station);
          mesh.castShadow = true;
          this.group.add(mesh);
          g = { title: L.title, mesh, born: this.time + k * 0.04 };
          this.signs.set(L.title, g);
        }
        g.x = L.x; g.z = L.z; g.bearing = L.bearing;
        g.y = this._ground(L.x, L.z, s.y);
        const hov = this.hover === L.title;
        const info = this.signInfo.get(L.title) || null;
        const tk = ticketBadge(L.title, state && state.tickets);
        const want = !!(info && info.waiting > 0) || !!tk;
        g.want = want;
        const p = Math.min(1, Math.max(0, (this.time - g.born) / 0.35));
        const k2 = Math.max(0.001, easeOutBack(p)) * (hov ? 1.15 : tk ? 1.2 : want ? 1.08 : 1);
        // wanted signposts hop gently and shine
        const bob = want ? Math.abs(Math.sin(this.time * 3.2 + k * 0.7)) * 0.07 : 0;
        g.mesh.position.set(g.x, g.y + bob, g.z);
        g.mesh.rotation.set(0, -g.bearing, hov ? Math.sin(this.time * 9) * 0.04 : want ? Math.sin(this.time * 3.2 + k * 0.7) * 0.025 : 0);
        g.mesh.scale.setScalar(k2 * 0.95);
        g.mesh.material = (hov || want) ? this.materials.signHover || this.materials.station : this.materials.station;
        if (this.labels) {
          const key = `sign:${L.title}`;
          this.labels.upsert(key, {
            text: this.plain ? 'Build station' : L.title, kind: 'sign', x: g.x, y: g.y + 0.9, z: g.z, priority: tk ? (tk.kind === 'to' ? 2.2e5 : 1.6e5) : want ? 1.2e5 : 1e5, pinned: true, movable: true,
            sub: !this.plain && info && info.price != null ? gold(info.price) : '',
            subDim: !!(info && info.price != null && !info.afford),
            badge: this.plain ? '' : tk ? tk.text : (info && info.waiting > 0) ? `${info.waiting} waiting \u00b7 +${gold(info.fares)}` : '',
            want, tone: tk ? `tkt-${tk.kind}` : '',
            onClick: () => { if (this.onSignClick) this.onSignClick(L.title); },
            onHover: (on) => { this.hover = on ? L.title : (this.hover === L.title ? null : this.hover); },
          });
          this.labels.setFlags(key, hov, false);
        }
      });
    }
    for (const t of [...this.signs.keys()]) if (!live.has(t)) this._removeSign(t);
    if (!live.size) this.signFor = null;
  }

  _removeSign(title) {
    const g = this.signs.get(title);
    if (!g) return;
    this.group.remove(g.mesh);
    this.signs.delete(title);
    if (this.labels) this.labels.remove(`sign:${title}`);
  }

  _clearSigns() { for (const t of [...this.signs.keys()]) this._removeSign(t); }

  // ------------------------------------------------------------ the build target

  _updateTarget(t) {
    const title = this.selection;
    const pos = title ? this._unbuiltPos(title) : null;
    if (this.targetTitle && this.targetTitle !== (pos ? title : null) && this.labels) this.labels.remove(`g:${this.targetTitle}`);
    if (!pos) { this.target.visible = false; this.targetTitle = null; return; }
    if (this.targetTitle !== title) { this.targetTitle = title; this.targetBorn = t; }
    const k = Math.max(0.001, easeOutBack(Math.min(1, (t - this.targetBorn) / 0.45)));
    this.target.visible = true;
    this.target.position.set(pos.x, pos.y, pos.z);
    this.targetRing.position.y = 0.04;
    this.targetRing.rotation.y = t * 0.25;
    this.targetRing.scale.set(k, 1, k);
    const pulse = 1 + Math.sin(t * 2.2) * 0.06;
    this.targetBeam.scale.set(k * pulse, k, k * pulse);
    this.targetGem.position.y = 0.95 + Math.sin(t * 1.8) * 0.07;
    this.targetGem.rotation.y = t * 1.4;
    this.targetGem.scale.setScalar(k);
    if (this.labels) {
      const key = `g:${title}`;
      this.labels.upsert(key, { text: title, kind: 'ghost target', x: pos.x, y: pos.y + 1.3, z: pos.z, priority: 2e5, pinned: true });
    }
  }

  update(dt, state) {
    this.time += dt;
    const t = this.time;
    for (const s of this.built.values()) {
      if (s.born == null) continue;
      const p = Math.min(1, (t - s.born) / 0.65);
      const k = Math.max(0.001, easeOutBack(p));
      const w = (0.7 + 0.3 * Math.min(1, p * 1.5)) * STATION_SCALE;
      s.mesh.scale.set(w, k * STATION_SCALE, w);
      if (p >= 1) { s.mesh.scale.setScalar(STATION_SCALE); s.born = null; }
    }
    this._updateTarget(t);
    this._updateSigns(state, dt);
    this._bubbles(state, t);
    const sp = this.selection ? this.positionOf(this.selection) : null;
    if (sp) {
      this.selectMesh.visible = true;
      const k = 1 + Math.sin(t * 3) * 0.04;
      this.selectMesh.position.set(sp.x, sp.y + 0.035, sp.z);
      this.selectMesh.scale.set(k, 1, k);
      this.selectMesh.rotation.y = t * 0.4;
    } else this.selectMesh.visible = false;
    this._labels(state);
  }

  /**
   * Waiting thoughts as passengers on the platform. Each keeps its own coat; as patience
   * runs out it starts looking up and down the line, then hops and goes red in the face.
   * A pip over each head shows the same three moods, and the least patient passenger at
   * each station gets a speech bubble naming where it wants to go.
   */
  _bubbles(state, t) {
    this.bubbles.begin();
    this.halos.begin();
    this.people.begin();
    this.heads.begin();
    const liveLabels = new Set();
    this.passengerPicks.length = 0;
    const stations = (state && state.stations) || new Map();
    const thoughts = (state && state.thoughts) || [];
    let byId = null;
    const S = STATION_SCALE, K = PERSON_SCALE;
    for (const [title, st] of stations) {
      const s = this.built.get(title);
      if (!s || !st || !Array.isArray(st.waiting) || !st.waiting.length) continue;
      if (s.born != null) continue; // station still rising out of the ground
      if (!byId) { byId = new Map(); for (const th of thoughts) if (th) byId.set(th.id, th); }
      const n = Math.min(MAX_PASSENGERS_SHOWN, st.waiting.length);
      const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
      // two staggered rows along the platform
      const cols = Math.ceil(n / 2);
      const spacing = Math.min(0.16, 0.6 / Math.max(1, cols - 1));
      let worst = null;
      for (let i = 0; i < n; i++) {
        const th = byId.get(st.waiting[i]);
        const id = th ? th.id : i;
        const frac = th && th.patienceMax > 0 ? Math.max(0, Math.min(1, th.patience / th.patienceMax)) : 1;
        const phase = (id * 2.399) % 6.283;
        const pose = passengerPose(frac, t, phase);
        // local frame: track along z through the origin, platform on +x (x 0.19..0.43)
        const row = i % 2, slot = (i - row) / 2;
        const lz = ((slot - (cols - 1) / 2 + row * 0.5 * (n > 1 ? 1 : 0)) * spacing + pose.pace) * S;
        const lx = (row ? 0.375 : 0.25) * S;
        const wx = s.x + lx * cy + lz * sy, wz = s.z - lx * sy + lz * cy;
        const wy = s.y + 0.082 * S + pose.hop;
        _e.set(0, s.yaw + pose.look, pose.tilt);
        _m.compose(_p.set(wx, wy, wz), _q.setFromEuler(_e), _s.set(K, K, K));
        this.people.push(_m, _c.set(COATS[id % COATS.length]));
        _c.set(SKINS[(id * 7) % SKINS.length]);
        if (pose.mood) _c.lerp(FLUSHED, pose.mood === 2 ? 0.6 : 0.15);
        this.heads.push(_m, _c);
        // mood pip over the head
        const col = pose.mood === 0 ? BUBBLE_COLORS.calm : pose.mood === 1 ? BUBBLE_COLORS.worried : BUBBLE_COLORS.urgent;
        const size = pose.mood === 0 ? 0.3 : pose.mood === 1 ? 0.4 + Math.sin(t * 4 + phase) * 0.05 : 0.55 + Math.sin(t * 9 + phase) * 0.12;
        const py = wy + 0.2 * K;
        _m.compose(_p.set(wx, py, wz), _q.identity(), _s.set(size, size, size));
        _c.set(col);
        this.bubbles.push(_m, _c);
        if (pose.mood) {
          _m.compose(_p.set(wx, py, wz), _q.identity(), _s.set(size * 1.1, size * 1.1, size * 1.1));
          this.halos.push(_m, _c.multiplyScalar(0.8));
        }
        if (th) {
          this.passengerPicks.push({ thoughtId: th.id, x: wx, y: wy + 0.09 * K, z: wz });
          const me = { th, frac, mood: pose.mood, x: wx, y: py + 0.06, z: wz, chosen: th.id === this.selectedThought };
          // the bubble belongs to the passenger the player clicked, else to the least patient
          if (!worst || me.chosen || (!worst.chosen && frac < worst.frac)) worst = me;
        }
      }
      if (worst && this.labels && !this.plain) { // plain: passengers wait and ride, but nothing is named
        const key = `t:${title}`;
        const more = !worst.chosen && st.waiting.length > 1 ? ` +${st.waiting.length - 1}` : '';
        this.labels.upsert(key, {
          text: `\u2192 ${worst.th.to}${more}`,
          kind: worst.mood === 2 ? 'thought urgent' : worst.mood === 1 ? 'thought restless' : 'thought',
          x: worst.x, y: worst.y, z: worst.z,
          priority: (worst.chosen ? 5000 : 500) + (1 - worst.frac) * 400,
        });
        liveLabels.add(key);
      }
    }
    if (this.labels) {
      for (const key of this.thoughtLabels) if (!liveLabels.has(key)) this.labels.remove(key);
    }
    this.thoughtLabels = liveLabels;
    this.bubbles.end();
    this.halos.end();
    this.people.end();
    this.heads.end();
  }

  _labels(state) {
    if (!this.labels || this.plain) return; // plain: stations have no names
    const stations = (state && state.stations) || new Map();
    for (const s of this.built.values()) {
      const st = stations.get(s.title);
      const waiting = st && Array.isArray(st.waiting) ? st.waiting.length : 0;
      const key = `s:${s.title}`;
      this.labels.upsert(key, { text: s.title, kind: 'built', x: s.x, y: s.y + 0.95, z: s.z, priority: 1000 + s.pop * 300 + waiting * 20, count: waiting, pinned: this.selection === s.title });
      this.labels.setFlags(key, this.hover === s.title, this.selection === s.title);
    }
  }

  dispose() {
    for (const t of [...this.built.keys()]) this._removeBuilt(t);
    this._clearSigns();
    if (this.labels && this.targetTitle) this.labels.remove(`g:${this.targetTitle}`);
    this.bubbles.dispose(); this.halos.dispose(); this.people.dispose(); this.heads.dispose();
    if (this.labels) for (const key of this.thoughtLabels) this.labels.remove(key);
    for (const g of Object.values(this.geoms)) g.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
