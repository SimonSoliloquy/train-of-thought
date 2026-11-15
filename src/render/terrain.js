// The landscape: one continuous faceted surface (see surface.js) drawn in chunks, a
// continuous animated water surface over the river beds, instanced props seated on the
// drawn surface, frontier clouds, and the "rise out of the mist" reveal.
import * as THREE from 'three';
import { MeshBuilder } from './builder.js';
import { layoutTileProps, buildPropGeometryBuilders, PROP_TYPES, SMALL_PROPS } from './props.js';
import { InstancePool, SpatialPool } from './pool.js';
import { Surface, buildChunkArrays, CHUNK, FLOOR_Y, REVEAL_DUR, TRACK_GRADE, PAD_GRADE } from './surface.js';
import { hexToWorld, hexKey, hexNeighbors, hashString, mulberry32 } from '../hex.js';

export { FLOOR_Y };
export const REVEAL = { propDelay: 0.3, propDur: 0.34, maxSpread: 0.5, perUnit: 0.05 };
const ROCKY = new Set(['boulder', 'rockPeak', 'snowPeak', 'spire', 'mesa']);

export function buildCloudGeometry() {
  const b = new MeshBuilder();
  const rnd = mulberry32(77);
  b.blob(0, 0.1, 0, 0.75, 0.26, 0.65, [1, 1, 1], rnd, 0.08, 0);
  b.blob(0.45, 0.05, 0.2, 0.5, 0.2, 0.45, [1, 1, 1], rnd, 0.08, 0);
  b.blob(-0.4, 0.02, -0.25, 0.55, 0.18, 0.45, [1, 1, 1], rnd, 0.08, 0);
  b.blob(0.1, 0.24, -0.1, 0.4, 0.2, 0.38, [1, 1, 1], rnd, 0.08, 0);
  return b;
}

export function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Width of the graded slope beside a track bed or pad that sits `rise` above or below the land. Pure. */
export function gradeWidth(rise, base) {
  const r = Number.isFinite(rise) ? Math.abs(rise) : 0;
  return Math.min(1.9, Math.max(base, r * 0.75 + 0.2));
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function geometryFrom(pos, prev, born, colors, edge) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPrev', new THREE.Float32BufferAttribute(prev, 1));
  g.setAttribute('aBorn', new THREE.Float32BufferAttribute(born, 1));
  if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += 2.5; // vertices may still be rising from below
  return g;
}

export class Terrain {
  constructor({ parent, materials, world }) {
    this.world = world;
    this.materials = materials;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    parent.add(this.group);
    const terrainAt = (q, r) => (world && typeof world.terrainAt === 'function' ? world.terrainAt(q, r) : null);
    this.surface = new Surface(terrainAt);
    this.meshes = new Map(); // chunk key -> {land, water}
    this.geoms = { cloud: buildCloudGeometry().toGeometry() };
    this.cloudPool = new InstancePool(this.group, this.geoms.cloud, materials.cloud, { chunk: 1024, castShadow: false, receiveShadow: false, name: 'clouds', renderOrder: 3 });
    const pb = buildPropGeometryBuilders();
    this.propPools = {};
    this.propGeoms = {};
    for (const t of PROP_TYPES) {
      this.propGeoms[t] = pb[t].toGeometry();
      this.propPools[t] = new SpatialPool(this.group, this.propGeoms[t], materials.props, { chunk: 256, name: `prop-${t}`, castShadow: !SMALL_PROPS.has(t) });
    }
    this.tiles = new Map();      // hex key -> record {key, tile, x, z, props, start}
    this.clouds = new Map();
    this.animating = new Set();
    this.cloudAnim = new Set();
    this.blocks = new Map();
    this.bounds = { minX: -6, maxX: 6, minZ: -6, maxZ: 6, empty: true };
    this.time = 0;
    this.onChange = null; // (box) => void, after the drawn surface changed
  }

  get tileCount() { return this.tiles.size; }
  has(q, r) { return this.tiles.has(hexKey(q, r)); }

  /** Height of the land surface as drawn (river beds included). */
  groundAt(x, z) { return this.surface.groundAt(x, z); }
  /** Natural hill height, ignoring grading and the reveal (tunnel cover, portals). */
  naturalAt(x, z) { return this.surface.naturalAt(x, z); }
  /** Water surface at a point, or null. */
  waterAt(x, z) { return this.surface.waterAt(x, z); }

