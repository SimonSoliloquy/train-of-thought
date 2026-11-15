// Low-poly scenery props: geometry builders (one shared geometry per prop type,
// drawn instanced) and the deterministic per-tile layout. Pure: no DOM, no GL.
import { MeshBuilder } from './builder.js';
import { hexToWorld, hashString, mulberry32 } from '../hex.js';
import { WORLD } from '../config.js';

function leaf(b, x0, y0, z0, ang, len, droop, w, color) {
  // A drooping palm frond: two quads from the crown outward.
  const cx = Math.cos(ang), cz = Math.sin(ang);
  const px = -cz * w, pz = cx * w;
  const mid = [x0 + cx * len * 0.5, y0 + droop * 0.2, z0 + cz * len * 0.5];
  const tip = [x0 + cx * len, y0 - droop, z0 + cz * len];
  const base = [x0, y0, z0];
  b.quad(base, [mid[0] + px, mid[1], mid[2] + pz], tip, [mid[0] - px, mid[1], mid[2] - pz], color);
}

function blade(b, x, z, h, lean, ang, w, color) {
  const cx = Math.cos(ang), cz = Math.sin(ang);
  b.tri([x - cz * w, 0, z + cx * w], [x + cz * w, 0, z - cx * w], [x + cx * lean, h, z + cz * lean], color);
}

