// Scenery: a pure function of (seed, q, r). Biomes come from smooth, domain-warped
// climate fields (temperature, moisture, ruggedness), so regions are large and their
// borders natural. Rivers are zero-contours of low-frequency noise fields, so they are
// continuous lines of hexes that wind across many tiles and across biome borders.
// Elevation is quantised to ELEV_STEP so rails can match station ground exactly.

import { WORLD } from '../config.js';
import { hexToWorld, HEX_DIRS } from '../hex.js';
import { perlin, fbm, ridged, smoothstep, clamp, lerp, hash2 } from './noise.js';

/** Elevation resolution and rail level resolution (world units). */
export const ELEV_STEP = 0.2;
export const MAX_LEVEL = Math.round(WORLD.maxElevation / ELEV_STEP);

/** Station siting limits. */
export const STATION_MAX_ELEVATION = WORLD.maxElevation * 0.8;
export const STATION_MAX_STEEPNESS = 0.8; // max height difference to any neighbour

const BIOME_GRASS = 'grassland', BIOME_FOREST = 'forest', BIOME_JUNGLE = 'jungle',
  BIOME_DESERT = 'desert', BIOME_MOUNTAINS = 'mountains', BIOME_RIVER = 'riverlands',
  BIOME_CANYON = 'canyon';

/** Numeric key for small coordinates (fast Map lookups), string key beyond. */
export function tileKey(q, r) {
  if (q > -32768 && q < 32768 && r > -32768 && r < 32768) return (q + 32768) * 65536 + (r + 32768);
  return `${q},${r}`;
}

