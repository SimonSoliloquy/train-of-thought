// The landscape surface as one continuous faceted heightfield. Pure: no three.js, no DOM.
//
// The world is a hex grid, but nothing drawn should read as a hexagon. The surface is a
// regular triangular grid three times finer than the hex lattice (hex (q, r) is grid vertex
// (3q, 3r)), so every hex centre is a vertex and the facets fall between them freely.
// Vertex height blends nearby hex elevations with a smooth kernel plus a little biome
// roughness, so hills roll and cliffs become steep rock faces. Water hexes are river beds
// under a separate water surface. Committed track and station sites grade the surface
// (cuttings, embankments, pads). Land beyond the revealed area slopes down into the mist.
import { hexToWorld, worldToHex, HEX_DIRS } from '../hex.js';

import { tileColors, BIOME_PALETTE } from './palette.js';
import { rgb } from './builder.js';

export const SQRT3 = Math.sqrt(3);
export const GRID = 1 / SQRT3;      // grid spacing (world units)
export const CHUNK = 30;            // grid cells per chunk side (10 hexes)
export const BED_DROP = 0.42;       // river bed below a water hex's surface level
export const WATER_DROP = 0.05;     // drawn water surface below a water hex's elevation
export const FLOOR_Y = -1.35;       // where land that is not there yet waits, under the mist
export const EDGE_SINK = 0.55;      // the unrevealed rim sags this much as it fades into the mist
export const KERNEL_SIGMA = 0.95;   // gaussian blend of hex elevations (neighbours sit at sqrt 3)
export const KERNEL_R = 3.0;        // cut-off of the blend
export const MISS_GAIN = 1.0;       // how much of the blend's miss at hex centres is added back (keeps relief)
// the hex itself and its first two rings, as axial offsets
const RING2 = (() => {
  const out = [{ q: 0, r: 0 }];
  for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) {
    const d = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
    if (d >= 1 && d <= 2) out.push({ q, r });
  }
  return out;
})();
export const REVEAL_DUR = 0.55;     // seconds for a vertex to rise into place
export const TRACK_GRADE = { inner: 0.62, outer: 1.25, drop: 0.03 };
export const PAD_GRADE = { inner: 0.8, outer: 1.45 };

const ROUGH = { mountains: 0.32, canyon: 0.1, forest: 0.08, jungle: 0.09, grassland: 0.06, desert: 0.07, riverlands: 0.04 };
const ROCK = { mountains: '#8a8279', canyon: '#b45a35', desert: '#c6955a' };
const BANK = rgb('#8f7f5a');

export function gridToWorld(i, j) { return { x: (i + j / 2) * GRID, z: j / 2 }; }
export function worldToGridF(x, z) { const j = 2 * z; return { i: x * SQRT3 - j / 2, j }; }

