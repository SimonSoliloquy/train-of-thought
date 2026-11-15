// Trains: per-type low-poly locomotives and carriages, and the pure placement of
// every car along its own track by arc length. Each train serves one track for life,
// so at either end the trailing carriages bunch into the station (and hide there).
import * as THREE from 'three';
import { MeshBuilder, shade } from './builder.js';
import { sampleRoute, routeLength } from './rail.js';
import { TRAIN_TYPES } from '../config.js';
import { TUNNEL_COVER } from './track.js';

// ------------------------------------------------------------ pure layout

export const CAR_SPECS = {
  local:   { loco: 0.5,  car: 0.42, gap: 0.05 },
  express: { loco: 0.64, car: 0.5,  gap: 0.04 },
  freight: { loco: 0.56, car: 0.4,  gap: 0.04 },
  bullet:  { loco: 0.74, car: 0.52, gap: 0.03 },
};

/** Unknown or retired type ids fall back to a drawable one. */
export function drawableType(typeId) {
  if (TRAIN_TYPES[typeId] && CAR_SPECS[typeId]) return typeId;
  if (typeId === 'hauler') return 'freight';
  return 'local';
}

/** Distances behind the head (train front) of each vehicle's centre. */
export function carOffsets(typeId) {
  typeId = drawableType(typeId);
  const spec = CAR_SPECS[typeId];
  const type = TRAIN_TYPES[typeId] || TRAIN_TYPES.local;
  const n = Math.max(0, Math.floor(type.cars || 0));
  const out = [{ kind: 'loco', index: 0, centre: spec.loco / 2, half: spec.loco / 2 }];
  let d = spec.loco + spec.gap;
  for (let i = 0; i < n; i++) {
    out.push({ kind: 'car', index: i, centre: d + spec.car / 2, half: spec.car / 2 });
    d += spec.car + spec.gap;
  }
  return out;
}

/**
 * Returns sampler(d) -> {x,y,z,kind,clamped} for the point d world units behind the head.
 * prev: {route, joinAtTo} — the track the train came from, joined at the trailing station.
 */
export function makeTrailSampler(route, t, forward, prev = null) {
  const L = routeLength(route);
  const s = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * L;
  const Lp = prev && prev.route ? routeLength(prev.route) : 0;
  return (d) => {
    const a = forward ? s - d : s + d;
    if (L <= 0) {
      const p = route.points && route.points[0];
      return p ? { x: p.x, y: p.y, z: p.z, kind: p.kind || 'ground', clamped: d } : { x: 0, y: 0, z: 0, kind: 'ground', clamped: d };
    }
    if (a >= 0 && a <= L) {
      const p = sampleRoute(route, a / L);
      return { x: p.x, y: p.y, z: p.z, kind: p.kind, clamped: 0, s: a };
    }
    const over = a < 0 ? -a : a - L;
    if (Lp > 0) {
      const ap = Math.min(Lp, prev.joinAtTo ? Lp - over : over);
      const p = sampleRoute(prev.route, Math.max(0, ap) / Lp);
      return { x: p.x, y: p.y, z: p.z, kind: p.kind, clamped: Math.max(0, over - Lp), s: a < 0 ? 0 : L };
    }
    const p = sampleRoute(route, a < 0 ? 0 : 1);
    return { x: p.x, y: p.y, z: p.z, kind: p.kind, clamped: over, s: a < 0 ? 0 : L };
  };
}

/**
 * Placement of every vehicle.
 * @returns {{x,y,z,dx,dy,dz,kind,hidden,inTunnel}[]}  d* = unit facing direction (direction of travel)
 */
