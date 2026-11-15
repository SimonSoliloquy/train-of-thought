// Station layout. Positions come only from the link structure (who links to whom, and in
// what reading order); terrain only nudges a station off water or cliffs to the nearest
// acceptable hex. hashString(title) jitters the angle slot so an article has a stable heading.

import { WORLD, HEX_SIZE } from '../config.js';
import { hexToWorld, worldToHex, hexRing, hexSpiral, hashString, hexDistance } from '../hex.js';
import { tileKey } from './terrain.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~137.5 degrees
const PHI_FRAC = (Math.sqrt(5) - 1) / 2;           // ~0.618
const HEX_STEP = HEX_SIZE * Math.sqrt(3);          // world distance between neighbouring centres
/** Total width of the fan of a non-start station's ghosts (radians). */
export const FAN_WIDTH = (200 * Math.PI) / 180;

/**
 * @param {{isBuildable:(q:number,r:number)=>boolean}} terrain
 */
export function createLayout(terrain) {
  /** @type {Map<string, import('../types.js').Placement>} */
  const placements = new Map();
  const occupied = new Map(); // tileKey -> title

  function isFreeFor(q, r) {
    // keep minStationSpacing (hex distance) to every station
    const reach = WORLD.minStationSpacing - 1;
    for (const h of hexSpiral(q, r, reach)) {
      if (occupied.has(tileKey(h.q, h.r))) return false;
    }
    return true;
  }

  function acceptable(q, r) {
    return terrain.isBuildable(q, r) && isFreeFor(q, r);
  }

  /** Closest acceptable hex to a world-space target point. Always succeeds (widens as needed). */
  function findSpot(tx, tz) {
    const c = worldToHex(tx, tz);
    let best = null, bestD = Infinity, foundAt = -1;
    for (let k = 0; k < 4096; k++) {
      if (foundAt >= 0 && k > foundAt + 1) break;
      for (const h of hexRing(c.q, c.r, k)) {
        if (!acceptable(h.q, h.r)) continue;
        const w = hexToWorld(h.q, h.r);
        const d = Math.hypot(w.x - tx, w.z - tz);
        if (d < bestD - 1e-9) { best = h; bestD = d; }
        if (foundAt < 0) foundAt = k;
      }
    }
    if (!best) throw new Error('world: no acceptable hex found for a station');
    return best;
  }

  function add(title, q, r, state, parent) {
    const p = { title, q, r, state, parent };
    placements.set(title, p);
    occupied.set(tileKey(q, r), title);
    return p;
  }

  function placeStart(title) {
    if (placements.size > 0) throw new Error('world.placeStart: the map already has stations');
    return add(title, 0, 0, 'built', null);
  }

  /** Heading (radians, world x/z plane) and fan width for the children of `parent`. */
  function fanFor(parent) {
    const pw = hexToWorld(parent.q, parent.r);
    const gp = parent.parent != null ? placements.get(parent.parent) : null;
    if (gp && (gp.q !== parent.q || gp.r !== parent.r)) {
      const gw = hexToWorld(gp.q, gp.r);
      return { full: false, base: Math.atan2(pw.z - gw.z, pw.x - gw.x) };
    }
    return { full: true, base: (hashString(parent.title) / 4294967296) * Math.PI * 2 };
  }

  function placeGhosts(parentTitle, titles) {
    const parent = placements.get(parentTitle);
    if (!parent) throw new Error(`world.placeGhosts: "${parentTitle}" is not on the map`);
    const n = titles.length;
    const fan = fanFor(parent);
    const pw = hexToWorld(parent.q, parent.r);
    const out = [];
    for (let i = 0; i < n; i++) {
      const title = titles[i];
      if (typeof title !== 'string' || placements.has(title)) continue;
      const f = n > 1 ? i / (n - 1) : 0;
      const dist = WORLD.ghostMinDist + (WORLD.ghostMaxDist - WORLD.ghostMinDist) * f;
      const jitter = hashString(title) / 4294967296 - 0.5; // -0.5..0.5
      let angle;
      if (fan.full) {
        // phyllotaxis: consecutive links spread round the circle, distance grows with order
        angle = fan.base + i * GOLDEN_ANGLE + jitter * 0.35;
      } else {
        // low-discrepancy slots across the fan; first link points straight outward
        const u = (0.5 + i * PHI_FRAC) % 1;
        const slot = FAN_WIDTH / Math.max(n, 4);
        angle = fan.base + FAN_WIDTH * (u - 0.5) + jitter * slot * 0.5;
      }
      const tx = pw.x + Math.cos(angle) * dist * HEX_STEP;
      const tz = pw.z + Math.sin(angle) * dist * HEX_STEP;
      const h = findSpot(tx, tz);
      out.push(add(title, h.q, h.r, 'ghost', parentTitle));
    }
    return out;
  }

  function setBuilt(title) {
    const p = placements.get(title);
    if (!p) throw new Error(`world.setBuilt: "${title}" is not on the map`);
    p.state = 'built';
    return p;
  }

  function stationAt(q, r) {
    return occupied.get(tileKey(q, r)) ?? null;
  }

  return { placements, placeStart, placeGhosts, setBuilt, stationAt, hexDistance };
}
