// Shared hex-grid and determinism helpers. Pointy-top axial coordinates (q, r).
import { HEX_SIZE } from './config.js';

const SQRT3 = Math.sqrt(3);

export const HEX_DIRS = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];

export const hexKey = (q, r) => `${q},${r}`;
export const parseHexKey = (key) => {
  const [q, r] = key.split(',').map(Number);
  return { q, r };
};

/** Centre of a hex on the ground plane. World y is elevation and is not set here. */
export function hexToWorld(q, r) {
  return { x: HEX_SIZE * SQRT3 * (q + r / 2), z: HEX_SIZE * 1.5 * r };
}

/** Nearest hex to a world-space point on the ground plane. */
export function worldToHex(x, z) {
  const r = z / (HEX_SIZE * 1.5);
  const q = x / (HEX_SIZE * SQRT3) - r / 2;
  return hexRound(q, r);
}

export function hexRound(fq, fr) {
  const fs = -fq - fr;
  let q = Math.round(fq), r = Math.round(fr), s = Math.round(fs);
  const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: q + 0, r: r + 0 }; // + 0 normalises -0
}

export function hexDistance(a, b) {
  const dq = a.q - b.q, dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function hexNeighbors(q, r) {
  return HEX_DIRS.map((d) => ({ q: q + d.q, r: r + d.r }));
}

/** All hexes exactly `radius` steps from the centre. */
export function hexRing(q, r, radius) {
  if (radius === 0) return [{ q, r }];
  const out = [];
  let cq = q + HEX_DIRS[4].q * radius, cr = r + HEX_DIRS[4].r * radius;
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      out.push({ q: cq, r: cr });
      cq += HEX_DIRS[side].q;
      cr += HEX_DIRS[side].r;
    }
  }
  return out;
}

/** All hexes within `radius` steps of the centre, centre first. */
export function hexSpiral(q, r, radius) {
  const out = [];
  for (let k = 0; k <= radius; k++) out.push(...hexRing(q, r, k));
  return out;
}

/** Deterministic 32-bit hash of a string (FNV-1a). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded pseudo-random generator returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