export function placeCars(route, t, forward, offsets, prev = null, buried = null) {
  const inRock = buried || ((p) => p.kind === 'tunnel');
  const sample = makeTrailSampler(route, t, forward, prev);
  const L = routeLength(route);
  const head = L > 0 ? sampleRoute(route, Number.isFinite(t) ? t : 0) : { dx: 1, dy: 0, dz: 0 };
  const sign = forward ? 1 : -1;
  return offsets.map((o) => {
    const c = sample(o.centre);
    const f = sample(o.centre - o.half * 0.7);
    const r = sample(o.centre + o.half * 0.7);
    let dx = f.x - r.x, dy = f.y - r.y, dz = f.z - r.z;
    let l = Math.hypot(dx, dy, dz);
    if (l < 1e-5) { dx = head.dx * sign; dy = head.dy * sign; dz = head.dz * sign; l = Math.hypot(dx, dy, dz) || 1; }
    return {
      x: c.x, y: c.y, z: c.z,
      dx: dx / l, dy: dy / l, dz: dz / l,
      kind: c.kind,
      inTunnel: inRock(c) && inRock(f) && inRock(r),
      hidden: c.clamped > o.half,
    };
  });
}

// ------------------------------------------------------------ geometry (forward = +z, rail top = y 0)

const DARK = '#2e2f33';
const STEEL = '#55585e';
const GLASS = '#2c3e55';
const WARM = '#f6e3a6';
const WHITE = '#f4f2ec';

function cylZ(b, x, y, z0, r, len, sides, color, capFront = true) {
  const ring = (z) => {
    const out = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
      out.push([x + Math.cos(a) * r, y + Math.sin(a) * r, z]);
    }
    return out;
  };
  const A = ring(z0), B = ring(z0 + len);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    const k = 0.8 + 0.2 * Math.max(0, Math.sin((i + 0.5) / sides * Math.PI * 2));
    b.quad(A[i], A[j], B[j], B[i], shade(color, k));
  }
  if (capFront) for (let i = 0; i < sides; i++) b.tri([x, y, z0 + len], B[i], B[(i + 1) % sides], shade(color, 0.9));
  for (let i = 0; i < sides; i++) b.tri([x, y, z0], A[(i + 1) % sides], A[i], shade(color, 0.7));
}

function wheels(b, zs, r = 0.04, spread = 0.085) {
  for (const z of zs) {
    for (const s of [-1, 1]) {
      // octagonal disc facing x
      const cx = s * spread, cy = r - 0.01;
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        pts.push([cx, cy + Math.sin(a) * r, z + Math.cos(a) * r]);
      }
      for (let i = 0; i < 8; i++) b.tri([cx + s * 0.012, cy, z], pts[i], pts[(i + 1) % 8], DARK);
    }
  }
}

function bogie(b, z) {
  b.box(0, 0.035, z, 0.16, 0.035, 0.14, STEEL);
  wheels(b, [z - 0.045, z + 0.045], 0.032);
}

function windowRow(b, y, z0, z1, n, h, color, side = 0.098) {
  const span = (z1 - z0) / n;
  for (let i = 0; i < n; i++) {
    const z = z0 + span * (i + 0.5);
    for (const s of [-1, 1]) b.box(s * side, y, z, 0.008, h, span * 0.62, color);
  }
}

function coachLocal() {
  const paint = new MeshBuilder(), trim = new MeshBuilder();
  paint.box(0, 0.135, 0, 0.19, 0.15, 0.4, '#ffffff');
  trim.box(0, 0.22, 0, 0.2, 0.025, 0.41, '#7d7f84');
  trim.box(0, 0.237, 0, 0.12, 0.012, 0.38, '#8d9095');
  windowRow(trim, 0.15, -0.17, 0.17, 4, 0.06, WARM);
  trim.box(0, 0.068, 0, 0.17, 0.02, 0.4, DARK);
  bogie(trim, -0.13); bogie(trim, 0.13);
  return { paint, trim };
}

