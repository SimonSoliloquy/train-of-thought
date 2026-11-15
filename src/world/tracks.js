// Built track, hex by hex: which committed route runs through each hex's centre (the corridor's
// first track, its "base"), its rail level and direction of travel, the parallel lanes beside it,
// and the one track that may cross it at a different height. The router reads this to lay new
// track beside old (combine and split) or over / under it, never on top of it.

import { WORLD } from '../config.js';
import { HEX_DIRS, hexToWorld, worldToHex } from '../hex.js';
import { ELEV_STEP } from './terrain.js';
import { tileKey } from './terrain.js';

export const MAX_LANES = WORLD.maxLanesPerSide;
/** Levels of rail height a crossing must clear (WORLD.crossingClearance). */
export const CLEAR_LEVELS = Math.ceil(WORLD.crossingClearance / ELEV_STEP - 1e-9);

const DIR_W = HEX_DIRS.map((d) => hexToWorld(d.q, d.r));

/**
 * Side of each neighbour direction relative to a track that enters a hex heading `hin` and
 * leaves heading `hout`: 0 along the track (where it came from / goes to), +1 to its right,
 * -1 to its left. "Right" is +N with N = (-Tz, Tx) for the travel direction T, the same
 * normal the lane offset uses, so lane +n lies on side +1.
 */
export function sidesOf(hin, hout) {
  const tx = DIR_W[hin].x + DIR_W[hout].x, tz = DIR_W[hin].z + DIR_W[hout].z;
  const nx = -tz, nz = tx;
  const out = new Int8Array(6);
  for (let d = 0; d < 6; d++) {
    if (d === hout || d === (hin + 3) % 6) { out[d] = 0; continue; }
    const s = nx * DIR_W[d].x + nz * DIR_W[d].z;
    out[d] = s > 1e-9 ? 1 : s < -1e-9 ? -1 : 0;
  }
  return out;
}

export const laneSlot = (l) => (l > 0 ? l - 1 : MAX_LANES - l - 1);

