// Track routing. A* over (hex, rail level, heading) states inside a bounded ellipse between the two
// stations. The rail level may change by at most MAX_RISE_LEVELS elevation steps per hex (the
// grade limit), so trains ride over rolling country; where the ground is steeper the rail
// stays at grade and the hex becomes a ledge, tunnel or bridge according to how far the rail
// sits below or above the ground. Cost is per hex kind only; climbing is free, boring and
// spanning are what cost, so the cheap route tunnels where the land is too steep to climb
// and too long to walk round.
//
// Built track (tracks.js) is never run over. A route meets it in one of two ways:
//  - as a parallel LANE of a shared corridor: travelling along the first track ("base") of each
//    hex, at its rail level, offset sideways by a whole number of WORLD.laneSpacing, for
//    WORLD.laneCostFactor of the hex price. It joins from a free hex on the side it will run
//    on and leaves again on that same side (so a branch never cuts across the trunk), or it
//    converges with the base inside a station hex the base also starts or ends in. Extra
//    search states carry the lane (and whether it was just joined, so a lane is never a
//    one-hex skim).
//  - as a CROSSING: entering from one side of the base and leaving on the other, with its rail
//    at least WORLD.crossingClearance above every rail in the hex (over: a short bridge) or below
//    it (under), approached at most one level per hex so the deck is level where it crosses.

import { ECON, WORLD, HEX_SIZE } from '../config.js';
import { HEX_DIRS, hexDistance, hexSpiral, hexToWorld } from '../hex.js';
import { routeLength } from '../route.js';
import { ELEV_STEP, MAX_LEVEL, tileKey } from './terrain.js';
import { createTrackStore, CLEAR_LEVELS, MAX_LANES, laneSlot } from './tracks.js';

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
/** Weight that makes 'direct' minimise hex count first. */
const LENGTH_WEIGHT = 100000;
/** Tie-break per 60-degree turn: far below any cost difference, so it only straightens equal routes. */
const TURN_TIE = 0.01;
/** Tie-breaks: inner lanes before outer ones; over before under where they cost the same. */
const LANE_TIE = 0.02;
const UNDER_TIE = 0.3;
/** Routing-only penalty per hex next to a third built station: keep room round stations for
 *  their own track (no track may lie on another, so a station ringed by track is cut off). */
const STATION_RING_PENALTY = 15;
const POINTS_PER_HEX = 8;
/** Part of a hex step either side of a crossing hex centre over which the crossing deck is level. */
const DECK_POINTS = 3;

const KIND_IDX = { ground: 0, ledge: 1, bridge: 2, tunnel: 3 };
const KINDS = ['ground', 'ledge', 'bridge', 'tunnel'];
const KIND_COST = KINDS.map((k) => ECON.trackCostPerHex[k]);
const MIN_KIND_COST = Math.min(...KIND_COST);
const LANE_FACTOR = WORLD.laneCostFactor;
const SHARED_FACTOR = WORLD.sharedCostFactor;
const LANE_SPACING = WORLD.laneSpacing;
const M = MAX_LANES;
const LANE_SLOTS = 2 * M; // lanes +1..+M, -1..-M
const LANE_STATES = LANE_SLOTS * 2; // x fresh flag
const HEX_STEP = Math.sqrt(3) * HEX_SIZE;
const DIR_W = HEX_DIRS.map((d) => hexToWorld(d.q, d.r));

/** Price of one route hex: its kind, at the lane factor when it runs beside existing track. */
export function hexPrice(h) {
  return ECON.trackCostPerHex[h.kind] * (h.shared ? SHARED_FACTOR : h.lane ? LANE_FACTOR : 1);
}

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

// Search buffers, grown on demand and reused (findRoutes runs every second).
let BUF = { size: 0, g: null, prev: null, closed: null, kindOf: null };
function buffers(N) {
  if (BUF.size < N) {
    const size = Math.max(N, BUF.size * 2);
    BUF = { size, g: new Float64Array(size), prev: new Int32Array(size), closed: new Uint8Array(size), kindOf: new Int8Array(size) };
  }
  BUF.g.fill(Infinity, 0, N);
  BUF.prev.fill(-1, 0, N);
  BUF.closed.fill(0, 0, N);
  return BUF;
}

/**
 * @param {{terrainAt:Function, levelAt:Function, steepness:Function}} terrain
 * @param {(q:number,r:number)=>string|null} stationAt
 * @param {ReturnType<typeof createTrackStore>} [store]  built track (a bare Map or nothing: none)
 */