function locoLocal() {
  const paint = new MeshBuilder(), trim = new MeshBuilder();
  // running board + chassis
  trim.box(0, 0.075, 0, 0.2, 0.03, 0.48, DARK);
  wheels(trim, [-0.13, 0, 0.13], 0.05, 0.08);
  // boiler
  cylZ(paint, 0, 0.16, -0.08, 0.072, 0.29, 8, '#ffffff');
  cylZ(trim, 0, 0.16, 0.2, 0.076, 0.04, 8, DARK);
  // smokestack, dome, headlamp
  trim.prism(0, 0.22, 0.165, 0.022, 0.03, 0.09, 6, DARK);
  paint.blob(0, 0.235, 0.03, 0.035, 0.03, 0.035, '#ffffff');
  trim.box(0, 0.215, 0.235, 0.04, 0.03, 0.02, '#fff2b0');
  // cab
  paint.box(0, 0.19, -0.16, 0.2, 0.17, 0.15, '#ffffff');
  trim.box(0, 0.285, -0.16, 0.23, 0.022, 0.18, '#3b3d42');
  for (const s of [-1, 1]) trim.box(s * 0.101, 0.215, -0.16, 0.006, 0.055, 0.07, GLASS);
  // buffer beam
  trim.box(0, 0.085, 0.245, 0.21, 0.04, 0.02, '#b8352a');
  trim.prism(0, 0.03, 0.26, 0.09, 0.02, 0.05, 4, DARK, { phase: Math.PI / 4 });
  return { paint, trim, chimney: [0, 0.32, 0.165] };
}

function locoExpress() {
  const paint = new MeshBuilder(), trim = new MeshBuilder();
  const L = 0.64;
  trim.box(0, 0.06, -0.02, 0.18, 0.03, L - 0.06, DARK);
  bogie(trim, -0.2); bogie(trim, 0.16);
  // body
  paint.box(0, 0.15, -0.09, 0.2, 0.15, 0.44, '#ffffff', 0, { noBottom: true });
  // streamlined nose: from z 0.13 to 0.32
  const z0 = 0.13, z1 = 0.32, y0 = 0.075, y1 = 0.225, w = 0.1;
  const nose = [
    [[-w, y1, z0], [w, y1, z0], [w * 0.7, y0 + 0.06, z1], [-w * 0.7, y0 + 0.06, z1]],
  ];
  paint.quad(nose[0][0], nose[0][3], nose[0][2], nose[0][1], '#ffffff');
  for (const s of [-1, 1]) {
    paint.quad([s * w, y0, z0], [s * w, y1, z0], [s * w * 0.7, y0 + 0.06, z1], [s * w * 0.7, y0, z1], shade('#ffffff', 0.85));
  }
  paint.quad([-w * 0.7, y0, z1], [w * 0.7, y0, z1], [w * 0.7, y0 + 0.06, z1], [-w * 0.7, y0 + 0.06, z1], shade('#ffffff', 0.9));
  // windscreen on the slope
  const lerp = (a, b, t) => a + (b - a) * t;
  const wy = (t) => lerp(y1, y0 + 0.06, t), wz = (t) => lerp(z0, z1, t);
  trim.quad([-0.075, wy(0.08) + 0.004, wz(0.08)], [-0.07, wy(0.38) + 0.004, wz(0.38)], [0.07, wy(0.38) + 0.004, wz(0.38)], [0.075, wy(0.08) + 0.004, wz(0.08)], GLASS);
  // white speed stripe and window band
  for (const s of [-1, 1]) {
    trim.box(s * 0.101, 0.11, -0.09, 0.005, 0.022, 0.44, WHITE);
    trim.box(s * 0.101, 0.185, -0.12, 0.005, 0.04, 0.34, GLASS);
  }
  trim.box(0, 0.23, -0.09, 0.17, 0.018, 0.42, '#c9ccd2');
  trim.box(0, 0.12, 0.32, 0.05, 0.02, 0.01, '#fff6c8');
  return { paint, trim, chimney: null };
}

function coachExpress() {
  const paint = new MeshBuilder(), trim = new MeshBuilder();
  paint.box(0, 0.145, 0, 0.19, 0.14, 0.48, '#ffffff', 0, { noBottom: true });
  trim.box(0, 0.225, 0, 0.17, 0.022, 0.47, '#c9ccd2');
  for (const s of [-1, 1]) {
    trim.box(s * 0.0965, 0.17, 0, 0.005, 0.045, 0.42, GLASS);
    trim.box(s * 0.0965, 0.11, 0, 0.005, 0.02, 0.48, WHITE);
  }
  trim.box(0, 0.065, 0, 0.17, 0.02, 0.46, DARK);
  bogie(trim, -0.16); bogie(trim, 0.16);
  return { paint, trim };
}

