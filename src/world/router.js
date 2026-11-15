// Track routing. A* over (hex, rail level) states inside a bounded ellipse between the two
// stations. The rail level may change by at most MAX_RISE_LEVELS elevation steps per hex (the
// grade limit), so trains ride over rolling country; where the ground is steeper the rail
// stays at grade and the hex becomes a ledge, tunnel or bridge according to how far the rail
// sits below or above the ground. Cost is per hex kind only; climbing is free, boring and
// spanning are what cost, so the cheap route tunnels where the land is too steep to climb
// and too long to walk round.

import { ECON } from '../config.js';
import { HEX_DIRS, hexDistance, hexSpiral, hexToWorld } from '../hex.js';
import { routeLength } from '../route.js';
import { ELEV_STEP, MAX_LEVEL, tileKey } from './terrain.js';

/** Max rail rise per hex in elevation levels, and in world units (the grade limit). */
export const MAX_RISE_LEVELS = 2;
export const MAX_RISE_PER_HEX = MAX_RISE_LEVELS * ELEV_STEP;
/** Routing-only tie-break per level climbed beyond one per hex: steep grades only where they help. */
const STEEP_TIE = 0.3;
/** Ground side slope (world units to any neighbour) at which an at-grade hex becomes a ledge
 *  (matches STATION_MAX_STEEPNESS: land a station may stand on carries plain track). */
export const LEDGE_SIDE_SLOPE = 1.2;
/** Rail this many levels below ground -> tunnel; this many above -> bridge (viaduct). */
export const TUNNEL_DEPTH_LEVELS = 2;
export const VIADUCT_HEIGHT_LEVELS = 3;
/** Rail sits this many levels above a water surface on a bridge. */
export const BRIDGE_CLEARANCE_LEVELS = 1;
/** Routing-only tie-break per level the rail sits off the ground surface. */
const OFF_GROUND_TIE = 0.5;
/** Routing-only penalty (not part of cost) for running over existing track. */
const TRACK_PENALTY = 6;
/** Weight that makes 'direct' minimise hex count first. */
const LENGTH_WEIGHT = 100000;
/** Tie-break per 60-degree turn: far below any cost difference, so it only straightens equal routes. */
const TURN_TIE = 0.01;
const POINTS_PER_HEX = 8;

const KIND_IDX = { ground: 0, ledge: 1, bridge: 2, tunnel: 3 };
const KINDS = ['ground', 'ledge', 'bridge', 'tunnel'];
const KIND_COST = KINDS.map((k) => ECON.trackCostPerHex[k]);
const MIN_KIND_COST = Math.min(...KIND_COST);

/**
 * Kind of a route hex given its ground level, water flag, side slope and the rail level.
 * Returns -1 when the rail level is not allowed there.
 */
export function classify(groundLevel, water, sideSlope, railLevel) {
  if (water) return railLevel >= groundLevel + BRIDGE_CLEARANCE_LEVELS ? KIND_IDX.bridge : -1;
  const d = groundLevel - railLevel; // >0: rail below ground
  if (d >= TUNNEL_DEPTH_LEVELS) return KIND_IDX.tunnel;
  if (d <= -VIADUCT_HEIGHT_LEVELS) return KIND_IDX.bridge;
  if (d === 2 || d === -2) return KIND_IDX.ledge;
  if (sideSlope >= LEDGE_SIDE_SLOPE - 1e-9) return KIND_IDX.ledge;
  return KIND_IDX.ground;
}

// ---- binary heap of (priority, node) ---------------------------------------------
class Heap {
  constructor() { this.p = []; this.n = []; }
  get size() { return this.p.length; }
  push(pri, node) {
    const p = this.p, n = this.n;
    let i = p.length;
    p.push(pri); n.push(node);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (p[j] <= pri) break;
      p[i] = p[j]; n[i] = n[j]; i = j;
    }
    p[i] = pri; n[i] = node;
  }
  pop() {
    const p = this.p, n = this.n;
    const top = n[0];
    const lp = p.pop(), ln = n.pop();
    const len = p.length;
    if (len > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= len) break;
        if (c + 1 < len && p[c + 1] < p[c]) c++;
        if (p[c] >= lp) break;
        p[i] = p[c]; n[i] = n[c]; i = c;
      }
      p[i] = lp; n[i] = ln;
    }
    return top;
  }
}

/**
 * @param {{terrainAt:Function, levelAt:Function, steepness:Function}} terrain
 * @param {(q:number,r:number)=>string|null} stationAt
 * @param {Map<any, number>} trackHexes  tileKey -> count of committed routes over that hex
 */