  // ------------------------------------------------------------ reveal

  reveal(tiles, { animate = false, origin = null } = {}) {
    if (!tiles || !tiles.length) return 0;
    const fresh = [];
    for (const t of tiles) {
      if (!t || !Number.isFinite(t.q) || !Number.isFinite(t.r)) continue;
      const key = hexKey(t.q, t.r);
      if (this.tiles.has(key) || fresh.some((f) => f.q === t.q && f.r === t.r)) continue;
      fresh.push(t);
    }
    if (!fresh.length) return 0;
    let ox = 0, oz = 0;
    for (const t of fresh) { const w = hexToWorld(t.q, t.r); ox += w.x; oz += w.z; }
    ox /= fresh.length; oz /= fresh.length;
    if (origin) { ox = origin.x; oz = origin.z; }
    let maxD = 0;
    const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const t of fresh) {
      this.surface.revealHex(t.q, t.r);
      const w = hexToWorld(t.q, t.r);
      maxD = Math.max(maxD, Math.hypot(w.x - ox, w.z - oz));
      box.minX = Math.min(box.minX, w.x); box.maxX = Math.max(box.maxX, w.x);
      box.minZ = Math.min(box.minZ, w.z); box.maxZ = Math.max(box.maxZ, w.z);
      const rec = { key: hexKey(t.q, t.r), tile: t, x: w.x, z: w.z, props: [], start: -1e9 };
      this.tiles.set(rec.key, rec);
      const b = this.bounds;
      if (b.empty) { b.minX = b.maxX = w.x; b.minZ = b.maxZ = w.z; b.empty = false; }
      else { b.minX = Math.min(b.minX, w.x); b.maxX = Math.max(b.maxX, w.x); b.minZ = Math.min(b.minZ, w.z); b.maxZ = Math.max(b.maxZ, w.z); }
    }
    const pad = 3.2;
    box.minX -= pad; box.maxX += pad; box.minZ -= pad; box.maxZ += pad;
    const perUnit = maxD > 0 ? Math.min(REVEAL.perUnit, REVEAL.maxSpread / maxD) : 0;
    const anim = animate ? { now: this.time, origin: { x: ox, z: oz }, perUnit } : null;
    this._refresh(box, anim, false);
    for (const t of fresh) this._addProps(this.tiles.get(hexKey(t.q, t.r)), animate);
    this._reseat(box, new Set(fresh.map((t) => hexKey(t.q, t.r))));
    this._updateFrontier(fresh, animate);
    this._flush();
    if (this.onChange) this.onChange(box);
    return fresh.length;
  }

  /** Recompute chunk heights inside box and rebuild the meshes that changed. */
  _refresh(box, anim, notify = true) {
    const S = this.surface;
    const changed = [];
    for (const [ci, cj] of S.chunksIn(box)) {
      const key = S.chunkKey(ci, cj);
      let c = S.chunks.get(key);
      const isNew = !c;
      if (isNew) { S.chunk(ci, cj); c = S.chunks.get(key); if (anim) c.computed = false; }
      if (S.recompute(c, anim) || isNew || !this.meshes.has(key)) changed.push(c);
    }
    const rebuild = new Set();
    for (const c of changed) {
      for (const [a, b] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) rebuild.add(S.chunkKey(c.ci + a, c.cj + b));
    }
    for (const key of rebuild) {
      const c = S.chunks.get(key);
      if (c) this._buildMesh(c);
    }
    if (notify && this.onChange) this.onChange(box);
  }

  _buildMesh(c) {
    const old = this.meshes.get(c.key);
    if (old) {
      for (const m of [old.land, old.water]) if (m) { this.group.remove(m); m.geometry.dispose(); }
      this.meshes.delete(c.key);
    }
    const a = buildChunkArrays(this.surface, c.ci, c.cj);
    const rec = { land: null, water: null };
    if (a.pos.length) {
      const land = new THREE.Mesh(geometryFrom(a.pos, a.prev, a.born, a.colors, a.edge), this.materials.terrain);
      land.castShadow = true;
      land.receiveShadow = true;
      land.name = `land ${c.key}`;
      this.group.add(land);
      rec.land = land;
    }
    if (a.wpos.length) {
      const water = new THREE.Mesh(geometryFrom(a.wpos, a.wprev, a.wborn, null, a.wedge), this.materials.water);
      water.receiveShadow = true;
      water.renderOrder = 2;
      water.name = `water ${c.key}`;
      this.group.add(water);
      rec.water = water;
    }
    this.meshes.set(c.key, rec);
  }

  // ------------------------------------------------------------ grading

  /** Grade the land under a committed track. segs: from gradeSegments() in track.js. */
  setTrackGrade(id, segs) {
    // deep cuttings and tall embankments get wider, gentler sides instead of sheer walls
    const feats = (segs || []).map((s) => ({ type: 'seg', ...s, inner: TRACK_GRADE.inner, outer: TRACK_GRADE.inner + gradeWidth(s.rise, TRACK_GRADE.outer - TRACK_GRADE.inner) }));
    this._setFeatures(`track:${id}`, feats);
  }

  /** A flat pad for a station building at height y. */
  setPad(id, x, z, y) {
    let rise = 0;
    if (Number.isFinite(y)) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const g = this.surface.naturalAt(x + Math.cos(a) * PAD_GRADE.inner, z + Math.sin(a) * PAD_GRADE.inner);
        if (Number.isFinite(g)) rise = Math.max(rise, Math.abs(g - y));
      }
    }
    const outer = PAD_GRADE.inner + gradeWidth(rise, PAD_GRADE.outer - PAD_GRADE.inner);
    this._setFeatures(`pad:${id}`, Number.isFinite(y) ? [{ type: 'pad', ax: x, az: z, ay: y, inner: PAD_GRADE.inner, outer }] : []);
  }

  _setFeatures(id, feats) {
    const box = this.surface.setFeatures(id, feats);
    if (!box) return;
    box.minX -= 1; box.maxX += 1; box.minZ -= 1; box.maxZ += 1;
    this._refresh(box, { now: this.time, origin: null, perUnit: 0 }, false);
    this._reseat(box, null);
    this._flush();
    if (this.onChange) this.onChange(box);
  }

  // ------------------------------------------------------------ props

  _addProps(rec, animate) {
    if (!rec) return;
    const tile = rec.tile;
    let nearWater = false;
    if (!tile.water && tile.biome === 'riverlands') nearWater = this._nearWater(tile);
    const props = layoutTileProps(tile, { nearWater });
    if (animate) {
      const v = this.surface.vertex(tile.q * 3, tile.r * 3);
      rec.start = Math.max(this.time, v.born) + REVEAL.propDelay;
      this.animating.add(rec);
    }
    for (const p of props) {
      if (this._blocked(p.x, p.z, 0.07)) continue;
      const pool = this.propPools[p.type];
      if (!pool) continue;
      this._seatProp(p);
      const scale = animate || p.hidden ? 0.0001 : p.scale;
      p.id = pool.add(this._propMatrix(p, scale), _c.setRGB(p.tint, p.tint, p.tint), rec.x, rec.z);
      rec.props.push(p);
    }
  }

  /** Put a prop on the drawn surface; hide it in water or on faces too steep for it. */
  _seatProp(p) {
    const S = this.surface;
    const y = S.groundAt(p.x, p.z);
    const e = 0.14;
    const gx = (S.groundAt(p.x + e, p.z) - S.groundAt(p.x - e, p.z)) / (2 * e);
    const gz = (S.groundAt(p.x, p.z + e) - S.groundAt(p.x, p.z - e)) / (2 * e);
    const grad = Math.hypot(gx, gz);
    const wet = S.waterAt(p.x, p.z) != null;
    p.y = y - 0.01;
    p.hidden = wet || grad > (ROCKY.has(p.type) ? 2.4 : 0.9) || y < 0;
  }

  _reseat(box, skip) {
    for (const rec of this.tiles.values()) {
      if (rec.x < box.minX - 1 || rec.x > box.maxX + 1 || rec.z < box.minZ - 1 || rec.z > box.maxZ + 1) continue;
      if (skip && skip.has(rec.key)) continue;
      for (const p of rec.props) {
        this._seatProp(p);
        if (!this.animating.has(rec)) this.propPools[p.type].set(p.id, this._propMatrix(p, p.hidden ? 0.0001 : p.scale));
      }
    }
  }

  _nearWater(tile) {
    for (const n of hexNeighbors(tile.q, tile.r)) {
      let t = null;
      try { t = this.world && this.world.terrainAt ? this.world.terrainAt(n.q, n.r) : null; } catch { t = null; }
      if (t && t.water) return true;
    }
    return false;
  }

  _propMatrix(p, scale) {
    _q.setFromAxisAngle(UP, p.yaw);
    return _m.compose(_p.set(p.x, p.y, p.z), _q, _s.set(scale, scale, scale));
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
      if (rnd() < 0.35) { this.clouds.set(nk, { key: nk, id: -1, skip: true }); continue; }
      const cl = {
        key: nk,
        x: w.x + (rnd() - 0.5) * 0.8,
        y: 0.1 + rnd() * 0.45,
        z: w.z + (rnd() - 0.5) * 0.8,
        s: 0.9 + rnd() * 0.6,
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
    return _m.compose(_p.set(cl.x, cl.y + (1 - k) * 0.3, cl.z), _q, _s.set(s, s * 0.8, s));
  }

  // ------------------------------------------------------------ clearing props for track / stations

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

  /** True when no track or station footprint covers (x, z) within r. */
  isClear(x, z, r = 0.35) { return !this._blocked(x, z, r); }

  block(circles) {
    if (!circles || !circles.length) return;
    let box = null;
    for (const c of circles) {
      const k = `${Math.floor(c.x)},${Math.floor(c.z)}`;
      let list = this.blocks.get(k);
      if (!list) { list = []; this.blocks.set(k, list); }
      list.push(c);
      if (!box) box = { minX: c.x, maxX: c.x, minZ: c.z, maxZ: c.z };
      else { box.minX = Math.min(box.minX, c.x); box.maxX = Math.max(box.maxX, c.x); box.minZ = Math.min(box.minZ, c.z); box.maxZ = Math.max(box.maxZ, c.z); }
    }
    for (const rec of this.tiles.values()) {
      if (!rec.props.length || rec.x < box.minX - 2 || rec.x > box.maxX + 2 || rec.z < box.minZ - 2 || rec.z > box.maxZ + 2) continue;
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
        const pp = clamp01((this.time - rec.start) / REVEAL.propDur);
        for (const pr of rec.props) {
          const k = pr.hidden ? 0.0001 : easeOutBack(clamp01(pp * 1.15 - (pr.tint - 0.88) * 0.5));
          this.propPools[pr.type].set(pr.id, this._propMatrix(pr, Math.max(0.0001, pr.scale * k)));
        }
        if (pp >= 1) {
          for (const pr of rec.props) this.propPools[pr.type].set(pr.id, this._propMatrix(pr, pr.hidden ? 0.0001 : pr.scale));
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
          } else this.cloudPool.set(cl.id, this._cloudMatrix(cl, k * (1 + (1 - k) * 0.4)));
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
    this.cloudPool.flush();
    for (const t in this.propPools) this.propPools[t].flush();
  }

  /** Level of detail: drop small ground clutter when the camera is far out. */
  setDetail(cameraDistance) {
    const show = cameraDistance < 34;
    for (const t of SMALL_PROPS) for (const ch of this.propPools[t].chunks) ch.mesh.visible = show;
  }

  /** Counts for tests/diagnostics. */
  stats() {
    let props = 0, hidden = 0, tris = 0, waterTris = 0, meshes = 0;
    for (const t in this.propPools) props += this.propPools[t].live;
    for (const rec of this.tiles.values()) for (const p of rec.props) if (p.hidden) hidden++;
    for (const m of this.meshes.values()) {
      if (m.land) { tris += m.land.geometry.attributes.position.count / 3; meshes++; }
      if (m.water) { waterTris += m.water.geometry.attributes.position.count / 3; meshes++; }
    }
    return { tiles: this.tiles.size, props, hiddenProps: hidden, landTris: tris, waterTris, meshes, clouds: this.cloudPool.live, animating: this.animating.size };
  }

  dispose() {
    for (const m of this.meshes.values()) for (const x of [m.land, m.water]) if (x) { this.group.remove(x); x.geometry.dispose(); }
    this.meshes.clear();
    for (const p of [this.cloudPool, ...Object.values(this.propPools)]) p.dispose();
    for (const g of Object.values(this.geoms)) g.dispose();
    for (const g of Object.values(this.propGeoms)) g.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

export { REVEAL_DUR, CHUNK };