export function createRouter(terrain, stationAt, store) {
  if (!store || typeof store.commit !== 'function') store = createTrackStore();
  const L = MAX_LEVEL + 1;
  const plans = new WeakMap(); // route -> { steps, version }

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
    const blocked = new Uint8Array(n), hDist = new Int32Array(n), occ = new Int32Array(n).fill(-1);
    const ring = new Float64Array(n);
    const hexEdge = new Int32Array(n * 6).fill(-1), E = []; // centreline links out of each hex
    const recs = [];
    for (let i = 0; i < n; i++) {
      const h = hexes[i];
      const t = terrain.terrainAt(h.q, h.r);
      ground[i] = terrain.levelAt(h.q, h.r);
      water[i] = t.water ? 1 : 0;
      slope[i] = terrain.steepness(h.q, h.r);
      const st = stationAt(h.q, h.r);
      const isEnd = (h.q === a.q && h.r === a.r) || (h.q === b.q && h.r === b.r);
      blocked[i] = st != null && !isEnd ? 1 : 0;
      hDist[i] = hexDistance(h, b);
      const any = store.get(h.q, h.r);
      if (any) for (const [d, e] of any.edges) { hexEdge[i * 6 + d] = E.length; E.push(e); }
      const rec = isEnd ? null : any;
      if (rec && rec.base) { occ[i] = recs.length; recs.push({ i, rec }); }
      if (!isEnd) {
        for (let d = 0; d < 6; d++) {
          const nq = h.q + HEX_DIRS[d].q, nr = h.r + HEX_DIRS[d].r;
          if ((nq === a.q && nr === a.r) || (nq === b.q && nr === b.r)) continue;
          if (stationAt(nq, nr) != null) { ring[i] = STATION_RING_PENALTY; break; }
        }
      }
      for (let d = 0; d < 6; d++) {
        const j = index.get(tileKey(h.q + HEX_DIRS[d].q, h.r + HEX_DIRS[d].r));
        if (j !== undefined) nbr[i * 6 + d] = j;
      }
    }
    // corridor hexes, flattened for the search
    const m = recs.length;
    const O = {
      m, hex: new Int32Array(m), side: new Int8Array(m * 6), rid: new Int32Array(m), idx: new Int32Array(m),
      level: new Int32Array(m), kind: new Int8Array(m), sharp: new Uint8Array(m), hin: new Int8Array(m), hout: new Int8Array(m), laneMask: new Int32Array(m),
      outer: new Int8Array(m * 2), sideTrans: new Uint8Array(m * 2), minSideTrans: new Int8Array(m * 2),
      anyTrans: new Uint8Array(m), cross: new Uint8Array(m), hi: new Int32Array(m), lo: new Int32Array(m),
      forks: new Uint8Array(m), tx: new Float64Array(m), tz: new Float64Array(m),
    };
    recs.forEach(({ i, rec }, o) => {
      const bs = rec.base, s = rec.sum;
      O.hex[o] = i;
      O.side.set(bs.side, o * 6);
      O.rid[o] = bs.rid; O.idx[o] = bs.idx; O.level[o] = bs.level; O.kind[o] = KIND_IDX[bs.kind];
      O.sharp[o] = bs.sharp ? 1 : 0; O.hin[o] = bs.hin; O.hout[o] = bs.hout;
      O.laneMask[o] = s.laneMask;
      for (let k = 0; k < 2; k++) {
        O.outer[o * 2 + k] = s.outer[k]; O.sideTrans[o * 2 + k] = s.sideTrans[k]; O.minSideTrans[o * 2 + k] = s.minSideTrans[k];
      }
      O.anyTrans[o] = s.anyTrans ? 1 : 0; O.cross[o] = s.cross ? 1 : 0; O.hi[o] = s.hi; O.lo[o] = s.lo;
      O.forks[o] = s.forks;
      const tx = DIR_W[bs.hin].x + DIR_W[bs.hout].x, tz = DIR_W[bs.hin].z + DIR_W[bs.hout].z, tl = Math.hypot(tx, tz) || 1;
      O.tx[o] = tx / tl; O.tz[o] = tz / tl;
    });
    return { hexes, index, nbr, ground, water, slope, blocked, hDist, n, occ, O, ring, hexEdge, E };
  }

  /**
   * A* over (hex, rail level, heading [, lane | crossing side]). mode 'cheap' minimises cost;
   * 'direct' minimises hex count, then cost. Consecutive moves may turn by at most 60 degrees
   * (no hairpins) unless allowSharp; a route never revisits a hex.
   */
  function search(R, ai, bi, mode, allowSharp) {
    const { nbr, ground, water, slope, blocked, hDist, n, occ, O, ring, hexEdge, E } = R;
    const m = O.m;
    const D7 = 7; // headings 0..5, 6 = at the start (any heading)
    const NF = n * L * D7; // free states: (hex, level, heading)
    const NLANE = m * D7 * LANE_STATES; // lane states: (corridor hex, heading, lane, fresh); level = base level
    const NL0 = NF, NC0 = NF + NLANE; // crossing states: (corridor hex, level, heading, entry side)
    const NS0 = NC0 + m * L * D7 * 2; // shared-rail states: (corridor hex, heading, tangent sign, fresh)
    const N = NS0 + m * D7 * 4;
    const { g, prev, closed, kindOf } = buffers(N);
    const reached = new Uint8Array(n); // hex reached in any state
    const stepW = mode === 'direct' ? LENGTH_WEIGHT : 0;
    const hMul = stepW + (m > 0 ? MIN_KIND_COST * Math.min(LANE_FACTOR, SHARED_FACTOR) : MIN_KIND_COST);
    const goalLevel = ground[bi];

    const hexOf = (v) => {
      if (v < NL0) return (v / (L * D7)) | 0;
      if (v < NC0) return O.hex[((v - NL0) / (D7 * LANE_STATES)) | 0];
      if (v < NS0) return O.hex[((v - NC0) / (L * D7 * 2)) | 0];
      return O.hex[((v - NS0) / (D7 * 4)) | 0];
    };
    const onPath = (cur, j) => {
      for (let v = cur; v >= 0; v = prev[v]) if (hexOf(v) === j) return true;
      return false;
    };
    const heap = new Heap();
    const relax = (cur, node, ng, k, j, nl) => {
      ng += ring[j];
      if (closed[node] || !(ng < g[node])) return;
      if (reached[j] && onPath(cur, j)) return;
      reached[j] = 1;
      g[node] = ng;
      prev[node] = cur;
      kindOf[node] = k;
      heap.push(ng + hMul * Math.max(hDist[j], Math.ceil(Math.abs(nl - goalLevel) / MAX_RISE_LEVELS)), node);
    };
    const freeNode = (j, nl, d) => (j * L + nl) * D7 + d;
    const laneNode = (o, d, l, fresh) => NL0 + ((o * D7 + d) * LANE_SLOTS + laneSlot(l)) * 2 + fresh;
    const crossNode = (o, nl, d, s) => NC0 + ((o * L + nl) * D7 + d) * 2 + (s > 0 ? 0 : 1);
    const sharedNode = (o, d, sg, fresh) => NS0 + ((o * D7 + d) * 2 + (sg > 0 ? 0 : 1)) * 2 + fresh;
    const sharedCost = (o) => stepW + KIND_COST[O.kind[o]] * SHARED_FACTOR;
    // joining or forking off shared rails: within 60 degrees of the trunk (sg x its tangent)
    const fitsTrunk = (o, d, sg) => sg * (O.tx[o] * DIR_W[d].x + O.tz[o] * DIR_W[d].z) >= 0.5 * HEX_STEP - 1e-6;
    // a fork curves across the side it leaves on: no lane there, no crossing in the hex
    const canFork = (o, s) => s !== 0 && !O.cross[o] && O.outer[o * 2 + (s > 0 ? 0 : 1)] === 0;
    const offTie = (j, nl) => (water[j] === 1 ? 0 : Math.abs(ground[j] - nl) * OFF_GROUND_TIE);

    // lane rules (see tracks.js): l's slot free; a lane running through a hex may not pass where an
    // inner lane on its side swings in from the side; a lane that joins or leaves in a hex needs no
    // crossing there, no other side join on its side, and (from the side) no lane outside it.
    const laneFree = (o, l) => (O.laneMask[o] & (1 << laneSlot(l))) === 0;
    const si = (l) => (l > 0 ? 0 : 1);
    const noFork = (o, l) => (O.forks[o] & (l > 0 ? 1 : 2)) === 0;
    const canRun = (o, l) => noFork(o, l) && (!O.sideTrans[o * 2 + si(l)] || O.minSideTrans[o * 2 + si(l)] > Math.abs(l));
    const canStationTrans = (o, l) => noFork(o, l) && !O.cross[o] && !O.sideTrans[o * 2 + si(l)];
    const canSideTrans = (o, l) => canStationTrans(o, l) && O.outer[o * 2 + si(l)] < Math.abs(l);
    const canCross = (o) => !O.cross[o] && !O.anyTrans[o];

    // free move into a free hex j (or the goal) from level lv, with rise limit `rise`
    const freeMoves = (cur, gc, j, d, lv, rise, turn) => {
      const isGoal = j === bi;
      for (let dl = -rise; dl <= rise; dl++) {
        const nl = lv + dl;
        if (nl < 0 || nl >= L) continue;
        if (isGoal && nl !== goalLevel) continue;
        const k = classify(ground[j], water[j] === 1, slope[j], nl);
        if (k < 0) continue;
        const steep = dl > 1 || dl < -1 ? (Math.abs(dl) - 1) * STEEP_TIE : 0;
        relax(cur, freeNode(j, nl, d), gc + stepW + KIND_COST[k] + turn + offTie(j, nl) + steep, k, j, nl);
      }
    };
    // crossing into corridor hex j (corridor index oj), entered from side s, from level lv
    const crossMoves = (cur, gc, j, oj, d, s, lv, rise, turn) => {
      if (s === 0 || !canCross(oj)) return;
      for (let dl = -rise; dl <= rise; dl++) {
        const nl = lv + dl;
        if (nl < 0 || nl >= L) continue;
        const over = nl >= O.hi[oj] + CLEAR_LEVELS, under = nl <= O.lo[oj] - CLEAR_LEVELS;
        if (!over && !under) continue;
        let k = classify(ground[j], water[j] === 1, slope[j], nl);
        if (k < 0) continue;
        if (over) { if (k === KIND_IDX.tunnel) continue; k = KIND_IDX.bridge; }
        relax(cur, crossNode(oj, nl, d, s), gc + stepW + KIND_COST[k] + turn + offTie(j, nl) + (under ? UNDER_TIE : 0), k, j, nl);
      }
    };
    const laneCost = (o, l) => stepW + KIND_COST[O.kind[o]] * LANE_FACTOR + LANE_TIE * Math.abs(l);

    const startLevel = ground[ai];
    const sk = classify(ground[ai], false, slope[ai], startLevel);
    const s0 = freeNode(ai, startLevel, 6);
    g[s0] = KIND_COST[sk] + stepW;
    reached[ai] = 1;
    kindOf[s0] = sk;
    heap.push(g[s0] + hMul * Math.max(hDist[ai], Math.ceil(Math.abs(startLevel - goalLevel) / MAX_RISE_LEVELS)), s0);
    let goal = -1;

    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      const gc = g[cur];
      let hi, lv, dir, o = -1, lane = 0, fresh = 0, sIn = 0, kindState; // kindState: 0 free, 1 lane, 2 crossing
      if (cur < NL0) {
        dir = cur % D7;
        const hl = (cur - dir) / D7;
        hi = (hl / L) | 0; lv = hl - hi * L; kindState = 0;
      } else if (cur < NC0) {
        let v = cur - NL0;
        fresh = v & 1; v >>= 1;
        const slot = v % LANE_SLOTS; v = (v - slot) / LANE_SLOTS;
        lane = slot < M ? slot + 1 : -(slot - M + 1);
        dir = v % D7; o = (v - dir) / D7;
        hi = O.hex[o]; lv = O.level[o]; kindState = 1;
      } else if (cur < NS0) {
        let v = cur - NC0;
        sIn = v & 1 ? -1 : 1; v >>= 1;
        dir = v % D7; v = (v - dir) / D7;
        lv = v % L; o = (v - lv) / L;
        hi = O.hex[o]; kindState = 2;
      } else {
        let v = cur - NS0;
        fresh = v & 1; v >>= 1;
        sIn = v & 1 ? -1 : 1; v >>= 1; // here: the route's tangent sign against the trunk's
        dir = v % D7; o = (v - dir) / D7;
        hi = O.hex[o]; lv = O.level[o]; kindState = 3;
      }
      if (hi === bi) { goal = cur; break; }
      for (let d = 0; d < 6; d++) {
        let turn = 0;
        if (dir !== 6) {
          const t = (d - dir + 6) % 6;
          if (t === 3 || (!allowSharp && (t === 2 || t === 4))) continue;
          turn = t === 0 ? 0 : TURN_TIE;
        }
        const j = nbr[hi * 6 + d];
        if (j < 0 || blocked[j]) continue;
        const oj = occ[j];
        const back = (d + 3) % 6;
        const ei = hexEdge[hi * 6 + d];
        if (kindState === 3) {
          if (ei >= 0) { // ride on along the rails
            const e = E[ei];
            if (e.sFrom !== sIn) continue;
            if (j === bi) freeMoves(cur, gc, j, d, lv, MAX_RISE_LEVELS, turn);
            else if (oj >= 0) relax(cur, sharedNode(oj, d, e.sTo, 0), gc + sharedCost(oj) + turn, O.kind[oj], j, O.level[oj]);
          } else if (!fresh && (oj < 0) && canFork(o, O.side[o * 6 + d]) && fitsTrunk(o, d, sIn)) {
            freeMoves(cur, gc, j, d, lv, MAX_RISE_LEVELS, turn); // fork off onto fresh track
          }
          continue;
        }
        if (kindState === 0) {
          if (oj < 0) { freeMoves(cur, gc, j, d, lv, MAX_RISE_LEVELS, turn); continue; }
          const s = O.side[oj * 6 + back];
          if (ei >= 0 && hi === ai) { // out of the station on rails already there
            relax(cur, sharedNode(oj, d, E[ei].sTo, 0), gc + sharedCost(oj) + turn, O.kind[oj], j, O.level[oj]);
          } else if (ei < 0 && canFork(oj, s) && Math.abs(O.level[oj] - lv) <= MAX_RISE_LEVELS) {
            // join the trunk at a junction, curving onto it from the side
            const sg = O.tx[oj] * DIR_W[d].x + O.tz[oj] * DIR_W[d].z >= 0 ? 1 : -1;
            if (fitsTrunk(oj, d, sg)) relax(cur, sharedNode(oj, d, sg, 1), gc + sharedCost(oj) + turn, O.kind[oj], j, O.level[oj]);
          }
          // join the corridor as a lane: from the side (the side it runs on), or out of a station
          // hex the base also leaves from (lanes converge only inside a station hex)
          if (!O.sharp[oj] && Math.abs(O.level[oj] - lv) <= MAX_RISE_LEVELS) {
            const atStation = hi === ai;
            for (let a = 1; a <= M; a++) {
              for (const sg of [1, -1]) {
                const l = sg * a;
                if (s !== 0 && sg !== s) continue;
                if (s === 0 && !atStation) continue;
                // lanes converge in a station only from the first lane: two exits 60 degrees apart
                // leave room for one lane each side between them at the hex edge, not two
                if (s === 0 && a > 1) continue;
                if (!laneFree(oj, l)) continue;
                if (s === 0 ? !canStationTrans(oj, l) : !canSideTrans(oj, l)) continue;
                relax(cur, laneNode(oj, d, l, s === 0 ? 0 : 1), gc + laneCost(oj, l) + turn, O.kind[oj], j, O.level[oj]);
              }
            }
          }
          crossMoves(cur, gc, j, oj, d, s, lv, 1, turn);
        } else if (kindState === 1) {
          const s = O.side[o * 6 + d];
          if (s === 0) {
            // a lane joined from the side may only bend onto the base where the base runs within
            // 60 degrees of the way it came in (else the turn into the lane is a kink)
            if (fresh) {
              const bIn = d === O.hout[o] ? O.hin[o] : (O.hout[o] + 3) % 6;
              if (cyc(dir, bIn) > 1) continue;
            }
            if (j === bi) { // the base ends in the goal station: converge there
              if (Math.abs(lane) === 1 && canStationTrans(o, lane)) freeMoves(cur, gc, j, d, lv, MAX_RISE_LEVELS, turn);
              continue;
            }
            if (oj < 0 || O.rid[oj] !== O.rid[o] || Math.abs(O.idx[oj] - O.idx[o]) !== 1) continue;
            if (O.sharp[oj] || !laneFree(oj, lane) || !canRun(oj, lane)) continue;
            relax(cur, laneNode(oj, d, lane, 0), gc + laneCost(oj, lane) + turn, O.kind[oj], j, O.level[oj]);
          } else if (s === (lane > 0 ? 1 : -1) && !fresh && canSideTrans(o, lane)
            // ...and leave within 60 degrees of the base's own way on (no kink leaving the lane)
            && cyc(d, dir === O.hin[o] ? O.hout[o] : (O.hin[o] + 3) % 6) === 1) {
            if (oj < 0) freeMoves(cur, gc, j, d, lv, MAX_RISE_LEVELS, turn); // split off on its own side
          }
        } else {
          if (O.side[o * 6 + d] !== -sIn) continue; // a crossing leaves on the far side
          if (oj < 0) { freeMoves(cur, gc, j, d, lv, 1, turn); continue; }
          crossMoves(cur, gc, j, oj, d, O.side[oj * 6 + back], lv, 0, turn);
        }
      }
    }
    if (goal < 0) return null;
    const chain = [];
    for (let v = goal; v >= 0; v = prev[v]) chain.push(v);
    chain.reverse();
    const steps = chain.map((v) => {
      if (v < NL0) {
        const hl = (v - (v % D7)) / D7;
        const h = (hl / L) | 0;
        return { hex: h, level: hl - h * L, mode: 'free', kind: KINDS[kindOf[v]] };
      }
      if (v < NC0) {
        let x = (v - NL0) >> 1;
        const slot = x % LANE_SLOTS; x = (x - slot) / LANE_SLOTS;
        const o = (x - (x % D7)) / D7;
        return { hex: O.hex[o], level: O.level[o], mode: 'lane', lane: slot < M ? slot + 1 : -(slot - M + 1), kind: KINDS[O.kind[o]], baseRid: O.rid[o], baseIdx: O.idx[o] };
      }
      if (v < NS0) {
        let x = (v - NC0) >> 1;
        x = (x - (x % D7)) / D7;
        const lvl = x % L, o = (x - lvl) / L;
        return { hex: O.hex[o], level: lvl, mode: 'cross', kind: KINDS[kindOf[v]], over: lvl > O.level[o], under: lvl < O.level[o] };
      }
      let x = v - NS0;
      const fr = x & 1; x >>= 1;
      const sg = x & 1 ? -1 : 1; x >>= 1;
      const o = (x - (x % D7)) / D7;
      return { hex: O.hex[o], o, level: O.level[o], mode: 'shared', kind: KINDS[O.kind[o]], sg, fresh: fr, baseRid: O.rid[o], baseIdx: O.idx[o] };
    });
    // rails ridden (the polyline to copy) and the sides forks curve across
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1], b = steps[i];
      const d = HEX_DIRS.findIndex((x) => R.hexes[a.hex].q + x.q === R.hexes[b.hex].q && R.hexes[a.hex].r + x.r === R.hexes[b.hex].r);
      const ei = hexEdge[a.hex * 6 + d];
      if (ei >= 0 && ((b.mode === 'shared' && !b.fresh) || (i === steps.length - 1 && a.mode === 'shared'))) b.edgeIn = E[ei];
      if (b.mode === 'shared' && !b.edgeIn) b.forkSides = (b.forkSides || 0) | (O.side[b.o * 6 + (d + 3) % 6] > 0 ? 1 : 2);
      if (a.mode === 'shared' && !b.edgeIn) a.forkSides = (a.forkSides || 0) | (O.side[a.o * 6 + d] > 0 ? 1 : 2);
    }
    return finishSteps(R, steps);
  }

  /** Hex coordinates, headings, station ends, lane join/leave kinds. */
  function finishSteps(R, steps) {
    const n = steps.length;
    const out = steps.map((s) => ({ ...s, q: R.hexes[s.hex].q, r: R.hexes[s.hex].r }));
    const dirTo = (a, b) => HEX_DIRS.findIndex((d) => a.q + d.q === b.q && a.r + d.r === b.r);
    for (let i = 0; i < n; i++) {
      const s = out[i];
      delete s.hex;
      s.hin = i > 0 ? dirTo(out[i - 1], s) : -1;
      s.hout = i + 1 < n ? dirTo(s, out[i + 1]) : -1;
    }
    out[0].mode = 'station';
    out[n - 1].mode = 'station';
    for (let i = 0; i < n; i++) {
      const s = out[i];
      if (s.mode !== 'lane') continue;
      const kinds = [];
      for (const nb of [out[i - 1], out[i + 1]]) {
        if (nb.mode === 'lane') continue;
        kinds.push(nb.mode === 'station' && alongBase(s, nb) ? 'station' : 'side');
      }
      s.trans = kinds.includes('side') ? 'side' : kinds.length ? 'station' : null;
    }
    return out;
  }

  /** Is hex nb where this lane step's base comes from or goes to? */
  function alongBase(s, nb) {
    const bs = store.route(s.baseRid).steps;
    return [bs[s.baseIdx - 1], bs[s.baseIdx + 1]].some((x) => x && x.q === nb.q && x.r === nb.r);
  }

  function makeRoute(from, to, style, steps) {
    const hexes = steps.map((s) => {
      const h = { q: s.q, r: s.r, kind: s.kind };
      if (s.mode === 'lane') h.lane = s.lane;
      if (s.mode === 'cross') { if (s.over) h.over = true; else h.under = true; }
      if (s.mode === 'shared') h.shared = true;
      return h;
    });
    const points = buildPlanPoints(steps, store);
    const route = { from, to, style, hexes, points, length: 0, cost: Math.round(costOf(steps)) };
    route.length = routeLength(route);
    plans.set(route, { steps, version: store.version });
    return route;
  }

  function sameSteps(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x.q !== y.q || x.r !== y.r || x.kind !== y.kind || x.level !== y.level || x.mode !== y.mode || (x.lane || 0) !== (y.lane || 0) || !!x.edgeIn !== !!y.edgeIn) return false;
    }
    return true;
  }

  function costOf(steps) {
    let c = 0;
    for (const s of steps) c += hexPrice({ kind: s.kind, lane: s.mode === 'lane' ? s.lane : 0, shared: s.mode === 'shared' });
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
    // Guarantees (tie-breaks can blur them): cheap never costs more, direct never longer.
    // ties collapse to one route so the player is not offered two equal choices.
    if (costOf(direct) <= costOf(cheap)) cheap = direct;
    if (cheap.length <= direct.length) direct = cheap;
    const same = sameSteps(cheap, direct);
    const cheapRoute = makeRoute(fromTitle, toTitle, 'cheap', cheap);
    return {
      cheap: cheapRoute,
      direct: makeRoute(fromTitle, toTitle, 'direct', same ? cheap : direct),
      same,
    };
  }

  /** The search plan behind a route this router made, if it is still current. */
  function planOf(route) {
    return plans.get(route) || null;
  }

  return { findRoutes, planOf, store };
}