export function createRouter(terrain, stationAt, trackHexes) {
  const L = MAX_LEVEL + 1;

  function buildRegion(a, b, slack) {
    const D = hexDistance(a, b);
    const limit = D + slack;
    const hexes = [];
    const index = new Map();
    for (const h of hexSpiral(a.q, a.r, limit)) {
      if (hexDistance(h, a) + hexDistance(h, b) > limit) continue;
      index.set(tileKey(h.q, h.r), hexes.length);
      hexes.push(h);
    }
    const n = hexes.length;
    const nbr = new Int32Array(n * 6).fill(-1);
    const ground = new Int32Array(n), water = new Uint8Array(n), slope = new Float64Array(n);
    const blocked = new Uint8Array(n), track = new Uint8Array(n), hDist = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const h = hexes[i];
      const t = terrain.terrainAt(h.q, h.r);
      ground[i] = terrain.levelAt(h.q, h.r);
      water[i] = t.water ? 1 : 0;
      slope[i] = terrain.steepness(h.q, h.r);
      const st = stationAt(h.q, h.r);
      const isEnd = (h.q === a.q && h.r === a.r) || (h.q === b.q && h.r === b.r);
      blocked[i] = st != null && !isEnd ? 1 : 0;
      track[i] = trackHexes.has(tileKey(h.q, h.r)) ? 1 : 0;
      hDist[i] = hexDistance(h, b);
      for (let d = 0; d < 6; d++) {
        const j = index.get(tileKey(h.q + HEX_DIRS[d].q, h.r + HEX_DIRS[d].r));
        if (j !== undefined) nbr[i * 6 + d] = j;
      }
    }
    return { hexes, index, nbr, ground, water, slope, blocked, track, hDist, n };
  }

  /**
   * A* over (hex, rail level, heading). mode 'cheap' minimises cost; 'direct' minimises hex
   * count, then cost. Consecutive moves may turn by at most 60 degrees (no hairpins) unless
   * allowSharp; a route never revisits a hex.
   */
  function search(R, ai, bi, mode, allowSharp) {
    const { nbr, ground, water, slope, blocked, track, hDist, n } = R;
    const D7 = 7; // headings 0..5, 6 = at the start (any heading)
    const N = n * L * D7;
    const g = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const kindOf = new Int8Array(N).fill(-1);
    const reached = new Uint8Array(n); // hex reached at any level/heading
    const stepW = mode === 'direct' ? LENGTH_WEIGHT : 0;
    const penalty = mode === 'cheap' ? TRACK_PENALTY : 1; // direct: tiny tiebreak only
    const hMul = stepW + MIN_KIND_COST;
    const goalLevel = ground[bi];
    const hexOf = (v) => (v / (L * D7)) | 0;

    const startLevel = ground[ai];
    const sk = classify(ground[ai], false, slope[ai], startLevel);
    const s = (ai * L + startLevel) * D7 + 6;
    g[s] = KIND_COST[sk] + stepW;
    reached[ai] = 1;
    kindOf[s] = sk;
    const heap = new Heap();
    heap.push(g[s] + hMul * Math.max(hDist[ai], Math.ceil(Math.abs(startLevel - goalLevel) / MAX_RISE_LEVELS)), s);
    let goal = -1;

    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      const dir = cur % D7;
      const hl = (cur - dir) / D7;
      const hi = (hl / L) | 0, lv = hl - hi * L;
      if (hi === bi) { goal = cur; break; }
      const gc = g[cur];
      for (let d = 0; d < 6; d++) {
        let turn = 0;
        if (dir !== 6) {
          const t = (d - dir + 6) % 6;
          if (t === 3 || (!allowSharp && (t === 2 || t === 4))) continue;
          turn = t === 0 ? 0 : TURN_TIE;
        }
        const j = nbr[hi * 6 + d];
        if (j < 0 || blocked[j]) continue;
        const isGoalHex = j === bi;
        for (let dl = -MAX_RISE_LEVELS; dl <= MAX_RISE_LEVELS; dl++) {
          const nl = lv + dl;
          if (nl < 0 || nl >= L) continue;
          if (isGoalHex && nl !== goalLevel) continue;
          const k = classify(ground[j], water[j] === 1, slope[j], nl);
          if (k < 0) continue;
          const node = (j * L + nl) * D7 + d;
          if (closed[node]) continue;
          // Routing-only tie-break (not part of cost): keep the rail on the surface where it
          // can be, so open track is never buried a step below flat ground.
          const off = water[j] === 1 ? 0 : Math.abs(ground[j] - nl) * OFF_GROUND_TIE;
          const steep = dl > 1 || dl < -1 ? (Math.abs(dl) - 1) * STEEP_TIE : 0;
          const ng = gc + stepW + KIND_COST[k] + (track[j] ? penalty : 0) + turn + off + steep;
          if (ng < g[node]) {
            // a route never revisits a hex (no climbing in loops): check the path so far
            if (reached[j]) {
              let onPath = false;
              for (let v = cur; v >= 0; v = prev[v]) if (hexOf(v) === j) { onPath = true; break; }
              if (onPath) continue;
            }
            reached[j] = 1;
            g[node] = ng;
            prev[node] = cur;
            kindOf[node] = k;
            heap.push(ng + hMul * Math.max(hDist[j], Math.ceil(Math.abs(nl - goalLevel) / MAX_RISE_LEVELS)), node);
          }
        }
      }
    }
    if (goal < 0) return null;
    const chain = [];
    for (let v = goal; v >= 0; v = prev[v]) chain.push(v);
    chain.reverse();
    return chain.map((v) => {
      const hl = (v - (v % D7)) / D7;
      const hi = (hl / L) | 0;
      return { q: R.hexes[hi].q, r: R.hexes[hi].r, level: hl - hi * L, kind: KINDS[kindOf[v]] };
    });
  }

  function makeRoute(from, to, style, steps) {
    const hexes = steps.map((s) => ({ q: s.q, r: s.r, kind: s.kind }));
    let cost = 0;
    for (const s of steps) cost += ECON.trackCostPerHex[s.kind];
    const route = { from, to, style, hexes, points: buildPoints(steps), length: 0, cost };
    route.length = routeLength(route);
    return route;
  }

  function sameSteps(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].q !== b[i].q || a[i].r !== b[i].r || a[i].kind !== b[i].kind) return false;
    }
    return true;
  }

  function costOf(steps) {
    let c = 0;
    for (const s of steps) c += ECON.trackCostPerHex[s.kind];
    return c;
  }

  /** @returns {{cheap: object, direct: object, same: boolean}} */
  function findRoutes(fromTitle, a, toTitle, b) {
    const D = hexDistance(a, b);
    if (D === 0) throw new Error(`world.findRoutes: "${fromTitle}" and "${toTitle}" share a hex`);
    let cheap = null, direct = null;
    // widen the region if blocked; hairpins only as a last resort
    const attempts = [
      [Math.max(5, Math.ceil(D * 0.75)), false], [D * 2 + 8, false], [D * 4 + 24, false], [D * 4 + 24, true],
    ];
    for (const [slack, allowSharp] of attempts) {
      const R = buildRegion(a, b, slack);
      const ai = R.index.get(tileKey(a.q, a.r)), bi = R.index.get(tileKey(b.q, b.r));
      cheap = search(R, ai, bi, 'cheap', allowSharp);
      if (!cheap) continue;
      direct = search(R, ai, bi, 'direct', allowSharp);
      if (direct) break;
    }
    if (!cheap || !direct) throw new Error(`world.findRoutes: no route from "${fromTitle}" to "${toTitle}"`);
    // Guarantees (the track penalty can blur them): cheap never costs more, direct never longer.
    // ties collapse to one route so the player is not offered two equal choices.
    if (costOf(direct) <= costOf(cheap)) cheap = direct;
    if (cheap.length <= direct.length) direct = cheap;
    const same = sameSteps(cheap, direct);
    return {
      cheap: makeRoute(fromTitle, toTitle, 'cheap', cheap),
      direct: makeRoute(fromTitle, toTitle, 'direct', same ? cheap : direct),
      same,
    };
  }

  return { findRoutes };
}