function locoHauler() {
  const paint = new MeshBuilder(), trim = new MeshBuilder();
  trim.box(0, 0.075, 0, 0.22, 0.035, 0.54, DARK);
  bogie(trim, -0.17); bogie(trim, 0.17);
  // long hood
  paint.box(0, 0.16, 0.08, 0.15, 0.135, 0.34, '#ffffff');
  // cab
  paint.box(0, 0.2, -0.17, 0.21, 0.215, 0.16, '#ffffff');
  trim.box(0, 0.315, -0.17, 0.23, 0.02, 0.18, '#3b3d42');
  for (const s of [-1, 1]) trim.box(s * 0.106, 0.24, -0.17, 0.006, 0.06, 0.09, GLASS);
  trim.box(0, 0.24, -0.085, 0.16, 0.06, 0.006, GLASS);
  // hazard stripes on the nose, exhaust, handrails
  for (let i = 0; i < 3; i++) trim.box(-0.05 + i * 0.05, 0.13, 0.252, 0.025, 0.06, 0.006, i % 2 ? DARK : '#f2c230');
  trim.prism(0, 0.225, 0.02, 0.018, 0.02, 0.05, 6, DARK);
  for (const s of [-1, 1]) trim.box(s * 0.105, 0.135, 0.08, 0.006, 0.006, 0.34, '#d8d8d8');
  trim.box(0, 0.19, 0.255, 0.035, 0.022, 0.01, '#fff2b0');
  return { paint, trim, chimney: [0, 0.27, 0.02] };
}

function wagonHauler(variant) {
  const paint = new MeshBuilder(), trim = new MeshBuilder();
  trim.box(0, 0.065, 0, 0.18, 0.025, 0.38, DARK);
  bogie(trim, -0.12); bogie(trim, 0.12);
  if (variant === 1) {
    // tank wagon
    cylZ(paint, 0, 0.155, -0.17, 0.075, 0.34, 8, '#ffffff');
    trim.prism(0, 0.22, 0, 0.03, 0.03, 0.03, 6, DARK);
    trim.box(0, 0.1, 0, 0.2, 0.012, 0.02, DARK);
  } else if (variant === 2) {
    // box car
    paint.box(0, 0.15, 0, 0.19, 0.16, 0.37, '#ffffff');
    trim.box(0, 0.235, 0, 0.2, 0.014, 0.38, '#7d7f84');
    for (const s of [-1, 1]) trim.box(s * 0.097, 0.15, 0, 0.006, 0.12, 0.12, shade('#ffffff', 0.55));
  } else {
    // open hopper with a heap of ore
    const h = 0.13, y0 = 0.08;
    paint.box(0, y0 + h / 2, 0.175, 0.19, h, 0.02, '#ffffff');
    paint.box(0, y0 + h / 2, -0.175, 0.19, h, 0.02, '#ffffff');
    paint.box(0.085, y0 + h / 2, 0, 0.02, h, 0.33, '#ffffff');
    paint.box(-0.085, y0 + h / 2, 0, 0.02, h, 0.33, '#ffffff');
    trim.box(0, y0 + 0.07, 0, 0.16, 0.02, 0.33, '#4a3f36');
    trim.blob(0, y0 + 0.1, 0.06, 0.08, 0.06, 0.1, variant === 3 ? '#9a6a3a' : '#35322f');
    trim.blob(0, y0 + 0.1, -0.07, 0.075, 0.055, 0.09, variant === 3 ? '#a8763f' : '#3c3936');
  }
  return { paint, trim };
}