export function createTrackStore() {
  /** tileKey -> hex record */
  const hexes = new Map();
  /** rid -> { points, steps } */
  const routes = [];
  let version = 0;

  function rec(k) {
    let r = hexes.get(k);
    if (!r) {
      r = { base: null, lanes: new Map(), cross: -1, maxY: -Infinity, minY: Infinity, sum: null, edges: new Map(), forks: 0 };
      hexes.set(k, r);
    }
    return r;
  }

  /** Derived numbers the router needs, recomputed when the hex changes. */
  function summarise(r) {
    const s = {
      laneMask: 0, outer: [0, 0], sideTrans: [0, 0], minSideTrans: [99, 99], anyTrans: r.forks !== 0, forks: r.forks,
      cross: r.cross >= 0,
      hi: Number.isFinite(r.maxY) ? Math.ceil(r.maxY / ELEV_STEP - 1e-6) : -99,
      lo: Number.isFinite(r.minY) ? Math.floor(r.minY / ELEV_STEP + 1e-6) : 99,
    };
    for (const [l, e] of r.lanes) {
      const si = l > 0 ? 0 : 1, a = Math.abs(l);
      s.laneMask |= 1 << laneSlot(l);
      s.outer[si] = Math.max(s.outer[si], a);
      if (e.trans) s.anyTrans = true;
      if (e.trans === 'side') { s.sideTrans[si] = 1; s.minSideTrans[si] = Math.min(s.minSideTrans[si], a); }
    }
    r.sum = s;
  }

  /** Is a plan (router steps) still legal on the current network? */
  function valid(steps) {
    for (const st of steps) {
      if (st.mode === 'station') continue;
      const r = hexes.get(tileKey(st.q, st.r));
      const base = r && r.base;
      if (st.mode === 'free') { if (base) return false; continue; }
      if (!base) return false;
      const s = r.sum;
      if (st.mode === 'shared') { if (st.forkSides && s.cross) return false; continue; }
      if (st.mode === 'lane') {
        if (base.rid !== st.baseRid || base.idx !== st.baseIdx) return false;
        if (s.laneMask & (1 << laneSlot(st.lane))) return false;
        const si = st.lane > 0 ? 0 : 1, a = Math.abs(st.lane);
        if (s.sideTrans[si] && s.minSideTrans[si] < a) return false;
        if (st.trans && (s.cross || s.sideTrans[si])) return false;
        if (s.forks & (si ? 2 : 1)) return false;
        if (st.trans === 'side' && s.outer[si] > a) return false;
      } else if (st.mode === 'cross') {
        if (s.cross || s.anyTrans) return false;
        if (st.over ? st.level < s.hi + CLEAR_LEVELS : st.level > s.lo - CLEAR_LEVELS) return false;
      }
    }
    return true;
  }

  /**
   * Records a route. steps: {q, r, level, kind, mode: 'station'|'free'|'lane'|'cross', lane,
   * trans, hin, hout}; points: its centreline. Returns the route id.
   */
  function commit(steps, points) {
    const rid = routes.length;
    routes.push({ points, steps });
    version++;
    const touched = new Set();
    steps.forEach((st, i) => {
      if (st.mode === 'station') return;
      const k = tileKey(st.q, st.r);
      const r = rec(k);
      touched.add(r);
      if (st.mode === 'free') {
        if (r.base) return; // stale plan over a hex taken meanwhile: keep the first track as base
        const sharp = st.hin !== st.hout && (st.hout - st.hin + 6) % 6 !== 1 && (st.hout - st.hin + 6) % 6 !== 5;
        r.base = { rid, idx: i, hin: st.hin, hout: st.hout, level: st.level, kind: st.kind, sharp, side: sidesOf(st.hin, st.hout) };
      } else if (st.mode === 'lane') {
        if (!r.lanes.has(st.lane)) r.lanes.set(st.lane, { rid, trans: st.trans || null });
      } else if (st.mode === 'cross') {
        if (r.cross < 0) r.cross = rid;
      } else if (st.mode === 'shared') {
        r.forks |= st.forkSides || 0;
      }
    });
    // centreline links: where this route runs hex centre to hex centre on its own or shared rails,
    // later routes may ride the same polyline (shared rails); the first link in a direction stays
    const centre = (st) => st.mode === 'station' || st.mode === 'free' || st.mode === 'shared';
    const signAt = (i) => {
      const r = hexes.get(tileKey(steps[i].q, steps[i].r));
      const b = r && r.base;
      if (!b || steps[i].mode === 'station') return 1;
      const k = Math.min(points.length - 1, i * 8);
      const a = points[Math.max(0, k - 1)], c = points[Math.min(points.length - 1, k + 1)];
      const tx = DIR_W[b.hin].x + DIR_W[b.hout].x, tz = DIR_W[b.hin].z + DIR_W[b.hout].z;
      return (c.x - a.x) * tx + (c.z - a.z) * tz >= 0 ? 1 : -1;
    };
    for (let i = 0; i + 1 < steps.length; i++) {
      const A = steps[i], B = steps[i + 1];
      if (!centre(A) || !centre(B)) continue;
      const d = HEX_DIRS.findIndex((x) => A.q + x.q === B.q && A.r + x.r === B.r);
      const sa = signAt(i), sb = signAt(i + 1);
      const ra = rec(tileKey(A.q, A.r)), rb = rec(tileKey(B.q, B.r));
      if (!ra.edges.has(d)) ra.edges.set(d, { rid, k: i * 8, step: 1, sFrom: sa, sTo: sb });
      if (!rb.edges.has((d + 3) % 6)) rb.edges.set((d + 3) % 6, { rid, k: (i + 1) * 8, step: -1, sFrom: -sb, sTo: -sa });
      touched.add(ra); touched.add(rb);
    }
    for (const p of points) {
      const h = worldToHex(p.x, p.z);
      const r = rec(tileKey(h.q, h.r));
      if (p.y > r.maxY) r.maxY = p.y;
      if (p.y < r.minY) r.minY = p.y;
      touched.add(r);
    }
    for (const r of touched) summarise(r);
    return rid;
  }

  return {
    get: (q, r) => hexes.get(tileKey(q, r)),
    route: (rid) => routes[rid],
    commit,
    valid,
    get version() { return version; },
  };
}