// ---- centreline -------------------------------------------------------------------

/**
 * Uniform Catmull-Rom through the hex centres (x, z) and rail heights (y), POINTS_PER_HEX
 * samples per hex step. Hex centres are equally spaced so this is C1 smooth with no kinks
 * and passes exactly through every centre, including both station centres.
 */
export function buildPoints(steps) {
  const P = steps.map((s) => {
    const w = hexToWorld(s.q, s.r);
    return { x: w.x, y: s.level * ELEV_STEP, z: w.z, kind: s.kind };
  });
  const n = P.length;
  if (n === 1) return [{ ...P[0] }];
  const pts = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)];
    // mirror the end tangents so the curve leaves/enters the stations straight
    const a = i === 0 ? mirror(p2, p1) : p0;
    const d = i + 2 >= n ? mirror(p1, p2) : p3;
    for (let k = 0; k < POINTS_PER_HEX; k++) {
      const t = k / POINTS_PER_HEX;
      pts.push({
        x: cr(a.x, p1.x, p2.x, d.x, t),
        y: crY(a.y, p1.y, p2.y, d.y, t),
        z: cr(a.z, p1.z, p2.z, d.z, t),
        kind: t < 0.5 ? p1.kind : p2.kind,
      });
    }
  }
  const last = P[n - 1];
  pts.push({ x: last.x, y: last.y, z: last.z, kind: last.kind });
  pts[0].x = P[0].x; pts[0].y = P[0].y; pts[0].z = P[0].z;
  return pts;
}

function mirror(p, about) {
  return { x: 2 * about.x - p.x, y: 2 * about.y - p.y, z: 2 * about.z - p.z };
}

function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Catmull-Rom for heights, clamped to the segment's own range so it never overshoots. */
function crY(p0, p1, p2, p3, t) {
  const v = cr(p0, p1, p2, p3, t);
  const lo = Math.min(p1, p2), hi = Math.max(p1, p2);
  return v < lo ? lo : v > hi ? hi : v;
}