export const PROP_BUILDERS = {
  broadleaf(rnd) {
    const b = new MeshBuilder();
    b.prism(0, 0, 0, 0.038, 0.028, 0.17, 5, '#7a5634');
    b.blob(0, 0.28, 0, 0.16, 0.14, 0.16, '#5aa83c', rnd, 0.18);
    b.blob(0.06, 0.35, 0.03, 0.1, 0.09, 0.1, '#72bd48', rnd, 0.18);
    return b;
  },
  pine(rnd, snow = false) {
    const b = new MeshBuilder();
    b.prism(0, 0, 0, 0.032, 0.026, 0.1, 5, '#6b4a2f');
    const sh = (i) => (i % 2 ? 0.86 : 1);
    b.prism(0, 0.08, 0, 0.165, 0, 0.21, 7, snow ? '#3d6b4a' : '#2f6f3a', { sideShade: sh });
    b.prism(0, 0.2, 0, 0.13, 0, 0.19, 7, snow ? '#d9e4e6' : '#367b41', { sideShade: sh, phase: 0.4 });
    b.prism(0, 0.32, 0, 0.09, 0, 0.17, 7, snow ? '#f4f7f8' : '#3f8a48', { sideShade: sh, phase: 0.8 });
    return b;
  },
  snowPine(rnd) { return PROP_BUILDERS.pine(rnd, true); },
  palm(rnd) {
    const b = new MeshBuilder();
    let x = 0, y = 0;
    const segs = 3;
    for (let i = 0; i < segs; i++) {
      b.prism(x, y, 0, 0.026 - i * 0.003, 0.023 - i * 0.003, 0.125, 4, i % 2 ? '#a07a4c' : '#8c6a40', { capTop: i === segs - 1, phase: i * 0.4 });
      x += 0.02 + i * 0.012; y += 0.125;
    }
    x -= 0.012;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      leaf(b, x, y + 0.01, 0, a, 0.22, 0.08, 0.035, i % 2 ? '#3f9a3a' : '#4fae42');
    }
    b.box(x, y - 0.015, 0, 0.04, 0.03, 0.04, '#6a4a2a');
    return b;
  },
  jungle(rnd) {
    const b = new MeshBuilder();
    b.prism(0, 0, 0, 0.05, 0.03, 0.4, 5, '#6a5136');
    b.blob(0, 0.44, 0, 0.22, 0.09, 0.2, '#237a3a', rnd, 0.2);
    b.blob(0.1, 0.5, 0.06, 0.14, 0.07, 0.13, '#2f8f40', rnd, 0.2);
    b.blob(-0.09, 0.4, -0.05, 0.13, 0.07, 0.12, '#1f6d34', rnd, 0.2);
    return b;
  },
  bush(rnd) {
    const b = new MeshBuilder();
    b.blob(0, 0.055, 0, 0.09, 0.07, 0.09, '#4f9a3a', rnd, 0.22);
    b.blob(0.06, 0.04, 0.03, 0.06, 0.05, 0.06, '#5fab43', rnd, 0.22);
    return b;
  },
  fern(rnd) {
    const b = new MeshBuilder();
    for (let i = 0; i < 6; i++) leaf(b, 0, 0.09, 0, (i / 6) * Math.PI * 2, 0.13, 0.07, 0.03, i % 2 ? '#2a8a3e' : '#38a04a');
    return b;
  },
  tuft(rnd) {
    const b = new MeshBuilder();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      blade(b, Math.cos(a) * 0.02, Math.sin(a) * 0.02, 0.07 + (i % 3) * 0.02, 0.03, a, 0.012, i % 2 ? '#86b84d' : '#a2c95a');
    }
    return b;
  },
  flowers(rnd) {
    const b = PROP_BUILDERS.tuft(rnd);
    const cols = ['#ffffff', '#ffd84d', '#ff8fb1', '#c9a4ff'];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.5;
      b.prism(Math.cos(a) * 0.05, 0.06, Math.sin(a) * 0.05, 0.022, 0, 0.03, 3, cols[i], { phase: a });
    }
    return b;
  },
  cactus(rnd) {
    const b = new MeshBuilder();
    const g = '#4f8a45';
    b.prism(0, 0, 0, 0.042, 0.036, 0.3, 6, g, { sideShade: (i) => (i % 2 ? 0.85 : 1) });
    b.box(0.05, 0.13, 0, 0.07, 0.035, 0.035, g);
    b.prism(0.08, 0.12, 0, 0.026, 0.022, 0.12, 6, g);
    b.box(-0.045, 0.18, 0, 0.06, 0.03, 0.03, g);
    b.prism(-0.07, 0.17, 0, 0.022, 0.02, 0.08, 6, g);
    return b;
  },
  dune(rnd) {
    const b = new MeshBuilder();
    const L = 0.28, W = 0.11, H = 0.075;
    const lit = '#f0d08e', dark = '#cf9f58';
    const A = [-L, 0, -W], B = [L, 0, -W * 0.6], C = [L, 0, W * 0.6], D = [-L, 0, W];
    const R0 = [-L * 0.8, H, -W * 0.2], R1 = [L * 0.7, H * 0.8, 0];
    b.quad(A, R0, R1, B, lit);
    b.quad(D, C, R1, R0, dark);
    b.tri(A, D, R0, lit);
    b.tri(B, R1, C, dark);
    return b;
  },
  boulder(rnd) {
    const b = new MeshBuilder();
    b.blob(0, 0.05, 0, 0.1, 0.075, 0.09, '#8f8a82', rnd, 0.3);
    b.blob(0.09, 0.03, 0.04, 0.05, 0.04, 0.05, '#9d978e', rnd, 0.3);
    return b;
  },
  rockPeak(rnd) {
    const b = new MeshBuilder();
    const sh = (i) => [1, 0.8, 0.92, 0.72, 0.88][i % 5];
    b.prism(0, -0.02, 0, 0.34, 0, 0.62, 5, '#7b7770', { sideShade: sh, phase: rnd() * 6 });
    b.prism(0.2, -0.02, 0.1, 0.2, 0, 0.36, 5, '#857f76', { sideShade: sh, phase: rnd() * 6 });
    return b;
  },
  snowPeak(rnd) {
    const b = new MeshBuilder();
    const sh = (i) => [1, 0.8, 0.92, 0.72, 0.88][i % 5];
    const ph = rnd() * 6;
    b.prism(0, -0.02, 0, 0.36, 0.15, 0.42, 5, '#77736c', { sideShade: sh, phase: ph, capTop: false });
    b.prism(0, 0.4, 0, 0.15, 0, 0.3, 5, '#f4f7f9', { sideShade: sh, phase: ph });
    b.prism(-0.19, -0.02, 0.12, 0.18, 0, 0.36, 5, '#827d75', { sideShade: sh, phase: ph + 1 });
    return b;
  },
  mesa(rnd) {
    const b = new MeshBuilder();
    b.prism(0, -0.02, 0, 0.3, 0.27, 0.2, 7, '#bf613a');
    b.prism(0, 0.18, 0, 0.26, 0.245, 0.14, 7, '#d9824e');
    b.prism(0, 0.32, 0, 0.245, 0.23, 0.1, 7, '#b5532f', { top: '#e09a5e' });
    return b;
  },
  spire(rnd) {
    const b = new MeshBuilder();
    b.prism(0, -0.02, 0, 0.1, 0.065, 0.32, 5, '#c46a3c');
    b.prism(0, 0.3, 0, 0.068, 0.05, 0.18, 5, '#d98450');
    b.prism(0, 0.48, 0, 0.095, 0.085, 0.045, 5, '#a9502f', { capBottom: true });
    return b;
  },
  reeds(rnd) {
    const b = new MeshBuilder();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + rnd();
      const r = 0.02 + rnd() * 0.05;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = 0.14 + rnd() * 0.12;
      blade(b, x, z, h, 0.02, a, 0.01, i % 2 ? '#9fb24f' : '#7f9a3f');
      if (i % 3 === 0) b.box(x + Math.cos(a) * 0.02, h * 0.82, z + Math.sin(a) * 0.02, 0.014, 0.04, 0.014, '#6b4a2c');
    }
    return b;
  },
  willow(rnd) {
    const b = new MeshBuilder();
    b.prism(0, 0, 0, 0.045, 0.032, 0.22, 5, '#6e5636');
    b.prism(0, 0.1, 0, 0.21, 0.17, 0.2, 9, '#7cb24e', { capTop: false, sideShade: (i) => (i % 2 ? 0.88 : 1) });
    b.blob(0, 0.31, 0, 0.19, 0.11, 0.19, '#8cc05a', rnd, 0.15);
    return b;
  },
};