/** Streamlined power car: long low nose sloping almost to the rails. */
function locoBullet() {
  const paint = new MeshBuilder(), trim = new MeshBuilder();
  trim.box(0, 0.05, -0.05, 0.17, 0.025, 0.6, DARK);
  bogie(trim, -0.24); bogie(trim, 0.14);
  // body: rounded by a lighter roof slab on top
  paint.box(0, 0.13, -0.15, 0.2, 0.13, 0.42, '#ffffff', 0, { noBottom: true });
  trim.box(0, 0.205, -0.15, 0.17, 0.03, 0.42, '#f2f2f0');
  // long nose from z 0.06 to 0.37
  const z0 = 0.06, z1 = 0.37, yb = 0.065, yt = 0.22, w = 0.1;
  const tipY = yb + 0.035;
  paint.quad([-w, yt, z0], [-w * 0.35, tipY + 0.02, z1], [w * 0.35, tipY + 0.02, z1], [w, yt, z0], '#ffffff');
  for (const s of [-1, 1]) paint.quad([s * w, yb, z0], [s * w, yt, z0], [s * w * 0.35, tipY + 0.02, z1], [s * w * 0.35, yb, z1], shade('#ffffff', 0.82));
  paint.quad([-w * 0.35, yb, z1], [w * 0.35, yb, z1], [w * 0.35, tipY + 0.02, z1], [-w * 0.35, tipY + 0.02, z1], shade('#ffffff', 0.9));
  // cockpit glass on the nose slope
  const L = (a, b, t) => a + (b - a) * t;
  const gy = (t) => L(yt, tipY + 0.02, t) + 0.004, gz = (t) => L(z0, z1, t);
  trim.quad([-0.075, gy(0.05), gz(0.05)], [-0.05, gy(0.4), gz(0.4)], [0.05, gy(0.4), gz(0.4)], [0.075, gy(0.05), gz(0.05)], GLASS);
  for (const s of [-1, 1]) {
    trim.box(s * 0.101, 0.165, -0.15, 0.005, 0.04, 0.4, GLASS);
    trim.box(s * 0.101, 0.1, -0.12, 0.005, 0.018, 0.46, WHITE);
  }
  trim.box(0, 0.1, 0.37, 0.06, 0.016, 0.008, '#fff6c8');
  return { paint, trim, chimney: null };
}

function coachBullet() {
  const paint = new MeshBuilder(), trim = new MeshBuilder();
  paint.box(0, 0.13, 0, 0.2, 0.13, 0.5, '#ffffff', 0, { noBottom: true });
  trim.box(0, 0.205, 0, 0.17, 0.03, 0.49, '#f2f2f0');
  for (const s of [-1, 1]) {
    trim.box(s * 0.101, 0.165, 0, 0.005, 0.04, 0.46, GLASS);
    trim.box(s * 0.101, 0.1, 0, 0.005, 0.018, 0.5, WHITE);
  }
  trim.box(0, 0.055, 0, 0.17, 0.02, 0.48, DARK);
  bogie(trim, -0.17); bogie(trim, 0.17);
  return { paint, trim };
}

/**
 * Carriages are drawn this much narrower than modelled so two trains in neighbouring lanes
 * (WORLD.laneSpacing apart) pass with daylight between them. Same for every train type.
 */
export const TRAIN_SCALE_X = 0.86;

/** Full drawn width of the widest vehicle of a train type (what it needs of a lane). */
export function trainWidth(typeId) {
  typeId = drawableType(typeId);
  let w = 0;
  const kinds = [['loco', 0], ['car', 0], ['car', 1], ['car', 2], ['car', 3]];
  for (const [kind, index] of kinds) {
    const b = vehicleBuilders(typeId, kind, index);
    for (const m of [b.paint, b.trim]) {
      const pos = m.pos;
      for (let i = 0; i < pos.length; i += 3) w = Math.max(w, Math.abs(pos[i]) * 2);
    }
  }
  return w * TRAIN_SCALE_X;
}

