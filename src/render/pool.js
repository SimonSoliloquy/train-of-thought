// Growable pool of instances over InstancedMesh chunks. One draw call per chunk,
// ids are stable for the lifetime of an instance, removed slots are reused.
import * as THREE from 'three';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const WHITE = new THREE.Color(1, 1, 1);

export class InstancePool {
  constructor(parent, geometry, material, opts = {}) {
    this.parent = parent;
    this.geometry = geometry;
    this.material = material;
    this.chunkSize = opts.chunk || 1024;
    this.castShadow = opts.castShadow !== false;
    this.receiveShadow = opts.receiveShadow !== false;
    this.renderOrder = opts.renderOrder || 0;
    this.name = opts.name || 'pool';
    this.cull = !!opts.cull; // per-chunk frustum culling with padded instance bounds
    this.chunks = [];
    this.free = [];
    this.next = 0;
    this.live = 0;
  }

  _chunk(i) {
    while (this.chunks.length <= i) {
      const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.chunkSize);
      mesh.name = `${this.name}#${this.chunks.length}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.chunkSize * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = this.cull;
      if (this.cull) mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
      mesh.castShadow = this.castShadow;
      mesh.receiveShadow = this.receiveShadow;
      mesh.renderOrder = this.renderOrder;
      if (this.parent) this.parent.add(mesh);
      this.chunks.push({ mesh, used: 0, dirtyM: false, dirtyC: false, dirtyB: false });
    }
    return this.chunks[i];
  }

  add(matrix, color = WHITE) {
    const id = this.free.length ? this.free.pop() : this.next++;
    const ci = Math.floor(id / this.chunkSize), li = id % this.chunkSize;
    const ch = this._chunk(ci);
    ch.mesh.setMatrixAt(li, matrix);
    ch.mesh.setColorAt(li, color);
    if (li + 1 > ch.mesh.count) ch.mesh.count = li + 1;
    ch.dirtyM = ch.dirtyC = true;
    ch.dirtyB = true;
    this.live++;
    return id;
  }

  set(id, matrix) {
    const ch = this.chunks[Math.floor(id / this.chunkSize)];
    if (!ch) return;
    ch.mesh.setMatrixAt(id % this.chunkSize, matrix);
    ch.dirtyM = true;
  }

  setColor(id, color) {
    const ch = this.chunks[Math.floor(id / this.chunkSize)];
    if (!ch) return;
    ch.mesh.setColorAt(id % this.chunkSize, color);
    ch.dirtyC = true;
  }

  remove(id) {
    if (id == null || id < 0) return;
    this.set(id, ZERO);
    this.free.push(id);
    this.live--;
  }

  /** Bounding sphere of a chunk's live instances, padded for reveal animations. */
  _bounds(ch) {
    const arr = ch.mesh.instanceMatrix.array;
    const gs = this.geometry.boundingSphere || (this.geometry.computeBoundingSphere(), this.geometry.boundingSphere);
    const gr = gs ? gs.center.length() + gs.radius : 1;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, maxS = 0;
    for (let i = 0; i < ch.mesh.count; i++) {
      const o = i * 16;
      const sx = Math.hypot(arr[o], arr[o + 1], arr[o + 2]), sy = Math.hypot(arr[o + 4], arr[o + 5], arr[o + 6]), sz = Math.hypot(arr[o + 8], arr[o + 9], arr[o + 10]);
      const sm = Math.max(sx, sy, sz);
      if (sm === 0) continue; // removed slot
      const x = arr[o + 12], y = arr[o + 13], z = arr[o + 14];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      if (sm > maxS) maxS = sm;
    }
    const sp = ch.mesh.boundingSphere || (ch.mesh.boundingSphere = new THREE.Sphere());
    if (minX === Infinity) { sp.center.set(0, -1000, 0); sp.radius = 0; return; }
    sp.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    sp.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + gr * Math.max(1, maxS) + 2;
  }

  /** Upload changed buffers. Call once per frame. */
  flush() {
    for (const ch of this.chunks) {
      if (this.cull && ch.dirtyB) { this._bounds(ch); ch.dirtyB = false; }
      if (ch.dirtyM) { ch.mesh.instanceMatrix.needsUpdate = true; ch.dirtyM = false; }
      if (ch.dirtyC && ch.mesh.instanceColor) { ch.mesh.instanceColor.needsUpdate = true; ch.dirtyC = false; }
    }
  }

  clear() {
    for (const ch of this.chunks) ch.mesh.count = 0;
    this.free.length = 0;
    this.next = 0;
    this.live = 0;
  }

  dispose() {
    for (const ch of this.chunks) {
      if (ch.mesh.parent) ch.mesh.parent.remove(ch.mesh);
      ch.mesh.dispose();
    }
    this.chunks = [];
  }
}

/**
 * Instances bucketed by ground region so each region's chunk can be frustum culled.
 * Handles ({pool, id}) replace numeric ids.
 */
export class SpatialPool {
  constructor(parent, geometry, material, opts = {}) {
    this.parent = parent;
    this.geometry = geometry;
    this.material = material;
    this.opts = { ...opts, cull: true, chunk: opts.chunk || 256 };
    this.cell = opts.cell || 24;
    this.name = opts.name || 'spatial';
    this.regions = new Map();
    this.live = 0;
  }

  _pool(x, z) {
    const key = `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
    let p = this.regions.get(key);
    if (!p) {
      p = new InstancePool(this.parent, this.geometry, this.material, { ...this.opts, name: `${this.name}@${key}` });
      this.regions.set(key, p);
    }
    return p;
  }

  add(matrix, color, x, z) {
    const pool = this._pool(x, z);
    const id = pool.add(matrix, color);
    this.live++;
    return { pool, id };
  }

  set(h, matrix) { if (h) h.pool.set(h.id, matrix); }
  setColor(h, color) { if (h) h.pool.setColor(h.id, color); }
  remove(h) {
    if (!h) return;
    h.pool.remove(h.id);
    this.live--;
  }

  get chunks() {
    const out = [];
    for (const p of this.regions.values()) out.push(...p.chunks);
    return out;
  }

  flush() { for (const p of this.regions.values()) p.flush(); }

  dispose() {
    for (const p of this.regions.values()) p.dispose();
    this.regions.clear();
  }
}