export function createTerrain(seedInt) {
  const S = seedInt | 0;
  const tileCache = new Map();
  const fieldCache = new Map();
  const steepCache = new Map();

  // ---- climate fields (domain warped, large scale) --------------------------------
  function climate(x, z) {
    const wx = x + 14 * fbm(x / 47, z / 47, S + 11, 2);
    const wz = z + 14 * fbm(x / 47 + 31.7, z / 47 - 12.1, S + 12, 2);
    const T = 0.5 + 1.9 * fbm(wx / 70, wz / 70, S + 13, 3);
    const M = 0.5 + 1.9 * fbm(wx / 56, wz / 56, S + 14, 3);
    let R = 0.5 + 1.9 * fbm(wx / 50, wz / 50, S + 15, 3);
    return { T, M, R };
  }

  // Origin guarantee: 1 at (0, 0), 0 beyond ~12 world units (about 7 hexes).
  function originBias(x, z) {
    return 1 - smoothstep(9, 21, Math.hypot(x, z));
  }

  // ---- river fields: water where the field changes sign between neighbours ------------
  // Raw (unshifted) contour fields, cached per hex because each tile reads its neighbours.
  function riverFields(q, r) {
    const k = tileKey(q, r);
    let f = fieldCache.get(k);
    if (f) return f;
    const { x, z } = hexToWorld(q, r);
    const o = originBias(x, z) * 0.6;
    const wx = x + 6 * perlin(x / 23, z / 23, S + 21);
    const wz = z + 6 * perlin(x / 23 + 7.3, z / 23 + 2.9, S + 22);
    const major = fbm(wx / 46, wz / 46, S + 23, 3) + o;
    const minor = fbm(wx / 22 + 40, wz / 22 - 40, S + 24, 2) + o;
    f = { major, minor };
    fieldCache.set(k, f);
    return f;
  }

  // Returns {water, dist} for one contour field: dist is the estimated distance in hexes to the contour.
  function contour(q, r, name) {
    const v = riverFields(q, r)[name];
    let grad = 1e-6, cross = false;
    for (let i = 0; i < 6; i++) {
      const n = riverFields(q + HEX_DIRS[i].q, r + HEX_DIRS[i].r)[name];
      const d = Math.abs(v - n);
      if (d > grad) grad = d;
      if (v > 0 && n <= 0) cross = true;
    }
    return { water: cross, dist: cross ? 0 : Math.abs(v) / grad };
  }

  // ---- biome elevation shapes ----------------------------------------------------
  function elevGrass(x, z) { return 0.6 + 1.1 * (0.5 + fbm(x / 11, z / 11, S + 31, 3)); }
  function elevForest(x, z) { return 0.7 + 1.5 * (0.5 + fbm(x / 9, z / 9, S + 32, 3)); }
  function elevJungle(x, z) { return 0.5 + 1.3 * (0.5 + fbm(x / 8, z / 8, S + 33, 3)); }
  function elevRiver(x, z) { return 0.25 + 0.5 * (0.5 + fbm(x / 12, z / 12, S + 34, 2)); }
  function elevDesert(x, z) {
    // long dunes: stretched ridges plus gentle swell
    const d = ridged((x * 0.8 + z * 0.6) / 3.2, (-x * 0.6 + z * 0.8) / 9, S + 35, 2);
    return 0.5 + 0.7 * d + 0.5 * (0.5 + fbm(x / 14, z / 14, S + 36, 2));
  }
  function elevMountains(x, z) {
    const rn = ridged(x / 9, z / 9, S + 37, 4);
    return 1.3 + 3.0 * Math.pow(rn, 1.4);
  }
  function elevCanyon(x, z) {
    const b = 0.5 + 1.8 * fbm(x / 10, z / 10, S + 38, 3);
    let e = 0.9 + 1.0 * smoothstep(0.32, 0.38, b) + 1.1 * smoothstep(0.6, 0.66, b);
    // gorges: narrow trenches along zero lines of another field
    const g = Math.abs(fbm(x / 17, z / 17, S + 39, 2));
    const gorge = 1 - smoothstep(0.015, 0.05, g);
    return lerp(e, 0.35, gorge);
  }

  function computeTile(q, r) {
    const { x, z } = hexToWorld(q, r);
    const o = originBias(x, z);
    let { T, M, R } = climate(x, z);
    R -= 0.6 * o; // gentle around the start

    const pR = smoothstep(0.68, 0.78, R);
    const pD = smoothstep(0.18, 0.3, T - M);
    const pW = smoothstep(0.6, 0.7, M);
    const pF = smoothstep(0.46, 0.56, M);
    const pH = smoothstep(0.5, 0.6, T);

    const wCanyon = pR * pD, wMount = pR * (1 - pD);
    const rest = 1 - pR;
    const wDesert = rest * pD;
    const rest2 = rest * (1 - pD);
    const wJungle = rest2 * pW * pH, wRiver = rest2 * pW * (1 - pH);
    const rest3 = rest2 * (1 - pW);
    // hot + moist reads as jungle too
    const wForest = rest3 * pF * (1 - pH * 0.6), wJungle2 = rest3 * pF * pH * 0.6;
    const wGrass = rest3 * (1 - pF);

    const weights = [
      [BIOME_GRASS, wGrass, elevGrass],
      [BIOME_FOREST, wForest, elevForest],
      [BIOME_JUNGLE, wJungle + wJungle2, elevJungle],
      [BIOME_DESERT, wDesert, elevDesert],
      [BIOME_MOUNTAINS, wMount, elevMountains],
      [BIOME_RIVER, wRiver, elevRiver],
      [BIOME_CANYON, wCanyon, elevCanyon],
    ];
    let biome = BIOME_GRASS, best = -1, e = 0, wsum = 0;
    for (const [b, w, f] of weights) {
      if (w > best) { best = w; biome = b; }
      if (w > 0.002) { e += w * f(x, z); wsum += w; }
    }
    e /= wsum || 1;

    // ---- rivers and valleys ----
    // major rivers everywhere except deep desert; minor rivers only in wet country
    const gateMajor = 1 - smoothstep(0.4, 0.5, T - M);
    const gateMinor = smoothstep(0.62, 0.7, M) * (1 - pR * 0.7);
    let water = false, valley = 0;
    if (gateMajor > 0.02) {
      const c = contour(q, r, 'major');
      if (c.water && gateMajor > 0.5) water = true;
      valley = Math.max(valley, gateMajor * (1 - smoothstep(0.6, 4.5, c.dist)));
    }
    if (gateMinor > 0.02) {
      const c = contour(q, r, 'minor');
      if (c.water && gateMinor > 0.5) water = true;
      valley = Math.max(valley, gateMinor * 0.8 * (1 - smoothstep(0.5, 2.5, c.dist)));
    }
    const bed = clamp(0.2 + 0.22 * e, 0.2, 1.0);
    e = lerp(e, bed + 0.2, valley * 0.8);

    // ---- lakes ----
    const lk = 0.5 + 1.6 * fbm(x / 15 + 101, z / 15 - 77, S + 41, 2);
    const tLake = 0.95 - 0.08 * pW + 0.4 * pR + 0.35 * pD;
    const lakeShore = smoothstep(tLake - 0.12, tLake, lk);
    const lakeLevel = 0.25 + 0.25 * (0.5 + fbm(x / 40, z / 40, S + 42, 1));
    if (lakeShore > 0) e = lerp(e, lakeLevel + 0.2, lakeShore * 0.85);
    if (lk > tLake) water = true;

    // ---- origin guarantee: dry and gentle ----
    if (o > 0) {
      e = lerp(e, 0.8 + 0.25 * (e - 0.8), o);
      if (o > 0.05) water = false;
      if (o > 0.4 && (biome === BIOME_MOUNTAINS || biome === BIOME_CANYON)) biome = BIOME_GRASS;
    }

    if (water) e = Math.min(e, lk > tLake ? lakeLevel : bed);

    let level = Math.round(clamp(e, 0, WORLD.maxElevation) / ELEV_STEP);
    if (level < 1) level = 1;
    return Object.freeze({
      q, r, biome,
      elevation: Math.round(level * ELEV_STEP * 1000) / 1000,
      water,
      detail: hash2(q, r, S + 97),
    });
  }

  /** @returns {import('../types.js').Tile} */
  function terrainAt(q, r) {
    const k = tileKey(q, r);
    let t = tileCache.get(k);
    if (!t) {
      t = computeTile(q, r);
      tileCache.set(k, t);
    }
    return t;
  }

  /** Integer elevation level of a hex. */
  function levelAt(q, r) {
    return Math.round(terrainAt(q, r).elevation / ELEV_STEP);
  }

  /** Largest height difference (world units) between a hex and any neighbour. */
  function steepness(q, r) {
    const k = tileKey(q, r);
    let s = steepCache.get(k);
    if (s !== undefined) return s;
    const e = terrainAt(q, r).elevation;
    s = 0;
    for (let i = 0; i < 6; i++) {
      const d = Math.abs(e - terrainAt(q + HEX_DIRS[i].q, r + HEX_DIRS[i].r).elevation);
      if (d > s) s = d;
    }
    s = Math.round(s * 1000) / 1000;
    steepCache.set(k, s);
    return s;
  }

  /** Can a station stand here? Dry, not too high, not a cliff. */
  function isBuildable(q, r) {
    const t = terrainAt(q, r);
    if (t.water) return false;
    if (t.elevation > STATION_MAX_ELEVATION) return false;
    return steepness(q, r) <= STATION_MAX_STEEPNESS + 1e-9;
  }

  return { terrainAt, levelAt, steepness, isBuildable };
}