function vkey(i, j) { return (i + 50000) * 100003 + (j + 50000); }
function hkey(q, r) { return (q + 32768) * 65536 + (r + 32768); }
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function lat(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ 0x2f6b1d;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = lat(ix, iz), b = lat(ix + 1, iz), c = lat(ix, iz + 1), d = lat(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
/** Deterministic hash in [0,1) for a grid triangle (colour jitter). */
export function triHash(i, j, k) { return lat(i * 2 + k, j * 7 + 13); }

export class Surface {
  /** @param {(q:number, r:number) => import('../types.js').Tile} terrainAt */
  constructor(terrainAt) {
    this.terrainAt = terrainAt;
    this.nat = new Map();       // vkey -> natural vertex record
    this.revealed = new Set();  // hkey of revealed hexes
    this.chunks = new Map();    // "ci,cj" -> chunk
    this.features = new Map();  // cell "cx,cz" -> [feature]
    this.featureSets = new Map(); // id -> [feature]
    this.tileCols = new WeakMap();
    this.misses = new Map();    // hkey -> how far the plain blend misses that hex centre
  }

  // ------------------------------------------------------------ natural land

  _cols(t) {
    let c = this.tileCols.get(t);
    if (!c) {
      const tc = tileColors(t);
      const b = BIOME_PALETTE[t.biome] ? t.biome : 'grassland';
      c = { top: tc.top, rock: rgb(ROCK[b] || BIOME_PALETTE[b].side) };
      this.tileCols.set(t, c);
    }
    return c;
  }

  _tile(q, r) {
    try { return this.terrainAt(q, r) || null; } catch { return null; }
  }

  /** Height a hex centre should have: its elevation, or its river bed. */
  static targetOf(t) {
    const e = Number.isFinite(t.elevation) ? t.elevation : 0;
    return t.water ? e - BED_DROP : e;
  }

  /**
   * How far the plain kernel blend at a hex centre misses that hex's own height. Adding the
   * blended misses back (one step of deconvolution) keeps peaks and gorges at their true
   * height instead of rounding them away, while the land between hexes stays smooth.
   */
  _miss(q, r) {
    const k = hkey(q, r);
    let m = this.misses.get(k);
    if (m !== undefined) return m;
    const t = this._tile(q, r);
    if (!t) { this.misses.set(k, 0); return 0; }
    const c = hexToWorld(q, r);
    const inv = 1 / (KERNEL_SIGMA * KERNEL_SIGMA);
    let sw = 0, sh = 0;
    for (const o of RING2) {
      const n = o.q || o.r ? this._tile(q + o.q, r + o.r) : t;
      if (!n) continue;
      const p = hexToWorld(q + o.q, r + o.r);
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d >= KERNEL_R) continue;
      const w = Math.exp(-d * d * inv);
      sw += w; sh += w * Surface.targetOf(n);
    }
    m = sw > 0 ? Surface.targetOf(t) - sh / sw : 0;
    this.misses.set(k, m);
    return m;
  }

  /** Natural (ungraded, fully revealed) vertex: height, blended biome colour, rock colour, water level. */
  natural(i, j) {
    const k = vkey(i, j);
    let v = this.nat.get(k);
    if (v) return v;
    const { x, z } = gridToWorld(i, j);
    const hc = worldToHex(x, z);
    let sw = 0, sh = 0, sm = 0, rough = 0, wl = NaN, wd = Infinity, dmin = Infinity, bank = 0;
    const top = [0, 0, 0], rock = [0, 0, 0];
    const inv = 1 / (KERNEL_SIGMA * KERNEL_SIGMA);
    for (const o of RING2) {
      const q = hc.q + o.q, r = hc.r + o.r;
      const c = hexToWorld(q, r);
      const d = Math.hypot(c.x - x, c.z - z);
      if (d >= KERNEL_R) continue;
      let t = null;
      try { t = this.terrainAt(q, r); } catch { t = null; }
      if (!t) continue;
      if (d < dmin) dmin = d;
      const e = Number.isFinite(t.elevation) ? t.elevation : 0;
      if (t.water && d < 1.8 && d < wd) { wd = d; wl = e - WATER_DROP; }
      const w = Math.exp(-d * d * inv);
      sw += w;
      sh += w * (t.water ? e - BED_DROP : e);
      sm += w * this._miss(q, r);
      if (t.water) bank += w;
      rough += w * (t.water ? 0 : (ROUGH[t.biome] ?? 0.06));
      const cc = this._cols(t);
      for (let m = 0; m < 3; m++) { top[m] += w * cc.top[m]; rock[m] += w * cc.rock[m]; }
    }
    if (sw <= 0) sw = 1;
    let h = (sh + sm * MISS_GAIN) / sw;
    rough /= sw;
    bank /= sw;
    // a little relief between hex centres, none at the centres themselves
    const away = smooth(0.25, 0.8, dmin);
    h += rough * away * ((vnoise(x * 1.3, z * 1.3) - 0.5) * 2.2 + (vnoise(x * 3.1 + 9, z * 3.1) - 0.5) * 0.8);
    for (let m = 0; m < 3; m++) { top[m] /= sw; rock[m] /= sw; }
    v = { h, top, rock, wl, bank: Math.min(1, bank * 2.2) };
    this.nat.set(k, v);
    return v;
  }

  // ------------------------------------------------------------ reveal

  revealHex(q, r) { this.revealed.add(hkey(q, r)); }
  isRevealed(q, r) { return this.revealed.has(hkey(q, r)); }

  /** 1 inside revealed land, falling to 0 across the first unrevealed ring. */
  rho(i, j) {
    const { x, z } = gridToWorld(i, j);
    const hc = worldToHex(x, z);
    let d = Infinity;
    for (let n = 0; n < 7; n++) {
      const q = n ? hc.q + HEX_DIRS[n - 1].q : hc.q, r = n ? hc.r + HEX_DIRS[n - 1].r : hc.r;
      if (!this.revealed.has(hkey(q, r))) continue;
      const c = hexToWorld(q, r);
      d = Math.min(d, Math.hypot(c.x - x, c.z - z));
    }
    return d === Infinity ? 0 : 1 - smooth(1.0, 2.6, d);
  }

  // ------------------------------------------------------------ grading (track beds, station pads)

  /** Replace the grading features registered under id. Returns the affected world bbox or null. */
  setFeatures(id, list) {
    const old = this.featureSets.get(id);
    let box = null;
    const grow = (f) => {
      const b = f.box;
      if (!box) box = { ...b }; else { box.minX = Math.min(box.minX, b.minX); box.maxX = Math.max(box.maxX, b.maxX); box.minZ = Math.min(box.minZ, b.minZ); box.maxZ = Math.max(box.maxZ, b.maxZ); }
    };
    if (old) {
      for (const f of old) {
        grow(f);
        for (const ck of f.cells) { const arr = this.features.get(ck); if (arr) this.features.set(ck, arr.filter((g) => g !== f)); }
      }
      this.featureSets.delete(id);
    }
    if (list && list.length) {
      for (const f of list) {
        const o = f.outer;
        const minX = Math.min(f.ax, f.bx ?? f.ax) - o, maxX = Math.max(f.ax, f.bx ?? f.ax) + o;
        const minZ = Math.min(f.az, f.bz ?? f.az) - o, maxZ = Math.max(f.az, f.bz ?? f.az) + o;
        f.box = { minX, maxX, minZ, maxZ };
        f.cells = [];
        for (let cx = Math.floor(minX / 2); cx <= Math.floor(maxX / 2); cx++) {
          for (let cz = Math.floor(minZ / 2); cz <= Math.floor(maxZ / 2); cz++) {
            const ck = `${cx},${cz}`;
            let arr = this.features.get(ck);
            if (!arr) { arr = []; this.features.set(ck, arr); }
            arr.push(f);
            f.cells.push(ck);
          }
        }
        grow(f);
      }
      this.featureSets.set(id, list);
    }
    return box;
  }

  _graded(x, z, h) {
    const arr = this.features.get(`${Math.floor(x / 2)},${Math.floor(z / 2)}`);
    if (!arr || !arr.length) return h;
    let bw = 0, bt = h, bd = Infinity;
    for (const f of arr) {
      let d, target;
      if (f.type === 'pad') {
        d = Math.hypot(x - f.ax, z - f.az);
        target = f.ay;
      } else {
        const dx = f.bx - f.ax, dz = f.bz - f.az;
        const l2 = dx * dx + dz * dz || 1e-9;
        let t = ((x - f.ax) * dx + (z - f.az) * dz) / l2;
        if (t < 0) { if (!f.capA) continue; t = 0; }
        if (t > 1) { if (!f.capB) continue; t = 1; }
        d = Math.hypot(f.ax + dx * t - x, f.az + dz * t - z);
        target = f.ay + (f.by - f.ay) * t;
      }
      if (d >= f.outer) continue;
      // the nearest feature decides (overlapping segment end-caps must not win)
      const w = 1 - smooth(f.inner, f.outer, d);
      if (d - f.inner < bd) { bd = d - f.inner; bw = w; bt = target; }
    }
    return bw > 0 ? h + (bt - h) * bw : h;
  }

  // ------------------------------------------------------------ final heights, chunked

  /** Height actually drawn at a grid vertex (graded, sunk outside the revealed land). */
  computeFinal(i, j) {
    const nv = this.natural(i, j);
    const { x, z } = gridToWorld(i, j);
    const r = this.rho(i, j);
    const hg = this._graded(x, z, nv.h);
    return { h: hg - EDGE_SINK * (1 - r) * (1 - r), rho: r };
  }

  chunkKey(ci, cj) { return `${ci},${cj}`; }

  chunk(ci, cj) {
    const key = this.chunkKey(ci, cj);
    let c = this.chunks.get(key);
    if (!c) {
      const n = CHUNK * CHUNK;
      c = { key, ci, cj, h: new Float32Array(n), rho: new Float32Array(n), prev: new Float32Array(n), born: new Float32Array(n).fill(-1e9), computed: false };
      this.chunks.set(key, c);
    }
    if (!c.computed) this.recompute(c, null);
    return c;
  }

  /**
   * Recompute a chunk's heights. anim: {now, origin:{x,z}|null, perUnit} makes changed
   * vertices glide from their currently displayed height. Returns true if anything changed.
   */
  recompute(c, anim) {
    let changed = false;
    const first = !c.computed;
    c.computed = true;
    for (let lj = 0; lj < CHUNK; lj++) {
      for (let li = 0; li < CHUNK; li++) {
        const idx = lj * CHUNK + li;
        const i = c.ci * CHUNK + li, j = c.cj * CHUNK + lj;
        const f = this.computeFinal(i, j);
        const old = c.h[idx];
        c.rho[idx] = f.rho;
        if (!first && Math.abs(f.h - old) < 1e-5) continue;
        changed = true;
        if (anim) {
          // a brand-new chunk starts where its neighbours already draw unrevealed land (sunk
          // into the mist), not at a common floor: rising from one floor next to land that is
          // already up made long spikes on high ground
          const shown = first ? Math.max(FLOOR_Y, this.natural(i, j).h - EDGE_SINK) : displayed(c.prev[idx], old, c.born[idx], anim.now);
          let delay = 0;
          if (anim.origin) {
            const { x, z } = gridToWorld(i, j);
            delay = Math.min(0.5, Math.hypot(x - anim.origin.x, z - anim.origin.z) * (anim.perUnit || 0));
          }
          c.prev[idx] = shown;
          c.born[idx] = anim.now + delay;
        } else {
          c.prev[idx] = f.h;
          c.born[idx] = -1e9;
        }
        c.h[idx] = f.h;
      }
    }
    return changed || first;
  }

  vertex(i, j) {
    const ci = Math.floor(i / CHUNK), cj = Math.floor(j / CHUNK);
    const c = this.chunk(ci, cj);
    const idx = (j - cj * CHUNK) * CHUNK + (i - ci * CHUNK);
    return { h: c.h[idx], rho: c.rho[idx], prev: c.prev[idx], born: c.born[idx] };
  }

  heightAt(i, j) {
    const ci = Math.floor(i / CHUNK), cj = Math.floor(j / CHUNK);
    const c = this.chunk(ci, cj);
    return c.h[(j - cj * CHUNK) * CHUNK + (i - ci * CHUNK)];
  }

  /** Chunk keys whose vertices lie within the world bbox. */
  chunksIn(box) {
    const out = [];
    const a = worldToGridF(box.minX, box.minZ), b = worldToGridF(box.maxX, box.minZ);
    const c = worldToGridF(box.minX, box.maxZ), d = worldToGridF(box.maxX, box.maxZ);
    const i0 = Math.floor(Math.min(a.i, b.i, c.i, d.i)) - 1, i1 = Math.ceil(Math.max(a.i, b.i, c.i, d.i)) + 1;
    const j0 = Math.floor(Math.min(a.j, c.j)) - 1, j1 = Math.ceil(Math.max(a.j, c.j)) + 1;
    for (let cj = Math.floor(j0 / CHUNK); cj <= Math.floor(j1 / CHUNK); cj++) {
      for (let ci = Math.floor(i0 / CHUNK); ci <= Math.floor(i1 / CHUNK); ci++) out.push([ci, cj]);
    }
    return out;
  }

  // ------------------------------------------------------------ queries

  _interp(x, z, get) {
    const g = worldToGridF(x, z);
    const i0 = Math.floor(g.i), j0 = Math.floor(g.j);
    const u = g.i - i0, v = g.j - j0;
    if (u + v <= 1) return get(i0, j0) * (1 - u - v) + get(i0 + 1, j0) * u + get(i0, j0 + 1) * v;
    return get(i0 + 1, j0) * (1 - v) + get(i0 + 1, j0 + 1) * (u + v - 1) + get(i0, j0 + 1) * (1 - u);
  }

  /** Height of the drawn land surface (river beds included) at a world point. */
  groundAt(x, z) { return this._interp(x, z, (i, j) => this.heightAt(i, j)); }

  /** Natural land height (no grading, ignores the reveal): what the hill really is. */
  naturalAt(x, z) { return this._interp(x, z, (i, j) => this.natural(i, j).h); }

  /** Water surface height at a world point, or null when there is no water there. */
  waterAt(x, z) {
    const g = worldToGridF(x, z);
    const i = Math.round(g.i), j = Math.round(g.j);
    let wl = NaN;
    for (const [a, b] of [[i, j], [i + 1, j], [i, j + 1], [i - 1, j], [i, j - 1]]) {
      const n = this.natural(a, b);
      if (Number.isFinite(n.wl)) { wl = Number.isFinite(wl) ? Math.max(wl, n.wl) : n.wl; }
    }
    if (!Number.isFinite(wl)) return null;
    return this.groundAt(x, z) < wl ? wl : null;
  }
}

/** How much a vertex has dissolved into the mist (0 inside the revealed land, 1 at the rim). */
export function edgeOf(rho) { return 1 - rho; }

/** Height shown at time now for a vertex gliding from prev to h since born. */
export function displayed(prev, h, born, now) {
  const t = Math.min(1, Math.max(0, (now - born) / REVEAL_DUR));
  const e = 1 - (1 - t) ** 3;
  return prev + (h - prev) * e;
}

/**
 * Triangles of one chunk as flat arrays (positions, prev heights, born times, colours),
 * plus the water surface over it. Triangles wholly outside the land (rho 0) are skipped.
 */
export function buildChunkArrays(surface, ci, cj) {
  const pos = [], prev = [], born = [], colors = [], edge = [];
  const col = [0, 0, 0];
  const wpos = [], wprev = [], wborn = [], wedge = [];
  const H = (i, j) => surface.heightAt(i, j);
  const V = (i, j) => {
    const v = surface.vertex(i, j);
    const n = surface.natural(i, j);
    const w = gridToWorld(i, j);
    // smooth slope at the vertex (from its neighbours), so rock and grass do not alternate
    // triangle by triangle on steep ground (the "sawtooth" look)
    const gx = (H(i + 1, j) - H(i - 1, j)) / (2 * GRID);
    const gz = ((H(i, j + 1) - H(i, j - 1)) + (H(i - 1, j + 1) - H(i + 1, j - 1))) / 2;
    const slope = 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz);
    // river bank: wet earth instead of rock where the bed falls away under the water
    const wet = Number.isFinite(n.wl) ? n.bank * (1 - smooth(0.1, 0.45, v.h - n.wl)) : 0;
    return { i, j, x: w.x, z: w.z, h: v.h, rho: v.rho, prev: v.prev, born: v.born, n, slope, wet };
  };
  const cache = new Map();
  const get = (i, j) => {
    const k = vkey(i, j);
    let v = cache.get(k);
    if (!v) { v = V(i, j); cache.set(k, v); }
    return v;
  };
  for (let lj = 0; lj < CHUNK; lj++) {
    for (let li = 0; li < CHUNK; li++) {
      const i = ci * CHUNK + li, j = cj * CHUNK + lj;
      const a = get(i, j), b = get(i + 1, j), c = get(i, j + 1), d = get(i + 1, j + 1);
      // counter-clockwise seen from above (+y)
      emitTri(a, c, b, 0);
      emitTri(b, c, d, 1);
    }
  }

  function emitTri(p, q, r, k) {
    const maxRho = Math.max(p.rho, q.rho, r.rho);
    if (maxRho <= 0.001) return;
    // face colour: blended biome colour, rock on steep faces, earthy at the sunken edge
    const ux = q.x - p.x, uy = q.h - p.h, uz = q.z - p.z;
    const vx = r.x - p.x, vy = r.h - p.h, vz = r.z - p.z;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const ylen = Math.abs(ny) / (Math.hypot(nx, ny, nz) || 1);
    const faceSlope = 1 - ylen;
    const slope = faceSlope * 0.25 + ((p.slope + q.slope + r.slope) / 3) * 0.75;
    const rockT = smooth(0.26, 0.55, slope);
    const wetT = (p.wet + q.wet + r.wet) / 3;
    const jit = 0.975 + triHash(p.i, p.j, k) * 0.05;
    for (let m = 0; m < 3; m++) {
      const topM = (p.n.top[m] + q.n.top[m] + r.n.top[m]) / 3;
      const rockM = (p.n.rock[m] + q.n.rock[m] + r.n.rock[m]) / 3;
      let cm = topM + (rockM - topM) * rockT;
      cm += (BANK[m] - cm) * wetT * 0.85;
      col[m] = Math.min(1, cm * jit * (1 - slope * 0.1));
    }
    for (const v of [p, q, r]) {
      pos.push(v.x, v.h, v.z);
      prev.push(v.prev);
      born.push(v.born);
      edge.push(edgeOf(v.rho));
    }
    for (let m = 0; m < 3; m++) colors.push(col[0], col[1], col[2]);
    // water over this triangle?
    const wls = [p.n.wl, q.n.wl, r.n.wl].filter(Number.isFinite);
    if (wls.length) {
      const top = Math.max(...wls);
      if (Math.min(p.h, q.h, r.h) < top - 0.005) {
        for (const v of [p, q, r]) {
          const lvl = Number.isFinite(v.n.wl) ? v.n.wl : top;
          const wy = lvl - EDGE_SINK * (1 - v.rho) * (1 - v.rho);
          wedge.push(edgeOf(v.rho));
          wpos.push(v.x, wy, v.z);
          wprev.push(v.prev + (wy - v.h));
          wborn.push(v.born);
        }
      }
    }
  }
  return { pos, prev, born, colors, edge, wpos, wprev, wborn, wedge };
}