export const PROP_TYPES = Object.keys(PROP_BUILDERS);

// Small ground clutter: no shadows, and hidden when the camera is far out.
export const SMALL_PROPS = new Set(['tuft', 'flowers', 'fern', 'dune', 'reeds', 'bush', 'boulder']);

// Props that occupy a lot of room: one per tile, kept near the middle.
const BIG = new Set(['rockPeak', 'snowPeak', 'mesa']);

function pick(rnd, table) {
  let total = 0;
  for (const [, w] of table) total += w;
  let x = rnd() * total;
  for (const [t, w] of table) { x -= w; if (x <= 0) return t; }
  return table[table.length - 1][0];
}

/**
 * Deterministic props for one tile.
 * @param {import('../types.js').Tile} tile
 * @param {{nearWater?: boolean}} [ctx]
 * @returns {{type:string, x:number, y:number, z:number, yaw:number, scale:number, tint:number}[]}
 */
export function layoutTileProps(tile, ctx = {}) {
  if (!tile || tile.water) return [];
  const d = Number.isFinite(tile.detail) ? tile.detail : 0.5;
  const e = Number.isFinite(tile.elevation) ? tile.elevation : 0;
  const rnd = mulberry32(hashString(`${tile.q},${tile.r}`) ^ Math.floor(d * 1e6));
  const snowLine = WORLD.maxElevation * 0.72;
  let count = 0, table;
  switch (tile.biome) {
    case 'forest':
      count = 3 + Math.floor(d * 3);
      table = [['pine', 3], ['broadleaf', 3], ['bush', 1]];
      break;
    case 'jungle':
      count = 4 + Math.floor(d * 3);
      table = [['jungle', 4], ['palm', 2], ['fern', 2], ['bush', 1]];
      break;
    case 'desert':
      if (d > 0.93) { count = 3; table = [['palm', 3], ['bush', 1]]; break; }
      count = Math.floor(d * 3.2);
      table = [['cactus', 2], ['dune', 3], ['boulder', 0.5]];
      break;
    case 'mountains':
      if (e >= snowLine) { count = 1 + Math.floor(d * 3); table = [['snowPeak', 2], ['snowPine', 1.5], ['boulder', 1]]; }
      else if (e >= snowLine * 0.55) { count = 2 + Math.floor(d * 3); table = [['rockPeak', 2], ['pine', 2], ['boulder', 2]]; }
      else { count = 2 + Math.floor(d * 3); table = [['pine', 3], ['boulder', 1.2], ['tuft', 1]]; }
      break;
    case 'riverlands':
      count = 2 + Math.floor(d * 3);
      table = [['reeds', ctx.nearWater ? 4 : 1], ['willow', 1.5], ['tuft', 2], ['bush', 1], ['flowers', 0.6]];
      break;
    case 'canyon':
      count = 1 + Math.floor(d * 2.5);
      table = [['mesa', 1.2], ['spire', 2], ['boulder', 2], ['cactus', 0.6]];
      break;
    case 'grassland':
    default:
      count = 1 + Math.floor(d * 4);
      table = [['tuft', 4], ['flowers', 2], ['broadleaf', 1.5], ['bush', 1], ['boulder', 0.4]];
      break;
  }
  const c = hexToWorld(tile.q, tile.r);
  const out = [];
  let haveBig = false;
  for (let i = 0; i < count; i++) {
    let type = pick(rnd, table);
    if (BIG.has(type)) {
      if (haveBig) type = type === 'mesa' ? 'spire' : 'boulder';
      else haveBig = true;
    }
    const big = BIG.has(type);
    const space = big ? 0.42 : 0.2;
    let placed = null;
    for (let tries = 0; tries < 6 && !placed; tries++) {
      const rr = (big ? 0.35 : 0.72) * Math.sqrt(rnd());
      const a = rnd() * Math.PI * 2;
      const px = Math.cos(a) * rr, pz = Math.sin(a) * rr;
      let ok = true;
      for (const o of out) {
        const need = Math.max(space, BIG.has(o.type) ? 0.42 : 0.2);
        if (Math.hypot(o.x - c.x - px, o.z - c.z - pz) < need) { ok = false; break; }
      }
      if (ok) placed = { px, pz };
    }
    if (!placed) continue;
    out.push({
      type,
      x: c.x + placed.px,
      y: e,
      z: c.z + placed.pz,
      yaw: rnd() * Math.PI * 2,
      scale: (big ? 0.85 : 0.8) + rnd() * 0.45,
      tint: 0.88 + rnd() * 0.24,
    });
  }
  return out;
}

export function buildPropGeometryBuilders(seed = 1234) {
  const out = {};
  for (const t of PROP_TYPES) out[t] = PROP_BUILDERS[t](mulberry32(seed + hashString(t)));
  return out;
}

