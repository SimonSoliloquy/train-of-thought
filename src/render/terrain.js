// Hex terrain: instanced tile caps + cliff walls, water surfaces, instanced props,
// frontier clouds, and the staggered "rise from the mist" reveal animation.
import * as THREE from 'three';
import { MeshBuilder, hexCorners } from './builder.js';
import { tileColors } from './palette.js';
import { layoutTileProps, buildPropGeometryBuilders, PROP_TYPES, SMALL_PROPS } from './props.js';
import { InstancePool, SpatialPool } from './pool.js';
import { hexToWorld, worldToHex, hexKey, hexNeighbors, hashString, mulberry32 } from '../hex.js';

export const BASE_Y = -1.6;        // bottom of every cliff wall (hidden in the mist)
export const CHAMFER = 0.05;       // bevel drop at the rim of each tile top
export const WATER_DROP = 0.14;    // water surface below the tile's nominal elevation
export const BED_DROP = 0.42;      // river bed below the tile's nominal elevation

export const REVEAL = { tileDur: 0.42, propDelay: 0.2, propDur: 0.34, maxSpread: 0.5, perUnit: 0.05 };

/** Bevelled hex cap, top at y = 0. */
export function buildCapGeometry() {
  const b = new MeshBuilder();
  const inner = hexCorners(0.9), outer = hexCorners(1.0);
  const c = [0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const ii = [inner[i][0], 0, inner[i][1]], ij = [inner[j][0], 0, inner[j][1]];
    const oi = [outer[i][0], -CHAMFER, outer[i][1]], oj = [outer[j][0], -CHAMFER, outer[j][1]];
    b.tri(c, ij, ii, [1, 1, 1]);
    b.quad(ii, ij, oj, oi, [0.93, 0.93, 0.93]);
  }
  return b;
}

/** Open hex tube from y = 0 down to y = -1, darkening and banded toward the bottom. */
export function buildWallGeometry() {
  const b = new MeshBuilder();
  const o = hexCorners(1.0);
  const bands = [0, -0.35, -1];
  const shades = [1.0, 0.86];
  for (let k = 0; k < bands.length - 1; k++) {
    const y0 = bands[k], y1 = bands[k + 1];
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6;
      // faces facing roughly away from the sun read darker for a crisp cliff look
      const face = (i % 3 === 0) ? 1 : (i % 3 === 1 ? 0.94 : 0.88);
      const s = shades[k] * face;
      // wound so the computed normal points outward
      b.quad([o[i][0], y0, o[i][1]], [o[j][0], y0, o[j][1]], [o[j][0], y1, o[j][1]], [o[i][0], y1, o[i][1]], [s, s, s]);
    }
  }
  return b;
}

/** Subdivided flat hex for the water surface (so the wave shader has vertices to move). */
export function buildWaterGeometry() {
  const b = new MeshBuilder();
  const mid = hexCorners(0.5), out = hexCorners(1.0);
  const c = [0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const mi = [mid[i][0], 0, mid[i][1]], mj = [mid[j][0], 0, mid[j][1]];
    const oi = [out[i][0], 0, out[i][1]], oj = [out[j][0], 0, out[j][1]];
    const om = [(out[i][0] + out[j][0]) / 2, 0, (out[i][1] + out[j][1]) / 2];
    b.tri(c, mj, mi, [1, 1, 1]);
    b.tri(mi, mj, om, [1, 1, 1]);
    b.tri(mi, om, oi, [1, 1, 1]);
    b.tri(mj, oj, om, [1, 1, 1]);
  }
  return b;
}

export function buildCloudGeometry() {
  const b = new MeshBuilder();
  const rnd = mulberry32(77);
  b.blob(0, 0.1, 0, 0.75, 0.26, 0.65, [1, 1, 1], rnd, 0.08, 0);
  b.blob(0.45, 0.05, 0.2, 0.5, 0.2, 0.45, [1, 1, 1], rnd, 0.08, 0);
  b.blob(-0.4, 0.02, -0.25, 0.55, 0.18, 0.45, [1, 1, 1], rnd, 0.08, 0);
  b.blob(0.1, 0.24, -0.1, 0.4, 0.2, 0.38, [1, 1, 1], rnd, 0.08, 0);
  return b;
}

/**
 * Instance transforms of one tile at a given reveal progress p (0 hidden .. 1 settled).
 * Pure: used by the renderer and by the smoke tests.
 */
export function tileTransforms(tile, p = 1) {
  const { x, z } = hexToWorld(tile.q, tile.r);
  const e = Number.isFinite(tile.elevation) ? tile.elevation : 0;
  const ease = 1 - Math.pow(1 - clamp01(p), 3);
  const lift = -(1 - ease) * 1.4;
  const s = 0.5 + 0.5 * easeOutBack(clamp01(p));
  const topY = tile.water ? e - BED_DROP : e;
  const wallTop = topY - CHAMFER;
  return {
    x, z, s, lift,
    capY: topY + lift,
    wallY: wallTop + lift,
    wallH: Math.max(0.05, wallTop - BASE_Y),
    waterY: tile.water ? e - WATER_DROP + lift : null,
  };
}

