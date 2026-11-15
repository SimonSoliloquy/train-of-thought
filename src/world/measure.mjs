// Geometry checks over a set of committed routes: do tracks lie on one another, cross at grade,
// or come too close? Used by stats.mjs (before/after numbers) and world.test.js.

import { WORLD } from '../config.js';
import { hexKey, worldToHex } from '../hex.js';

/** Squared 3D distance from point p to segment ab, and the segment parameter. */
function pointSeg(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y, vz = b.z - a.z;
  const wx = p.x - a.x, wy = p.y - a.y, wz = p.z - a.z;
  const L = vx * vx + vy * vy + vz * vz;
  let t = L > 0 ? (wx * vx + wy * vy + wz * vz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - t * vx, dy = wy - t * vy, dz = wz - t * vz;
  return dx * dx + dy * dy + dz * dz;
}

/** Horizontal (x, z) intersection of segments ab and cd: parameters, or null. */
function segCross(a, b, c, d) {
  const rx = b.x - a.x, rz = b.z - a.z, sx = d.x - c.x, sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = c.x - a.x, qz = c.z - a.z;
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  if (t < 0 || t >= 1 || u < 0 || u >= 1) return null;
  return { t, u };
}

/**
 * @param {object[]} routes  committed routes
 * @param {Set<string>} stationHexes  hexKey of every built station
 */
export function measureNetwork(routes, stationHexes) {
  const clearance = WORLD.crossingClearance;
  const inStation = (p) => { const h = worldToHex(p.x, p.z); return stationHexes.has(hexKey(h.q, h.r)); };
  // 1. hexes where a route's centreline lies on another track's centreline (outside stations):
  //    both run through the hex centre (no lane offset) and neither is a marked over/under crossing.
  const centre = new Map(); // hexKey -> [{ri, crossing}]
  let routeHexes = 0;
  routes.forEach((r, ri) => {
    for (const h of r.hexes) {
      const k = hexKey(h.q, h.r);
      if (stationHexes.has(k)) continue;
      routeHexes++;
      if (h.lane) continue;
      if (!centre.has(k)) centre.set(k, []);
      centre.get(k).push({ ri, crossing: !!(h.over || h.under) });
    }
  });
  let stacked = 0;
  for (const list of centre.values()) {
    if (list.length < 2) continue;
    for (const e of list) if (!e.crossing && list.some((o) => o.ri !== e.ri && !o.crossing)) stacked++;
    // two crossing tracks over one base are fine; a base with no crossing partner is counted above
  }
  // 2. crossings (horizontal intersections of two polylines outside stations) and their clearance,
  // 3. minimum 3D distance between two different tracks outside station hexes
  let atGrade = 0, crossings = 0, minClear = Infinity, minDist = Infinity;
  const boxes = routes.map((r) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of r.points) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    return { x0, x1, z0, z1 };
  });
  const near = (a, b, m) => a.x0 - m <= b.x1 && b.x0 - m <= a.x1 && a.z0 - m <= b.z1 && b.z0 - m <= a.z1;
  const stationFlags = routes.map((r) => r.points.map(inStation));
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      if (!near(boxes[i], boxes[j], 1)) continue;
      const A = routes[i].points, B = routes[j].points;
      const fa = stationFlags[i], fb = stationFlags[j];
      for (let a = 0; a + 1 < A.length; a++) {
        const a0 = A[a], a1 = A[a + 1];
        const ax0 = Math.min(a0.x, a1.x) - 1, ax1 = Math.max(a0.x, a1.x) + 1;
        const az0 = Math.min(a0.z, a1.z) - 1, az1 = Math.max(a0.z, a1.z) + 1;
        for (let b = 0; b + 1 < B.length; b++) {
          const b0 = B[b], b1 = B[b + 1];
          if (Math.max(b0.x, b1.x) < ax0 || Math.min(b0.x, b1.x) > ax1 || Math.max(b0.z, b1.z) < az0 || Math.min(b0.z, b1.z) > az1) continue;
          const c = segCross(a0, a1, b0, b1);
          if (c) {
            const pa = { x: a0.x + (a1.x - a0.x) * c.t, z: a0.z + (a1.z - a0.z) * c.t };
            if (!inStation(pa)) {
              crossings++;
              const ya = a0.y + (a1.y - a0.y) * c.t, yb = b0.y + (b1.y - b0.y) * c.u;
              const dy = Math.abs(ya - yb);
              minClear = Math.min(minClear, dy);
              if (dy < clearance - 1e-6) atGrade++;
            }
          }
          if (!fa[a]) minDist = Math.min(minDist, pointSeg(a0, b0, b1));
          if (!fb[b]) minDist = Math.min(minDist, pointSeg(b0, a0, a1));
        }
      }
    }
  }
  let laneRoutes = 0, laneHexes = 0, over = 0, under = 0;
  for (const r of routes) {
    const n = r.hexes.filter((h) => h.lane).length;
    if (n) { laneRoutes++; laneHexes += n; }
    over += r.hexes.filter((h) => h.over).length;
    under += r.hexes.filter((h) => h.under).length;
  }
  return {
    routes: routes.length, routeHexes, stacked, crossings, atGrade,
    minClear: crossings ? minClear : NaN, minDist: Math.sqrt(minDist),
    laneRoutes, laneHexes, over, under,
  };
}
