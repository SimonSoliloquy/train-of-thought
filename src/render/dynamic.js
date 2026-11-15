// An InstancedMesh whose instances are rewritten every frame (bubbles, particles).
import * as THREE from 'three';

export class DynamicInstances {
  constructor(parent, geometry, material, capacity = 256, opts = {}) {
    this.parent = parent;
    this.geometry = geometry;
    this.material = material;
    this.opts = opts;
    this.capacity = 0;
    this.mesh = null;
    this.n = 0;
    this._grow(capacity);
  }

  _grow(cap) {
    const old = this.mesh;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = !!this.opts.castShadow;
    mesh.receiveShadow = !!this.opts.receiveShadow;
    mesh.renderOrder = this.opts.renderOrder || 0;
    mesh.count = 0;
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, Math.min(old.instanceMatrix.array.length, cap * 16)));
      mesh.instanceColor.array.set(old.instanceColor.array.subarray(0, Math.min(old.instanceColor.array.length, cap * 3)));
      if (old.parent) old.parent.remove(old);
      old.dispose();
    }
    if (this.parent) this.parent.add(mesh);
    this.mesh = mesh;
    this.capacity = cap;
  }

  begin() { this.n = 0; }

  push(matrix, color) {
    if (this.n >= this.capacity) this._grow(this.capacity * 2);
    this.mesh.setMatrixAt(this.n, matrix);
    if (color) this.mesh.setColorAt(this.n, color);
    this.n++;
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    if (this.mesh) {
      if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
      this.mesh.dispose();
    }
  }
}

/** Simple particle system: puffs (smoke) or sparkles. */
export class Particles {
  constructor(parent, geometry, material, opts = {}) {
    this.inst = new DynamicInstances(parent, geometry, material, opts.capacity || 256, opts);
    this.list = [];
    this.max = opts.max || 1500;
    this.kind = opts.kind || 'smoke';
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  emit(x, y, z, strength = 1, opts = {}) {
    if (this.list.length >= this.max) this.list.shift();
    const r = Math.random;
    this.list.push({
      x, y, z,
      vx: opts.vx ?? (r() - 0.5) * 0.12,
      vy: opts.vy ?? 0.35 + r() * 0.15,
      vz: opts.vz ?? (r() - 0.5) * 0.12,
      age: 0,
      life: opts.life ?? (0.9 + r() * 0.4) * (0.6 + 0.4 * strength),
      size: opts.size ?? 0.035 + 0.025 * strength,
      grow: opts.grow ?? 0.075,
      spin: r() * 6,
      color: opts.color || null,
      gravity: opts.gravity ?? 0,
      strength,
    });
  }

  burst(x, y, z, n, color, opts = {}) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (opts.speed ?? 0.9) * (0.5 + Math.random() * 0.7);
      this.emit(x, y, z, 1, {
        vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: (opts.up ?? 1.3) * (0.6 + Math.random() * 0.6),
        life: (opts.life ?? 0.9) * (0.7 + Math.random() * 0.6), size: opts.size ?? 0.045, grow: -0.02,
        color, gravity: opts.gravity ?? 2.2,
      });
    }
  }

  update(dt) {
    const inst = this.inst;
    inst.begin();
    const keep = [];
    for (const p of this.list) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (this.kind === 'smoke') { p.vx *= 1 - dt * 0.8; p.vz *= 1 - dt * 0.8; p.vy *= 1 - dt * 0.6; }
      const u = p.age / p.life;
      let s;
      if (this.kind === 'smoke') s = (p.size + p.grow * u) * Math.sin(Math.min(1, u * 1.15) * Math.PI) ** 0.6;
      else s = Math.max(0.0001, p.size * (1 - u * u));
      this._e.set(p.spin + u, p.spin * 0.7 + u * 2, 0);
      this._q.setFromEuler(this._e);
      this._m.compose(this._p.set(p.x, p.y, p.z), this._q, this._s.set(s, s, s));
      if (p.color) this._c.set(p.color);
      else { const g = this.kind === 'smoke' ? (p.strength < 0.6 ? 0.42 : 0.96 - u * 0.12) : 1; this._c.setRGB(g, g, g); }
      inst.push(this._m, this._c);
      keep.push(p);
    }
    this.list = keep;
    inst.end();
  }

  dispose() { this.inst.dispose(); }
}
