// Scenery: a pure function of (seed, q, r). Biomes come from smooth, domain-warped
// climate fields (temperature, moisture, ruggedness), so regions are large and their
// borders natural. Rivers are zero-contours of low-frequency noise fields, so they are
// continuous lines of hexes that wind across many tiles and across biome borders; ridges
// and ravines are zero-contours of their own fields, so they are long lines too. On top of
// the climate lowland sit rolling hills, plateau tiers and the old mountain ranges; rivers
// cut gorges where the land is high. The start sits in a basin ringed by a ridge rim.
// Elevation is quantised to ELEV_STEP so rails can match station ground exactly.

import { WORLD } from '../config.js';
import { hexToWorld, HEX_DIRS } from '../hex.js';
import { perlin, fbm, ridged, smoothstep, clamp, lerp, hash2 } from './noise.js';

/** Elevation resolution and rail level resolution (world units). */
export const ELEV_STEP = 0.2;
export const MAX_LEVEL = Math.round(WORLD.maxElevation / ELEV_STEP);

/**
 * Relief (world units unless noted). Built so that an ordinary 4 to 8 hex link crosses
 * dramatic land: rolling hills the rail climbs over, plateau tiers that put towns at clearly
 * different heights, long narrow ridges too steep to climb and too long to walk round (so the
 * rail tunnels), dry ravines and river gorges too steep to descend into (so it bridges).
 */
const RELIEF_BASE = 0.9;     // everything is lowered this much so tiers and ridges fit under maxElevation
const HILL_AMP = 3.5, HILL_SCALE = 13;           // rolling hills: about +-0.7 over 4 to 8 hexes
const TIER_SPAN = 2.6;       // plateau tiers per unit of the tier field (mostly treads 0, 1, 2)
const TIER_RISER = 0.3;      // share of a tier taken by its escarpment
const TIER_HEIGHT = 1.2;     // height of one tier: valley towns, plateau towns, hill towns
const RANGE_SCALE = 0.5;     // the old mountain ranges, lowered: ridges and tiers carry the relief now
const RIDGE_SCALE = 30;      // ridge-line field scale (lines roughly 10 to 15 hexes apart)
const RIDGE_INNER = 0.3, RIDGE_OUTER = 1.5; // crest profile, hexes from the line
const RIDGE_HEIGHT = 1.6;    // crest height above the flanks (x 0.75..1.25 by region)
const RIM_R = 5.6, RIM_VAR = 0.9; // start-basin rim: radius (world units) and its waver with the angle
const RIM_SLOPE = 0.03;      // rim field gradient per world unit (like the open-country line fields)
const RAVINE_SCALE = 30;
const RAVINE_INNER = 0.3, RAVINE_OUTER = 1.3;
const RAVINE_DEPTH = 1.1;
const GORGE_FROM = 1.1, GORGE_FULL = 2.0; // rivers cut narrow gorges in land this high
const RIVER_INCISE = 0.4;    // river banks stand this far above the valley floor: the water runs in a cut