export function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class Terrain {
  constructor({ parent, materials, world }) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    parent.add(this.group);
    this.geoms = {
      cap: buildCapGeometry().toGeometry(),
      wall: buildWallGeometry().toGeometry(),
      water: buildWaterGeometry().toGeometry(),
      cloud: buildCloudGeometry().toGeometry(),
    };
    this.capPool = new SpatialPool(this.group, this.geoms.cap, materials.terrain, { chunk: 256, name: 'caps' });
    this.wallPool = new SpatialPool(this.group, this.geoms.wall, materials.terrain, { chunk: 256, name: 'walls' });
    this.waterPool = new SpatialPool(this.group, this.geoms.water, materials.water, { chunk: 128, castShadow: false, name: 'water', renderOrder: 2 });
    this.cloudPool = new InstancePool(this.group, this.geoms.cloud, materials.cloud, { chunk: 1024, castShadow: false, receiveShadow: false, name: 'clouds', renderOrder: 3 });
    const pb = buildPropGeometryBuilders();
    this.propPools = {};
    this.propGeoms = {};
    for (const t of PROP_TYPES) {
      this.propGeoms[t] = pb[t].toGeometry();
      this.propPools[t] = new SpatialPool(this.group, this.propGeoms[t], materials.props, { chunk: 256, name: `prop-${t}`, castShadow: !SMALL_PROPS.has(t) });
    }
    this.tiles = new Map();      // key -> record
    this.clouds = new Map();     // key -> {id, x, y, z, s, born, dying}
    this.animating = new Set();  // records being revealed
    this.cloudAnim = new Set();
    this.blocks = new Map();     // cell key -> [{x, z, r}]
    this.bounds = { minX: -6, maxX: 6, minZ: -6, maxZ: 6, empty: true };
    this.time = 0;
  }

  get tileCount() { return this.tiles.size; }

  has(q, r) { return this.tiles.has(hexKey(q, r)); }

  /** Height of the walkable top (or the river bed) at a world point; 0 when unknown. */
  groundAt(x, z) {
    const h = worldToHex(x, z);
    const rec = this.tiles.get(hexKey(h.q, h.r));
    let tile = rec ? rec.tile : null;
    if (!tile && this.world && typeof this.world.terrainAt === 'function') {
      try { tile = this.world.terrainAt(h.q, h.r); } catch { tile = null; }
    }
    if (!tile) return 0;
    const e = Number.isFinite(tile.elevation) ? tile.elevation : 0;
    return tile.water ? e - BED_DROP : e;
  }

  /** Water surface at a point, or null when that hex is not water. */
  waterAt(x, z) {
    const h = worldToHex(x, z);
    const rec = this.tiles.get(hexKey(h.q, h.r));
    const tile = rec ? rec.tile : null;
    if (!tile || !tile.water) return null;
    return tile.elevation - WATER_DROP;
  }

  /**
   * Add tiles. animate: ripple outward from origin {x, z}.
   * Returns the number of tiles actually added.
   */
  reveal(tiles, { animate = false, origin = null } = {}) {
    if (!tiles || !tiles.length) return 0;
    const fresh = [];
    for (const t of tiles) {
      if (!t || !Number.isFinite(t.q) || !Number.isFinite(t.r)) continue;
      const key = hexKey(t.q, t.r);
      if (this.tiles.has(key)) continue;
      fresh.push(t);
    }
    if (!fresh.length) return 0;
    let ox = 0, oz = 0;
    if (origin) { ox = origin.x; oz = origin.z; }
    else {
      for (const t of fresh) { const w = hexToWorld(t.q, t.r); ox += w.x; oz += w.z; }
      ox /= fresh.length; oz /= fresh.length;
    }
    let maxD = 0;
    const dists = fresh.map((t) => {
      const w = hexToWorld(t.q, t.r);
      const d = Math.hypot(w.x - ox, w.z - oz);
      if (d > maxD) maxD = d;
      return d;
    });
    const perUnit = maxD > 0 ? Math.min(REVEAL.perUnit, REVEAL.maxSpread / maxD) : 0;
    fresh.forEach((t, i) => this._addTile(t, animate ? dists[i] * perUnit : null));
    this._updateFrontier(fresh, animate);
    this._flush();
    return fresh.length;
  }

  _addTile(tile, delay) {
    const key = hexKey(tile.q, tile.r);
    const cols = tileColors(tile);
    const tr = tileTransforms(tile, delay == null ? 1 : 0);
    const rec = { key, tile, x: tr.x, z: tr.z, cap: null, wall: null, water: null, props: [], cols, start: this.time, delay: delay || 0 };
    rec.cap = this.capPool.add(this._capMatrix(tr), _c.setRGB(cols.top[0], cols.top[1], cols.top[2]), tr.x, tr.z);
    rec.wall = this.wallPool.add(this._wallMatrix(tr), _c.setRGB(cols.side[0], cols.side[1], cols.side[2]), tr.x, tr.z);
    if (tile.water) {
      const k = 0.92 + (tile.detail || 0) * 0.16;
      rec.water = this.waterPool.add(this._waterMatrix(tr), _c.setRGB(k, k, k), tr.x, tr.z);
    }
    let nearWater = false;
    if (!tile.water && tile.biome === 'riverlands') nearWater = this._nearWater(tile);
    const props = layoutTileProps(tile, { nearWater });
    for (const p of props) {
      if (this._blocked(p.x, p.z, 0.07)) continue;
      const pool = this.propPools[p.type];
      if (!pool) continue;
      const scale = delay == null ? p.scale : 0.0001;
      p.id = pool.add(this._propMatrix(p, scale, 0), _c.setRGB(p.tint, p.tint, p.tint), tr.x, tr.z);
      rec.props.push(p);
    }
    this.tiles.set(key, rec);
    const b = this.bounds;
    if (b.empty) { b.minX = b.maxX = tr.x; b.minZ = b.maxZ = tr.z; b.empty = false; }
    else {
      b.minX = Math.min(b.minX, tr.x); b.maxX = Math.max(b.maxX, tr.x);
      b.minZ = Math.min(b.minZ, tr.z); b.maxZ = Math.max(b.maxZ, tr.z);
    }
    if (delay != null) this.animating.add(rec);
  }

  _nearWater(tile) {
    for (const n of hexNeighbors(tile.q, tile.r)) {
      const rec = this.tiles.get(hexKey(n.q, n.r));
      let t = rec ? rec.tile : null;
      if (!t && this.world && typeof this.world.terrainAt === 'function') {
        try { t = this.world.terrainAt(n.q, n.r); } catch { t = null; }
      }
      if (t && t.water) return true;
    }
    return false;
  }

  _capMatrix(tr) {
    return _m.compose(_p.set(tr.x, tr.capY, tr.z), _q.identity(), _s.set(tr.s, 1, tr.s));
  }
  _wallMatrix(tr) {
    return _m.compose(_p.set(tr.x, tr.wallY, tr.z), _q.identity(), _s.set(tr.s, tr.wallH, tr.s));
  }
  _waterMatrix(tr) {
    return _m.compose(_p.set(tr.x, tr.waterY, tr.z), _q.identity(), _s.set(tr.s, 1, tr.s));
  }
  _propMatrix(p, scale, lift) {
    _q.setFromAxisAngle(UP, p.yaw);
    return _m.compose(_p.set(p.x, p.y + lift, p.z), _q, _s.set(scale, scale, scale));
  }

  // ------------------------------------------------------------ clouds at the frontier

  _updateFrontier(fresh, animate) {
    const add = new Set();
    for (const t of fresh) {
      const key = hexKey(t.q, t.r);
      const cl = this.clouds.get(key);
      if (cl && !cl.dying) { cl.dying = this.time; cl.born = null; this.cloudAnim.add(cl); }
      for (const n of hexNeighbors(t.q, t.r)) {
        const nk = hexKey(n.q, n.r);
        if (!this.tiles.has(nk) && !this.clouds.has(nk)) add.add(nk);
      }
    }
    for (const nk of add) {
      const [q, r] = nk.split(',').map(Number);
      const w = hexToWorld(q, r);
      const rnd = mulberry32(hashString(nk) ^ 0x5bd1);
      let e = 0;
      if (this.world && typeof this.world.terrainAt === 'function') {
        try { const t = this.world.terrainAt(q, r); e = t && Number.isFinite(t.elevation) ? t.elevation : 0; } catch { e = 0; }
      }
      const cl = {
        key: nk,
        x: w.x + (rnd() - 0.5) * 0.5,
        y: Math.max(0, e) * 0.55 + 0.05 + rnd() * 0.35,
        z: w.z + (rnd() - 0.5) * 0.5,
        s: 0.95 + rnd() * 0.55,
        yaw: rnd() * Math.PI * 2,
        born: animate ? this.time + 0.25 : null,
        dying: null,
        id: -1,
      };
      cl.id = this.cloudPool.add(this._cloudMatrix(cl, animate ? 0.0001 : 1));
      this.clouds.set(nk, cl);
      if (animate) this.cloudAnim.add(cl);
    }
  }

  _cloudMatrix(cl, k) {
    _q.setFromAxisAngle(UP, cl.yaw);
    const s = cl.s * Math.max(0.0001, k);
    return _m.compose(_p.set(cl.x, cl.y + (1 - k) * 0.3, cl.z), _q, _s.set(s, s * 0.9, s));
  }

  // ------------------------------------------------------------ clearing props for track / stations

  _cell(x, z) { return `${Math.floor(x)},${Math.floor(z)}`; }

  _blocked(x, z, pr) {
    const cx = Math.floor(x), cz = Math.floor(z);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.blocks.get(`${cx + i},${cz + j}`);
        if (!list) continue;
        for (const b of list) if (Math.hypot(b.x - x, b.z - z) < b.r + pr) return true;
      }
    }
    return false;
  }

  /** Block circles (track centreline points, station footprints): removes props there now and later. */
  block(circles) {
    if (!circles || !circles.length) return;
    const touched = new Set();
    for (const c of circles) {
      const k = this._cell(c.x, c.z);
      let list = this.blocks.get(k);
      if (!list) { list = []; this.blocks.set(k, list); }
      list.push(c);
      const h = worldToHex(c.x, c.z);
      touched.add(hexKey(h.q, h.r));
      for (const n of hexNeighbors(h.q, h.r)) touched.add(hexKey(n.q, n.r));
    }
    for (const key of touched) {
      const rec = this.tiles.get(key);
      if (!rec || !rec.props.length) continue;
      rec.props = rec.props.filter((p) => {
        if (!this._blocked(p.x, p.z, 0.07)) return true;
        this.propPools[p.type].remove(p.id);
        return false;
      });
    }
    this._flush();
  }

  // ------------------------------------------------------------ per frame

  update(dt) {
    this.time += dt;
    if (this.animating.size) {
      for (const rec of this.animating) {
        const t = this.time - rec.start - rec.delay;
        const p = clamp01(t / REVEAL.tileDur);
        const tr = tileTransforms(rec.tile, p);
        this.capPool.set(rec.cap, this._capMatrix(tr));
        this.wallPool.set(rec.wall, this._wallMatrix(tr));
        if (rec.water) this.waterPool.set(rec.water, this._waterMatrix(tr));
        const pp = clamp01((t - REVEAL.propDelay) / REVEAL.propDur);
        for (const pr of rec.props) {
          // stagger props inside a tile a little
          const k = easeOutBack(clamp01(pp * 1.15 - (pr.tint - 0.88) * 0.5));
          this.propPools[pr.type].set(pr.id, this._propMatrix(pr, Math.max(0.0001, pr.scale * k), tr.lift));
        }
        if (p >= 1 && pp >= 1) {
          for (const pr of rec.props) this.propPools[pr.type].set(pr.id, this._propMatrix(pr, pr.scale, 0));
          this.animating.delete(rec);
        }
      }
    }
    if (this.cloudAnim.size) {
      for (const cl of this.cloudAnim) {
        if (cl.dying != null) {
          const k = 1 - clamp01((this.time - cl.dying) / 0.45);
          if (k <= 0) {
            this.cloudPool.remove(cl.id);
            if (this.clouds.get(cl.key) === cl) this.clouds.delete(cl.key);
            this.cloudAnim.delete(cl);
          } else {
            this.cloudPool.set(cl.id, this._cloudMatrix(cl, k * (1 + (1 - k) * 0.4)));
          }
        } else if (cl.born != null) {
          const k = clamp01((this.time - cl.born) / 0.6);
          this.cloudPool.set(cl.id, this._cloudMatrix(cl, 1 - Math.pow(1 - k, 3)));
          if (k >= 1) { cl.born = null; this.cloudAnim.delete(cl); }
        } else this.cloudAnim.delete(cl);
      }
    }
    this._flush();
  }

  _flush() {
    this.capPool.flush(); this.wallPool.flush(); this.waterPool.flush(); this.cloudPool.flush();
    for (const t in this.propPools) this.propPools[t].flush();
  }

  /** Level of detail: drop small ground clutter when the camera is far out. */
  setDetail(cameraDistance) {
    const show = cameraDistance < 34;
    for (const t of SMALL_PROPS) for (const ch of this.propPools[t].chunks) ch.mesh.visible = show;
  }

  /** Counts for tests/diagnostics. */
  stats() {
    let props = 0;
    for (const t in this.propPools) props += this.propPools[t].live;
    return { tiles: this.tiles.size, water: this.waterPool.live, props, clouds: this.cloudPool.live, animating: this.animating.size };
  }

  dispose() {
    for (const p of [this.capPool, this.wallPool, this.waterPool, this.cloudPool, ...Object.values(this.propPools)]) p.dispose();
    for (const g of Object.values(this.geoms)) g.dispose();
    for (const g of Object.values(this.propGeoms)) g.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

