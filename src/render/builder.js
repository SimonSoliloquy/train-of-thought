// Tiny flat-shaded mesh builder. Everything low-poly in the view (props, stations,
// track, trains) is assembled from triangles here: non-indexed, one normal per
// face, one colour per face (linear RGB). Pure apart from three's math classes,
// so it runs in Node for the smoke tests.
import * as THREE from 'three';

const colorCache = new Map();

/** sRGB hex string / number / [r,g,b] (already linear) -> linear [r,g,b]. */
export function rgb(c) {
  if (Array.isArray(c)) return c;
  if (c && c.isColor) return [c.r, c.g, c.b];
  let v = colorCache.get(c);
  if (!v) {
    const col = new THREE.Color(c);
    v = [col.r, col.g, col.b];
    colorCache.set(c, v);
  }
  return v;
}

/** Multiply a linear colour by k (clamped to [0,1]). */
export function shade(c, k) {
  const [r, g, b] = rgb(c);
  return [Math.min(1, r * k), Math.min(1, g * k), Math.min(1, b * k)];
}

/** Linear mix of two colours. */
export function mix(a, b, t) {
  const A = rgb(a), B = rgb(b);
  return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
}

const _v = new THREE.Vector3();

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.col = [];
    this._stack = [];
    this._xf = null; // THREE.Matrix4 or null
  }

  get vertexCount() { return this.pos.length / 3; }

  /** Run fn with an extra transform (translation, yaw, scale) applied to its vertices. */
  with(x, y, z, yaw, sx, fn, sy = sx, sz = sx) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw || 0),
      new THREE.Vector3(sx, sy, sz),
    );
    return this.withMatrix(m, fn);
  }

  withMatrix(m, fn) {
    this._stack.push(this._xf);
    this._xf = this._xf ? new THREE.Matrix4().multiplyMatrices(this._xf, m) : m.clone();
    try { fn(this); } finally { this._xf = this._stack.pop(); }
    return this;
  }

  _p(p) {
    if (!this._xf) return p;
    _v.set(p[0], p[1], p[2]).applyMatrix4(this._xf);
    return [_v.x, _v.y, _v.z];
  }

  tri(a, b, c, color) {
    a = this._p(a); b = this._p(b); c = this._p(c);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) { nx = 0; ny = 1; nz = 0; } else { nx /= len; ny /= len; nz /= len; }
    const [r, g, bl] = rgb(color);
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(r, g, bl, r, g, bl, r, g, bl);
  }

  /** a,b,c,d counter-clockwise seen from the front. */
  quad(a, b, c, d, color) {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }

  /**
   * Axis-aligned box centred at (cx, cy, cz) with full sizes, optional yaw.
   * faces: bitmask to skip faces (1 bottom).
   */
  box(cx, cy, cz, sx, sy, sz, color, yaw = 0, opts = {}) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const top = opts.top || color, side = opts.side || color;
    const fn = (b) => {
      const p = (x, y, z) => [x, y, z];
      const A = p(-hx, -hy, -hz), B = p(hx, -hy, -hz), C = p(hx, -hy, hz), D = p(-hx, -hy, hz);
      const E = p(-hx, hy, -hz), F = p(hx, hy, -hz), G = p(hx, hy, hz), H = p(-hx, hy, hz);
      b.quad(E, H, G, F, top);            // top (+y)
      if (!opts.noBottom) b.quad(A, B, C, D, shade(side, 0.6)); // bottom
      b.quad(D, C, G, H, side);           // +z
      b.quad(B, A, E, F, side);           // -z
      b.quad(C, B, F, G, shade(side, 0.92)); // +x
      b.quad(A, D, H, E, shade(side, 0.92)); // -x
    };
    return this.with(cx, cy, cz, yaw, 1, fn);
  }

  /**
   * Low-poly frustum / cylinder / cone along +y from y0 to y0+h.
   * rTop 0 gives a cone. phase rotates the polygon.
   */
  prism(cx, y0, cz, rBottom, rTop, h, sides, color, opts = {}) {
    const top = opts.top || color;
    const phase = opts.phase || 0;
    const ring = (r, y) => {
      const out = [];
      for (let i = 0; i < sides; i++) {
        const a = phase + (i / sides) * Math.PI * 2;
        out.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
      }
      return out;
    };
    const lo = ring(rBottom, y0), hi = ring(rTop, y0 + h);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const k = opts.sideShade ? opts.sideShade(i) : 1;
      const c = k === 1 ? color : shade(color, k);
      if (rTop > 1e-6) this.quad(lo[j], lo[i], hi[i], hi[j], c);
      else this.tri(lo[j], lo[i], hi[i], c);
    }
    if (rTop > 1e-6 && opts.capTop !== false) {
      const cTop = [cx, y0 + h, cz];
      for (let i = 0; i < sides; i++) this.tri(cTop, hi[(i + 1) % sides], hi[i], top);
    }
    if (opts.capBottom) {
      const cB = [cx, y0, cz];
      for (let i = 0; i < sides; i++) this.tri(cB, lo[i], lo[(i + 1) % sides], shade(color, 0.6));
    }
    return this;
  }

  /** Jittered icosahedron blob, radii rx, ry, rz. rnd: () => [0,1). */
  blob(cx, cy, cz, rx, ry, rz, color, rnd = null, jitter = 0.18, colorVar = 0.08) {
    const t = (1 + Math.sqrt(5)) / 2;
    const v = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ].map((p) => {
      const l = Math.hypot(p[0], p[1], p[2]);
      const j = rnd ? 1 + (rnd() - 0.5) * 2 * jitter : 1;
      return [cx + (p[0] / l) * rx * j, cy + (p[1] / l) * ry * j, cz + (p[2] / l) * rz * j];
    });
    const f = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    for (const [a, b, c] of f) {
      const k = rnd ? 1 + (rnd() - 0.5) * 2 * colorVar : 1;
      this.tri(v[a], v[b], v[c], k === 1 ? color : shade(color, k));
    }
    return this;
  }

  /** Append another builder's triangles (already in world/local space of this one). */
  append(other) {
    for (let i = 0; i < other.pos.length; i += 9) {
      this.tri(
        [other.pos[i], other.pos[i + 1], other.pos[i + 2]],
        [other.pos[i + 3], other.pos[i + 4], other.pos[i + 5]],
        [other.pos[i + 6], other.pos[i + 7], other.pos[i + 8]],
        [other.col[i], other.col[i + 1], other.col[i + 2]],
      );
    }
    return this;
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.pos.length) {
      g.computeBoundingBox();
      g.computeBoundingSphere();
    }
    return g;
  }
}

/** Corners of a pointy-top hex of radius r (matching hex.js), counter-clockwise from +x-ish. */
export function hexCorners(r, cx = 0, cz = 0) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return out;
}