/** Station siting limits: shelves and hill towns are fine, cliffs and summits are not. */
export const STATION_MAX_ELEVATION = WORLD.maxElevation * 0.9;
export const STATION_MAX_STEEPNESS = 1.2; // max height difference to any neighbour

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

  // Origin guarantee: 1 at (0, 0), 0 beyond ~3.5 world units (the start hex and its ring).
  function originBias(x, z) {
    return 1 - smoothstep(1.5, 3.5, Math.hypot(x, z));
  }
  // Rivers keep outside the start basin's rim: no contour (no river) inside ~4 hexes.
  function riverBias(x, z) {
    return 1 - smoothstep(4.0, 8.5, Math.hypot(x, z));
  }

  // ---- line fields: rivers, ridges and ravines are zero-contours of these ------------
  // Raw low-frequency fields, cached per hex because each tile reads its neighbours.
  function rawLines(x, z) {
    // ridge and ravine lines (their own warp so they cross the rivers instead of following them)
    const ux = x + 8 * perlin(x / 25 + 9.1, z / 25 + 3.3, S + 65);
    const uz = z + 8 * perlin(x / 25 - 5.5, z / 25 - 8.8, S + 66);
    return {
      ridge: fbm(ux / RIDGE_SCALE, uz / RIDGE_SCALE, S + 67, 1),
      ravine: fbm(ux / RAVINE_SCALE - 17.3, uz / RAVINE_SCALE + 29.9, S + 69, 2),
    };
  }
  // open-country ridges and ravines are pushed off the start (their lines bend round it)
  const atOrigin = rawLines(0, 0);
  const signR = atOrigin.ridge >= 0 ? 1 : -1, signV = atOrigin.ravine >= 0 ? 1 : -1;

  /**
   * The start basin: the start sits on a valley floor ringed by a hill rim RIM_R world units
   * out (wavering with the angle). Negative inside the rim, positive outside, so its zero
   * contour is one closed ridge line round the start; farther out the field is flat positive
   * (no line). Every first link crosses it: through it in a tunnel, or over the river gorge
   * where a river breaks through it.
   */
  function rimField(x, z) {
    const rho = Math.hypot(x, z);
    const c = rho > 1e-9 ? x / rho : 1, s = rho > 1e-9 ? z / rho : 0;
    const R = RIM_R + RIM_VAR * 2 * perlin(c * 1.4 + 3.7, s * 1.4 - 1.1, S + 81);
    const w = 1 - smoothstep(R + 3, R + 9, rho);
    return lerp(1, (rho - R) * RIM_SLOPE, w);
  }

  function lineFields(q, r) {
    const k = tileKey(q, r);
    let f = fieldCache.get(k);
    if (f) return f;
    const { x, z } = hexToWorld(q, r);
    const o = riverBias(x, z) * 0.5;
    const wx = x + 7 * perlin(x / 21, z / 21, S + 21);
    const wz = z + 7 * perlin(x / 21 + 7.3, z / 21 + 2.9, S + 22);
    const major = fbm(wx / 34, wz / 34, S + 23, 3) + o;
    const minor = fbm(wx / 21 + 40, wz / 21 - 40, S + 24, 2) + o;
    const raw = rawLines(x, z);
    const push = 0.3 * (1 - smoothstep(4, 12, Math.hypot(x, z)));
    f = {
      major, minor,
      ridge: raw.ridge + signR * push,
      rim: rimField(x, z),
      ravine: raw.ravine + signV * push,
    };
    fieldCache.set(k, f);
    return f;
  }

  // Returns {water, dist} for one contour field: dist is the estimated distance in hexes to the contour.
  function contour(q, r, name) {
    const v = lineFields(q, r)[name];
    let grad = 1e-6, cross = false;
    for (let i = 0; i < 6; i++) {
      const n = lineFields(q + HEX_DIRS[i].q, r + HEX_DIRS[i].r)[name];
      const d = Math.abs(v - n);
      if (d > grad) grad = d;
      if (v > 0 && n <= 0) cross = true;
    }
    return { water: cross, dist: cross ? 0 : Math.abs(v) / grad };
  }

  // ---- biome elevation shapes (the lowland each climate gives) ---------------------
  function elevGrass(x, z) { return 0.6 + 1.0 * (0.5 + fbm(x / 11, z / 11, S + 31, 3)); }
  function elevForest(x, z) { return 0.7 + 1.3 * (0.5 + fbm(x / 9, z / 9, S + 32, 3)); }
  function elevJungle(x, z) { return 0.5 + 1.2 * (0.5 + fbm(x / 8, z / 8, S + 33, 3)); }
  function elevRiver(x, z) { return 0.25 + 0.5 * (0.5 + fbm(x / 12, z / 12, S + 34, 2)); }
  function elevDesert(x, z) {
    // long dunes: stretched ridges plus gentle swell
    const d = ridged((x * 0.8 + z * 0.6) / 3.2, (-x * 0.6 + z * 0.8) / 9, S + 35, 2);
    return 0.5 + 0.35 * d + 0.5 * (0.5 + fbm(x / 14, z / 14, S + 36, 2));
  }
  function elevCanyon(x, z) {
    // red plateau country: stepped mesas cut by narrow gorges
    const b = 0.5 + 1.8 * fbm(x / 10, z / 10, S + 38, 3);
    const e = 0.9 + 1.0 * smoothstep(0.32, 0.38, b) + 1.1 * smoothstep(0.6, 0.66, b);
    const g = Math.abs(fbm(x / 17, z / 17, S + 39, 2));
    return lerp(e, 0.35, 1 - smoothstep(0.015, 0.05, g));
  }

  // ---- mountain ranges: long ridges along the zero lines of a warped field ----------
  // Returns {core, foot, height}: core 0..1 (the range itself), foot 0..1 (foothills),
  // height = extra elevation the range adds.
  function range(x, z, pR) {
    const wx = x + 10 * perlin(x / 31 - 3.1, z / 31 + 8.2, S + 51);
    const wz = z + 10 * perlin(x / 31 + 5.7, z / 31 - 1.9, S + 52);
    const a = Math.abs(fbm(wx / 36, wz / 36, S + 53, 3));
    const wCore = 0.08 + 0.06 * pR;                 // massifs where the ruggedness field is high
    const core = 1 - smoothstep(0, wCore, a);
    const foot = 1 - smoothstep(wCore, wCore + 0.12, a);
    // ranges are not everywhere: a broad field switches whole regions of them off
    const amp = 0.45 + 0.55 * smoothstep(-0.1, 0.12, fbm(x / 95 + 13, z / 95 - 7, S + 54, 2) + 0.08 + 0.25 * pR);
    const rn = ridged(x / 7, z / 7, S + 37, 3);
    const height = amp * (foot * (0.8 + 0.15 * rn) + Math.sqrt(core) * (2.1 + 1.8 * rn));
    return { core: core * amp, foot: foot * amp, height };
  }

  // ---- relief: what makes a 4 to 8 hex route cross dramatic land --------------------
  // Rolling hills everywhere, plateau tiers broken by escarpments, long narrow ridges
  // (hogbacks: too steep to climb at grade, too long to walk round, so the rail bores
  // through) and dry ravines (too steep to descend into, so the rail spans them). Ridges
  // and ravines are zero-contours of low-frequency fields, like the rivers, so they are
  // long continuous lines rather than blobs a route could walk round.

  /** Rolling hills, roughly -0.5..0.5 before scaling. */
  function hills(x, z) {
    return fbm(x / HILL_SCALE, z / HILL_SCALE, S + 61, 1);
  }

  /** Plateau tiers: 0, 1, 2 ... flat treads with escarpments (risers) between them. */
  function tiers(x, z) {
    const wx = x + 9 * perlin(x / 23 + 4.4, z / 23 - 7.7, S + 62);
    const wz = z + 9 * perlin(x / 23 - 2.2, z / 23 + 1.3, S + 63);
    const v = (0.5 + fbm(wx / 38, wz / 38, S + 64, 2)) * TIER_SPAN;
    const lo = Math.floor(v);
    return lo + smoothstep(1 - TIER_RISER, 1, v - lo);
  }

  /** Profile across a line: 1 on it, 0 beyond `outer` hexes, flat-topped near it. */
  function lineProfile(dist, inner, outer) {
    return 1 - smoothstep(inner, outer, dist);
  }

  function computeTile(q, r) {
    const { x, z } = hexToWorld(q, r);
    const o = originBias(x, z);
    const { T, M, R } = climate(x, z);

    const pR = smoothstep(0.6, 0.8, R);
    const pD = smoothstep(0.18, 0.3, T - M);
    const pW = smoothstep(0.6, 0.7, M);
    const pF = smoothstep(0.46, 0.56, M);
    const pH = smoothstep(0.5, 0.6, T);

    // lowland climate biomes; red canyon country where dry and rugged
    const pC = smoothstep(0.68, 0.78, R);
    const wCanyon = pC * pD;
    const rest = 1 - pC * pD;
    const wDesert = rest * pD;
    const rest2 = rest * (1 - pD);
    const wJungle = rest2 * pW * pH, wRiver = rest2 * pW * (1 - pH);
    const rest3 = rest2 * (1 - pW);
    const wForest = rest3 * pF * (1 - pH * 0.6), wJungle2 = rest3 * pF * pH * 0.6;
    const wGrass = rest3 * (1 - pF);

    const weights = [
      [BIOME_GRASS, wGrass, elevGrass],
      [BIOME_FOREST, wForest, elevForest],
      [BIOME_JUNGLE, wJungle + wJungle2, elevJungle],
      [BIOME_DESERT, wDesert, elevDesert],
      [BIOME_RIVER, wRiver, elevRiver],
      [BIOME_CANYON, wCanyon, elevCanyon],
    ];
    let biome = BIOME_GRASS, best = -1, e = 0, wsum = 0;
    for (const [b, w, f] of weights) {
      if (w > best) { best = w; biome = b; }
      if (w > 0.002) { e += w * f(x, z); wsum += w; }
    }
    e /= wsum || 1;

    // relief common to all country (riverlands stay gentler, deserts get it as dunes and mesas)
    const calm = 1 - 0.55 * wRiver;
    e += HILL_AMP * calm * hills(x, z) - RELIEF_BASE * calm;
    const tier = tiers(x, z);
    e += TIER_HEIGHT * calm * tier;
    const ridgeAmp = RIDGE_HEIGHT * (0.75 + 0.5 * (0.5 + fbm(x / 60 - 3, z / 60 + 5, S + 71, 1)));
    // ridge crest (open-country ridge lines and the start rim); added after the valleys below
    const crest = Math.max(
      lineProfile(contour(q, r, 'ridge').dist, RIDGE_INNER, RIDGE_OUTER),
      lineProfile(contour(q, r, 'rim').dist, RIDGE_INNER, RIDGE_OUTER));

    // ranges rise out of whatever lowland is there; in dry country they are canyon walls
    const rg = range(x, z, pR);
    const lowWet = pW * (1 - pH) * 0.5; // riverlands keep their ranges lower
    // riverlands and the high canyon plateaus get lower ranges (the plateau is already high)
    let rise = RANGE_SCALE * rg.height * (1 - lowWet) * (1 - 0.45 * wCanyon);
    if (pD > 0.5) {
      // escarpments: terrace the rise into flat-topped steps
      const steps = Math.floor(rise / 0.8) * 0.8 + smoothstep(0.55, 0.8, (rise / 0.8) % 1) * 0.8;
      rise = lerp(rise, steps, pD);
    }
    e += rise;
    // the range proper (its walls included) reads as mountains, or canyon in dry country
    if (rg.core > 0.2 && rise > 0.6) biome = pD > 0.5 ? BIOME_CANYON : BIOME_MOUNTAINS;

    // ---- rivers and valleys ----
    // major rivers everywhere except the driest desert; minor rivers in moist country
    const gateMajor = 1 - smoothstep(0.45, 0.55, T - M);
    const gateMinor = smoothstep(0.48, 0.56, M);
    // In high country the rivers run in gorges: narrow valleys with the banks left high, so
    // the rail stays up and crosses on a tall bridge. Lowland rivers keep broad valleys.
    const gorge = smoothstep(GORGE_FROM, GORGE_FULL, e);
    let water = false, valley = 0, wash = 0, riverDist = Infinity;
    const cMajor = contour(q, r, 'major');
    if (gateMajor > 0.02) {
      if (cMajor.water && gateMajor > 0.5) water = true;
      if (gateMajor > 0.5) riverDist = cMajor.dist;
      valley = Math.max(valley, gateMajor * (1 - smoothstep(0.6, lerp(3.5, 1.4, gorge), cMajor.dist)));
    }
    // where the land is too dry for the major river, its line is a dry wash (a ravine)
    wash = (1 - gateMajor) * (1 - smoothstep(0.4, 1.3, cMajor.dist));
    if (gateMinor > 0.02) {
      const c = contour(q, r, 'minor');
      if (c.water && gateMinor > 0.5) water = true;
      if (gateMinor > 0.5) riverDist = Math.min(riverDist, c.dist);
      valley = Math.max(valley, gateMinor * 0.8 * (1 - smoothstep(0.5, lerp(2.2, 1.1, gorge), c.dist)));
    }
    const bed = clamp(0.2 + 0.2 * e, 0.2, 1.2);
    e = lerp(e, bed + 0.2 + RIVER_INCISE, valley * lerp(0.75, 0.9, gorge));

    // ravines: narrow dry clefts, too steep to descend into at grade
    const rav = Math.max(wash, lineProfile(contour(q, r, 'ravine').dist, RAVINE_INNER, RAVINE_OUTER) * (1 - valley) * (1 - wRiver));
    if (rav > 0) e = lerp(e, Math.max(0.3, e - RAVINE_DEPTH - 0.3 * gorge), rav);

    // ridges stand on whatever the valleys left; a river cuts through one only in a narrow
    // water gap (its banks keep the ridge, so the gap is a gorge)
    e += ridgeAmp * calm * crest * smoothstep(0.15, 1.0, riverDist) * (1 - 0.7 * rav);

    // ---- lakes ----
    const lk = 0.5 + 1.6 * fbm(x / 15 + 101, z / 15 - 77, S + 41, 2);
    const tLake = 0.97 - 0.08 * pW + 0.6 * rg.foot + 0.35 * pD;
    const lakeShore = smoothstep(tLake - 0.12, tLake, lk);
    const lakeLevel = 0.25 + 0.25 * (0.5 + fbm(x / 40, z / 40, S + 42, 1));
    if (lakeShore > 0) e = lerp(e, lakeLevel + 0.2, lakeShore * 0.85);
    if (lk > tLake) water = true;

    // ---- origin guarantee: dry and gentle where the first station stands ----
    if (o > 0) {
      e = lerp(e, 0.8 + 0.2 * (e - 0.8), o);
      if (o > 0.02) water = false;
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