/** Builders per (type, vehicle). Exported for tests. */
export function vehicleBuilders(typeId, kind, index) {
  typeId = drawableType(typeId);
  if (kind === 'loco') {
    if (typeId === 'express') return locoExpress();
    if (typeId === 'freight') return locoHauler();
    if (typeId === 'bullet') return locoBullet();
    return locoLocal();
  }
  if (typeId === 'express') return coachExpress();
  if (typeId === 'freight') return wagonHauler(index % 4);
  if (typeId === 'bullet') return coachBullet();
  return coachLocal();
}

// ------------------------------------------------------------ view

const geomCache = new Map();
function vehicleGeoms(typeId, kind, index) {
  typeId = drawableType(typeId);
  const key = `${typeId}|${kind}|${kind === 'car' && typeId === 'freight' ? index % 4 : 0}`;
  let g = geomCache.get(key);
  if (!g) {
    const b = vehicleBuilders(typeId, kind, index);
    g = { paint: b.paint.toGeometry(), trim: b.trim.toGeometry(), chimney: b.chimney || null };
    geomCache.set(key, g);
  }
  return g;
}

export function disposeTrainGeometries() {
  for (const g of geomCache.values()) { g.paint.dispose(); g.trim.dispose(); }
  geomCache.clear();
}

const _v = new THREE.Vector3();

export class TrainsView {
  constructor({ parent, materials, makePaintMaterial, smoke, groundAt, naturalAt, onTypeChange, buriedAt }) {
    // (trackId, arcLength) => true/false inside the drawn tunnel, null when unknown
    this.buriedAt = typeof buriedAt === 'function' ? buriedAt : null;
    this.onTypeChange = onTypeChange || null; // (x, y, z, typeId) when a track's train is replaced
    // a vehicle hides only when it is in a tunnel stretch AND under the hill (same rule as
    // the portals in track.js, so cars vanish exactly at the tunnel mouth)
    const hill = typeof naturalAt === 'function' ? naturalAt : groundAt;
    this.buried = typeof hill === 'function'
      ? (p) => p.kind === 'tunnel' && hill(p.x, p.z) > p.y + TUNNEL_COVER
      : null;
    this.group = new THREE.Group();
    this.group.name = 'trains';
    parent.add(this.group);
    this.materials = materials;
    this.makePaintMaterial = makePaintMaterial;
    this.smoke = smoke;
    this.trains = new Map(); // id -> record
  }

  _create(train) {
    const typeId = drawableType(train.typeId);
    const offsets = carOffsets(typeId);
    const paintMat = this.makePaintMaterial();
    const vehicles = offsets.map((o) => {
      const g = vehicleGeoms(typeId, o.kind, o.index);
      const obj = new THREE.Group();
      const pm = new THREE.Mesh(g.paint, paintMat);
      const tm = new THREE.Mesh(g.trim, this.materials.trim);
      pm.castShadow = tm.castShadow = true;
      pm.receiveShadow = tm.receiveShadow = true;
      obj.add(pm, tm);
      obj.rotation.order = 'YXZ';
      obj.visible = false;
      this.group.add(obj);
      return { obj, offset: o, chimney: g.chimney, pos: { x: 0, y: 0, z: 0 }, visible: false };
    });
    const rec = { id: train.id, trackId: train.trackId, typeId, offsets, vehicles, paintMat, color: null, smokeT: 0, head: null, seen: true, spawn: 0 };
    this.trains.set(train.id, rec);
    return rec;
  }

  _remove(rec) {
    for (const v of rec.vehicles) this.group.remove(v.obj);
    rec.paintMat.dispose();
    this.trains.delete(rec.id);
  }