// ---- centreline -------------------------------------------------------------------

/**
 * Uniform Catmull-Rom through the hex centres (x, z) and rail heights (y), POINTS_PER_HEX
 * samples per hex step. Hex centres are equally spaced so this is C1 smooth with no kinks
 * and passes exactly through every centre, including both station centres. (No lanes.)
 */
export function buildPoints(steps) {
  return buildPlanPoints(steps.map((s, i) => ({ ...s, mode: i === 0 || i === steps.length - 1 ? 'station' : 'free' })), null);
}

/** Cyclic distance between two headings, in 60-degree steps. */
const cyc = (a, b) => { const t = (a - b + 6) % 6; return t > 3 ? 6 - t : t; };
const smooth01 = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
function hermite(p0, m0, p1, m1, t) {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
}
const clampTo = (v, a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b); return v < lo ? lo : v > hi ? hi : v; };

/** Unit horizontal tangent of a polyline at point k (towards higher indices). */
function tangentAt(pts, k) {
  const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}
/** Point k of a base polyline moved `off` world units to its right (+N). */
function offsetPoint(pts, k, off) {
  const p = pts[k], t = tangentAt(pts, k);
  return { x: p.x - t.z * off, y: p.y, z: p.z + t.x * off };
}

/**
 * The route centreline. Free and crossing hexes: Catmull-Rom through hex centres. Lane hexes:
 * the base track's own polyline moved sideways by lane x laneSpacing (truly parallel, round
 * curves too). Joining or leaving a lane from the side: a cubic Hermite over that hex step,
 * matching position and tangent at both ends (no kinks). Converging with the base in a station
 * hex: the base polyline with the offset eased in over the station's half of the step. Crossing
 * hexes: the rail is level over the middle of the hex and ramps in the outer part of the steps.
 */
