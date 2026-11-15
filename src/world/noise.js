// Seeded 2D gradient noise and helpers. Pure, deterministic, no Math.random.

/** 32-bit integer hash of a lattice point and a seed -> unsigned int. */
export function hash2i(ix, iy, s) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of a lattice point -> [0, 1). */
export function hash2(ix, iy, s) {
  return hash2i(ix, iy, s) / 4294967296;
}

// 16 unit gradients.
const GX = new Float64Array(16), GY = new Float64Array(16);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2 + 0.1;
  GX[i] = Math.cos(a);
  GY[i] = Math.sin(a);
}

/** Perlin gradient noise, roughly in [-0.7, 0.7], mean 0. */
export function perlin(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const g00 = hash2i(ix, iy, s) & 15;
  const g10 = hash2i(ix + 1, iy, s) & 15;
  const g01 = hash2i(ix, iy + 1, s) & 15;
  const g11 = hash2i(ix + 1, iy + 1, s) & 15;
  const n00 = GX[g00] * fx + GY[g00] * fy;
  const n10 = GX[g10] * (fx - 1) + GY[g10] * fy;
  const n01 = GX[g01] * fx + GY[g01] * (fy - 1);
  const n11 = GX[g11] * (fx - 1) + GY[g11] * (fy - 1);
  const a = n00 + (n10 - n00) * ux;
  const b = n01 + (n11 - n01) * ux;
  return a + (b - a) * uy;
}

// Each octave is rotated to hide the lattice axes.
const ROT_C = Math.cos(0.83), ROT_S = Math.sin(0.83);

/** Fractal sum of perlin octaves, normalised by total amplitude; mean 0, roughly [-0.5, 0.5]. */
export function fbm(x, y, s, octaves) {
  let sum = 0, amp = 1, norm = 0, px = x, py = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * perlin(px, py, s + o * 1013);
    norm += amp;
    amp *= 0.5;
    const nx = (px * ROT_C - py * ROT_S) * 2.03 + 17.3;
    py = (px * ROT_S + py * ROT_C) * 2.03 + 5.1;
    px = nx;
  }
  return sum / norm;
}

/** Ridged fractal noise in [0, 1]: sharp crests where the underlying noise crosses zero. */
export function ridged(x, y, s, octaves) {
  let sum = 0, amp = 1, norm = 0, px = x, py = y, weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(perlin(px, py, s + o * 7919) * 1.6);
    if (n < 0) n = 0;
    n *= n;
    n *= weight;
    weight = Math.min(1, n * 1.5 + 0.2);
    sum += amp * n;
    norm += amp;
    amp *= 0.5;
    const nx = (px * ROT_C - py * ROT_S) * 2.07 + 3.7;
    py = (px * ROT_S + py * ROT_C) * 2.07 + 9.2;
    px = nx;
  }
  return sum / norm;
}

export function smoothstep(e0, e1, x) {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