  /**
   * @param {object} state  GameState
   * @param {number} dt
   */
  update(state, dt) {
    const trains = (state && state.trains) || [];
    const tracks = (state && state.tracks) || [];
    for (const rec of this.trains.values()) rec.seen = false;
    for (const train of trains) {
      if (!train) continue;
      let rec = this.trains.get(train.id);
      if (rec && rec.typeId !== drawableType(train.typeId)) { this._remove(rec); rec = null; }
      if (!rec) {
        rec = this._create(train);
        // a train that appears after the first frame is a purchase or upgrade: flourish
        rec.fx = this.frames > 0;
      }
      rec.seen = true;
      const track = tracks.find((k) => k.id === train.trackId);
      if (!track || !track.route || !track.route.points || !track.route.points.length) {
        for (const v of rec.vehicles) v.obj.visible = false;
        rec.head = null;
        continue;
      }
      const color = (TRAIN_TYPES[rec.typeId] && TRAIN_TYPES[rec.typeId].color) || '#dddddd';
      if (color !== rec.color) { rec.paintMat.color.set(color); rec.color = color; }
      const fallback = this.buried;
      const buriedAt = this.buriedAt;
      const inRock = buriedAt
        ? (p) => { const b = buriedAt(train.trackId, p.s); return b == null ? (fallback ? fallback(p) : p.kind === 'tunnel') : b; }
        : fallback;
      const places = placeCars(track.route, train.t, train.forward !== false, rec.offsets, null, inRock);
      rec.spawn = Math.min(1, rec.spawn + dt * 3);
      const k = rec.spawn < 1 ? 0.0001 + rec.spawn * (2 - rec.spawn) : 1;
      for (let i = 0; i < rec.vehicles.length; i++) {
        const v = rec.vehicles[i], p = places[i];
        const vis = !p.hidden && !p.inTunnel && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
        v.obj.visible = vis;
        v.visible = vis;
        if (!Number.isFinite(p.x)) continue;
        v.obj.position.set(p.x, p.y, p.z);
        v.obj.rotation.set(-Math.asin(Math.max(-1, Math.min(1, p.dy))), Math.atan2(p.dx, p.dz), 0);
        v.obj.scale.set(k * TRAIN_SCALE_X, k, k);
        v.pos.x = p.x; v.pos.y = p.y; v.pos.z = p.z;
      }
      const h = places[0];
      rec.head = { x: h.x, y: h.y, z: h.z, dx: h.dx, dy: h.dy, dz: h.dz, inTunnel: h.inTunnel };
      if (rec.fx) { rec.fx = false; if (this.onTypeChange) this.onTypeChange(h.x, h.y, h.z, rec.typeId); }
      // smoke / exhaust
      const loco = rec.vehicles[0];
      if (this.smoke && loco.chimney && loco.visible && train.state !== 'dwelling') {
        rec.smokeT -= dt;
        if (rec.smokeT <= 0) {
          rec.smokeT = rec.typeId === 'freight' ? 0.22 : 0.13;
          loco.obj.updateMatrixWorld();
          _v.set(loco.chimney[0], loco.chimney[1], loco.chimney[2]).applyMatrix4(loco.obj.matrixWorld);
          this.smoke.emit(_v.x, _v.y, _v.z, rec.typeId === 'freight' ? 0.45 : 1);
        }
      } else if (this.smoke && loco.chimney && loco.visible && train.state === 'dwelling') {
        rec.smokeT -= dt * 0.25;
        if (rec.smokeT <= 0) {
          rec.smokeT = 0.6;
          loco.obj.updateMatrixWorld();
          _v.set(loco.chimney[0], loco.chimney[1], loco.chimney[2]).applyMatrix4(loco.obj.matrixWorld);
          this.smoke.emit(_v.x, _v.y, _v.z, rec.typeId === 'freight' ? 0.45 : 0.8);
        }
      }
    }
    for (const rec of [...this.trains.values()]) if (!rec.seen) this._remove(rec);
    this.frames = (this.frames || 0) + 1;
  }

  /** Pick candidates: one sphere per visible vehicle. */
  pickables() {
    const out = [];
    for (const rec of this.trains.values()) {
      for (const v of rec.vehicles) if (v.visible) out.push({ trainId: rec.id, x: v.pos.x, y: v.pos.y + 0.14, z: v.pos.z });
    }
    return out;
  }

  head(trainId) {
    const rec = this.trains.get(trainId);
    return rec ? rec.head : null;
  }

  dispose() {
    for (const rec of [...this.trains.values()]) this._remove(rec);
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