export function buildPlanPoints(steps, store) {
  const n = steps.length;
  const C = steps.map((s) => {
    const w = hexToWorld(s.q, s.r);
    return { x: w.x, y: s.level * ELEV_STEP, z: w.z };
  });
  if (n === 1) return [{ ...C[0], kind: steps[0].kind }];
  // lane hexes: control point = the base's point moved sideways; travel tangent along the route
  const lane = steps.map((s, i) => {
    if (s.mode !== 'lane') return null;
    const bp = store.route(s.baseRid).points;
    const k = s.baseIdx * POINTS_PER_HEX;
    const off = s.lane * LANE_SPACING;
    const p = offsetPoint(bp, k, off);
    const t = tangentAt(bp, k);
    const ahead = C[Math.min(n - 1, i + 1)], behind = C[Math.max(0, i - 1)];
    const sgn = t.x * (ahead.x - behind.x) + t.z * (ahead.z - behind.z) >= 0 ? 1 : -1;
    C[i] = { x: p.x, y: p.y, z: p.z };
    return { bp, k, off, sgn, tx: t.x * sgn, tz: t.z * sgn };
  });
  const tanAt = (i) => { // Catmull-Rom tangent at control point i (per hex step), mirrored at the ends
    const a = C[Math.max(0, i - 1)], b = C[Math.min(n - 1, i + 1)];
    const f = i === 0 || i === n - 1 ? 1 : 0.5;
    return { x: (b.x - a.x) * f, y: (b.y - a.y) * f, z: (b.z - a.z) * f };
  };
  const baseYSlope = (ln) => { // dy per hex step along the route at a lane control point
    const { bp, k, sgn } = ln;
    const a = bp[Math.max(0, k - sgn)], b = bp[Math.min(bp.length - 1, Math.max(0, k + sgn))];
    return (b.y - a.y) * POINTS_PER_HEX / 2;
  };
  const pts = [];
  for (let i = 0; i < n - 1; i++) {
    const A = steps[i], B = steps[i + 1], la = lane[i], lb = lane[i + 1];
    const kindAt = (k) => (k < POINTS_PER_HEX / 2 ? A.kind : B.kind);
    if (B.edgeIn) {
      // on rails already there: the very polyline of the track laid first
      const e = B.edgeIn, rp = store.route(e.rid).points;
      for (let k = 0; k < POINTS_PER_HEX; k++) { const p = rp[e.k + e.step * k]; pts.push({ x: p.x, y: p.y, z: p.z, kind: kindAt(k) }); }
    } else if (B.mode === 'shared' || A.mode === 'shared') {
      // a junction: curve onto (B) or off (A) the trunk, tangent to it at the hex centre
      const trunk = (st) => {
        const bp = store.route(st.baseRid).points, k = st.baseIdx * POINTS_PER_HEX, t = tangentAt(bp, k);
        const a = bp[Math.max(0, k - 1)], b = bp[Math.min(bp.length - 1, k + 1)];
        return { x: t.x * st.sg * HEX_STEP, z: t.z * st.sg * HEX_STEP, y: (b.y - a.y) * st.sg * POINTS_PER_HEX / 2 };
      };
      const P0 = C[i], P1 = C[i + 1];
      const M0 = A.mode === 'shared' ? trunk(A) : tanAt(i), M1 = B.mode === 'shared' ? trunk(B) : tanAt(i + 1);
      for (let k = 0; k < POINTS_PER_HEX; k++) {
        const t = k / POINTS_PER_HEX;
        pts.push({
          x: hermite(P0.x, M0.x, P1.x, M1.x, t),
          y: clampTo(hermite(P0.y, M0.y, P1.y, M1.y, t), P0.y, P1.y),
          z: hermite(P0.z, M0.z, P1.z, M1.z, t),
          kind: kindAt(k),
        });
      }
    } else if (la && lb && A.baseRid === B.baseRid && A.lane === B.lane) {
      // running beside the base: its polyline, moved sideways
      for (let k = 0; k < POINTS_PER_HEX; k++) pts.push({ ...offsetPoint(la.bp, la.k + la.sgn * k, la.off), kind: kindAt(k) });
    } else if (!la && lb && A.mode === 'station' && store && stationAlong(store, B, A)) {
      // out of a station hex beside the base: the base polyline, the offset eased in by the hex edge
      const ks = lb.k - lb.sgn * POINTS_PER_HEX;
      for (let k = 0; k < POINTS_PER_HEX; k++) {
        const w = smooth01(k / POINTS_PER_HEX / 0.5);
        pts.push({ ...offsetPoint(lb.bp, ks + lb.sgn * k, lb.off * w), kind: kindAt(k) });
      }
    } else if (la && !lb && B.mode === 'station' && store && stationAlong(store, A, B)) {
      for (let k = 0; k < POINTS_PER_HEX; k++) {
        const w = smooth01((1 - k / POINTS_PER_HEX) / 0.5);
        pts.push({ ...offsetPoint(la.bp, la.k + la.sgn * k, la.off * w), kind: kindAt(k) });
      }
    } else if (la || lb) {
      // joining (lb) or leaving (la) a lane from the side: Hermite matching both tangents
      const P0 = C[i], P1 = C[i + 1];
      const M0 = la ? { x: la.tx * HEX_STEP, z: la.tz * HEX_STEP } : tanAt(i);
      const M1 = lb ? { x: lb.tx * HEX_STEP, z: lb.tz * HEX_STEP } : tanAt(i + 1);
      const my0 = la ? baseYSlope(la) : tanAt(i).y, my1 = lb ? baseYSlope(lb) : tanAt(i + 1).y;
      for (let k = 0; k < POINTS_PER_HEX; k++) {
        const t = k / POINTS_PER_HEX;
        pts.push({
          x: hermite(P0.x, M0.x, P1.x, M1.x, t),
          y: clampTo(hermite(P0.y, my0, P1.y, my1, t), P0.y, P1.y),
          z: hermite(P0.z, M0.z, P1.z, M1.z, t),
          kind: kindAt(k),
        });
      }
    } else {
      const p0 = C[Math.max(0, i - 1)], p1 = C[i], p2 = C[i + 1], p3 = C[Math.min(n - 1, i + 2)];
      // mirror the end tangents so the curve leaves/enters the stations straight
      const a = i === 0 ? mirror(p2, p1) : p0;
      const d = i + 2 >= n ? mirror(p1, p2) : p3;
      for (let k = 0; k < POINTS_PER_HEX; k++) {
        const t = k / POINTS_PER_HEX;
        pts.push({ x: cr(a.x, p1.x, p2.x, d.x, t), y: crY(a.y, p1.y, p2.y, d.y, t), z: cr(a.z, p1.z, p2.z, d.z, t), kind: kindAt(k) });
      }
    }
  }
  const last = C[n - 1];
  pts.push({ x: last.x, y: last.y, z: last.z, kind: steps[n - 1].kind });
  pts[0].x = C[0].x; pts[0].y = C[0].y; pts[0].z = C[0].z;
  // crossings: a level deck over the middle of the hex, the ramp squeezed into the rest of the step
  const isX = (i) => i >= 0 && i < n && steps[i].mode === 'cross';
  const slopeY = (i) => tanAt(i).y;
  for (let i = 0; i < n; i++) {
    if (!isX(i)) continue;
    const Y = C[i].y, c = i * POINTS_PER_HEX;
    for (let k = -DECK_POINTS; k <= DECK_POINTS; k++) if (c + k >= 0 && c + k < pts.length) pts[c + k].y = Y;
    const span = (POINTS_PER_HEX - DECK_POINTS) / POINTS_PER_HEX;
    if (i + 1 < n && !isX(i + 1)) {
      const Y1 = C[i + 1].y, m1 = slopeY(i + 1) * span;
      for (let k = DECK_POINTS + 1; k < POINTS_PER_HEX; k++) {
        const u = (k - DECK_POINTS) / (POINTS_PER_HEX - DECK_POINTS);
        pts[c + k].y = clampTo(hermite(Y, 0, Y1, m1, u), Y, Y1);
      }
    }
    if (i > 0 && !isX(i - 1)) {
      const Y0 = C[i - 1].y, m0 = slopeY(i - 1) * span, c0 = (i - 1) * POINTS_PER_HEX;
      for (let k = 1; k < POINTS_PER_HEX - DECK_POINTS; k++) {
        const u = k / (POINTS_PER_HEX - DECK_POINTS);
        pts[c0 + k].y = clampTo(hermite(Y0, m0, Y, 0, u), Y0, Y);
      }
    }
  }
  return pts;
}

/** Does lane step s's base run into station hex st (so the lane converges with it there)? */
function stationAlong(store, s, st) {
  const bs = store.route(s.baseRid).steps;
  return [bs[s.baseIdx - 1], bs[s.baseIdx + 1]].some((x) => x && x.q === st.q && x.r === st.r);
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
