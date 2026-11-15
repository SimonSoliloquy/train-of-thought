// Where tracks lie relative to one another: a spatial index over every built track's
// centreline, and the pure questions the track builder, the terrain grading and the upgrade
// tags ask of it (is a neighbouring lane beside me? is another track under this bridge?).
// Pure: no three.js, no DOM. Heights of resampled points (S) are lifted by RAIL_LIFT; the network keeps raw route heights.
import { RAIL_LIFT } from './rail.js';

export const LANES = {
  sameLevel: 0.3,      // two rails this close in height are side by side, not one over the other
  pierClear: 0.6,      // no pier or abutment stands closer than this to another track's centreline
  reach: 0.62,         // how far sideways a neighbouring lane is looked for when shaping a bed
};

const CELL = 1;

/** Spatial index of the polylines of built tracks, by track id. */
export class Network {
  constructor() {
    this.entries = new Map(); // id -> {id, rank, segs}
    this.cells = new Map();   // "cx,cz" -> segs
    this.counter = 0;
    this.stamp = 0;
    this.version = 0; // bumps whenever a track is added, replaced or removed
  }

  /** Add or replace the centreline of track id. Rank is the order tracks were first added. */
  set(id, route) {
    this.version++;
    const old = this.entries.get(id);
    const rank = old ? old.rank : this.counter++;
    if (old) this._unlink(old);
    const pts = (route && route.points) || [];
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      segs.push({ id, ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, ka: a.kind || 'ground', kb: b.kind || 'ground', stamp: 0 });
    }
    const entry = { id, rank, segs };
    for (const s of segs) {
      const x0 = Math.floor(Math.min(s.ax, s.bx) / CELL), x1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
      const z0 = Math.floor(Math.min(s.az, s.bz) / CELL), z1 = Math.floor(Math.max(s.az, s.bz) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = `${cx},${cz}`;
          let arr = this.cells.get(k);
          if (!arr) { arr = []; this.cells.set(k, arr); }
          arr.push(s);
        }
      }
    }
    this.entries.set(id, entry);
  }

  _unlink(entry) {
    const dead = new Set(entry.segs);
    for (const [k, arr] of this.cells) {
      const keep = arr.filter((s) => !dead.has(s));
      if (keep.length) this.cells.set(k, keep); else this.cells.delete(k);
    }
  }

  delete(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.version++;
    this._unlink(e);
    this.entries.delete(id);
  }

  has(id) { return this.entries.has(id); }
  rank(id) { const e = this.entries.get(id); return e ? e.rank : Infinity; }
  get size() { return this.entries.size; }

  /** Call fn(seg) once for each segment of any track but excludeId that may lie within r of (x, z). */
  query(x, z, r, excludeId, fn) {
    const st = ++this.stamp;
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.cells.get(`${cx},${cz}`);
        if (!arr) continue;
        for (const s of arr) {
          if (s.stamp === st || s.id === excludeId) continue;
          s.stamp = st;
          fn(s);
        }
      }
    }
  }
}

/** Horizontal distance from (x, z) to a segment, with the rail height and kind at the nearest point. */
function nearestOnSeg(s, x, z) {
  const dx = s.bx - s.ax, dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-12 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(s.ax + dx * t - x, s.az + dz * t - z), y: s.ay + (s.by - s.ay) * t, kind: t < 0.5 ? s.ka : s.kb };
}

/** Points closer than this (and as high) to an earlier track's centreline run on its rails. */
export const SHARE_TOL = 0.03;

/** Whether (x, z, raw rail height y) lies on the centreline of a track added before selfId. */
export function onEarlierRails(net, selfId, x, z, y) {
  if (!net || !net.size) return false;
  const mine = net.rank(selfId);
  let hit = false;
  net.query(x, z, SHARE_TOL, selfId, (s) => {
    if (hit || !(net.rank(s.id) < mine)) return;
    const n = nearestOnSeg(s, x, z);
    if (n.d <= SHARE_TOL && Math.abs(n.y - y) < 0.08) hit = true;
  });
  return hit;
}

/**
 * Per segment of the resampled route S (heights lifted by RAIL_LIFT): true where both ends lie on the rails of
 * an earlier track. Those stretches are drawn once, by the earlier track. Pure.
 */
export function sharedSegments(S, net, selfId) {
  const on = S.map((P) => onEarlierRails(net, selfId, P.x, P.z, P.y - RAIL_LIFT));
  const out = [];
  for (let i = 0; i + 1 < S.length; i++) out.push(on[i] && on[i + 1]);
  return out;
}

/**
 * Nearest other track to (x, z) within r (horizontally). opts.below: only tracks whose rail there lies
 * below this height. Returns {d, y, id, kind} or null.
 */
export function nearestOther(net, excludeId, x, z, r, opts = {}) {
  if (!net) return null;
  // the nearest point of each other track decides whether it is beneath: a track running beside this
  // one on a steep grade has points further along that are lower, but those are not under anything
  const per = new Map();
  net.query(x, z, r, excludeId, (s) => {
    const n = nearestOnSeg(s, x, z);
    if (n.d > r) return;
    const cur = per.get(s.id);
    if (!cur || n.d < cur.d) per.set(s.id, { d: n.d, y: n.y, id: s.id, kind: n.kind });
  });
  let best = null;
  const below = opts.below;
  for (const v of per.values()) {
    if (Number.isFinite(below) && !(v.y < below)) continue;
    if (!best || v.d < best.d) best = v;
  }
  return best;
}

/**
 * Other tracks seen sideways from P (a resampled point with tx, tz, rx, rz): where each crosses the
 * line through P at right angles to the track. lat < 0 is on the -r side. dy = their rail minus y.
 * @returns {{lat:number, dy:number, id:any, kind:string}[]}
 */
export function lateralHits(net, excludeId, P, y, reach = LANES.reach) {
  const out = [];
  if (!net) return out;
  net.query(P.x, P.z, reach, excludeId, (s) => {
    const a1 = (s.ax - P.x) * P.tx + (s.az - P.z) * P.tz;
    const a2 = (s.bx - P.x) * P.tx + (s.bz - P.z) * P.tz;
    if ((a1 > 0 && a2 > 0) || (a1 < 0 && a2 < 0) || Math.abs(a1 - a2) < 1e-9) return;
    const f = a1 / (a1 - a2);
    const l1 = (s.ax - P.x) * P.rx + (s.az - P.z) * P.rz;
    const l2 = (s.bx - P.x) * P.rx + (s.bz - P.z) * P.rz;
    const lat = l1 + (l2 - l1) * f;
    if (Math.abs(lat) > reach) return;
    out.push({ lat, dy: s.ay + (s.by - s.ay) * f - y, id: s.id, kind: f < 0.5 ? s.ka : s.kb });
  });
  return out;
}

/** Distance to the nearest neighbour on each side among hits at about the same height. */
export function sideGaps(hits, dyMax = LANES.sameLevel) {
  let left = Infinity, right = Infinity;
  for (const h of hits) {
    if (Math.abs(h.dy) > dyMax) continue;
    if (h.lat < 0) left = Math.min(left, -h.lat); else right = Math.min(right, h.lat);
  }
  return { left, right };
}

/** Half the gap to a neighbour (where two beds meet), never so small that a bed vanishes. */
export function halfGap(d, floor = 0.1) { return d === Infinity ? Infinity : Math.max(floor, d / 2); }

/**
 * Where to put an upgrade tag on route (points) so it floats over its own stretch: sampled along the
 * route, preferring places where no other track runs close and no other tag already hangs, near
 * the middle. Returns the chosen t in [0, 1].
 * @param {{x:number,z:number}[]} pts  route.points
 * @param {Network|null} net
 * @param {any} selfId
 * @param {{x:number,z:number}[]} taken  anchors of tags already placed
 */
export function tagParameter(pts, net, selfId, taken = [], cum = null) {
  if (!pts || pts.length < 2) return 0.5;
  if (!cum) {
    cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  const total = cum[cum.length - 1] || 1;
  const at = (t) => {
    const d = t * total;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    const a = pts[lo], b = pts[Math.min(lo + 1, pts.length - 1)];
    const seg = cum[Math.min(lo + 1, cum.length - 1)] - cum[lo];
    const f = seg > 0 ? (d - cum[lo]) / seg : 0;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  };
  let best = 0.5, bestScore = -Infinity;
  for (let k = 0; k <= 30; k++) {
    const t = 0.12 + (k / 30) * 0.76;
    const p = at(t);
    const o = nearestOther(net, selfId, p.x, p.z, 1.5);
    const dOther = o ? o.d : 1.5;
    let dTag = 1.8;
    for (const q of taken) dTag = Math.min(dTag, Math.hypot(q.x - p.x, q.z - p.z));
    const score = (dOther >= 1.0 ? 10 : 0) + Math.min(dOther, 1.0) * 3 + Math.min(dTag, 1.8) * 2.5 - Math.abs(t - 0.5) * 1.5;
    if (score > bestScore + 1e-9) { bestScore = score; best = t; }
  }
  return best;
}

/**
 * Where a bridge may stand on the ground. Pure: no pier within LANES.pierClear of another track's centreline
 * that lies beneath the deck (the crossing span is left clear, with an abutment on the first free spot
 * either side); beside a parallel bridge at the same height only the lowest-ranked track builds a pier, wide
 * enough to carry them all.
 * @param {{S: object[], kinds: string[], buried: boolean[], groundAt: Function, net: Network|null, selfId: any, pierEvery: number}} a
 * @returns {{i:number, type:'pier'|'abutment', dir:number, oc:number, wk:number}[]}
 */
export function planSupports({ S, kinds, buried, groundAt, net, selfId, pierEvery = 0.6, shared = null }) {
  const out = [];
  const n = S.length - 1;
  const isBr = (i) => i >= 0 && i < n && kinds[i] === 'bridge' && !buried[i] && !(shared && shared[i]);
  const blocked = new Array(n).fill(false);
  if (net && net.size) {
    for (let i = 0; i < n; i++) {
      if (!isBr(i)) continue;
      const o = nearestOther(net, selfId, S[i].x, S[i].z, LANES.pierClear, { below: S[i].y - RAIL_LIFT - LANES.sameLevel });
      blocked[i] = !!o && o.d < LANES.pierClear;
    }
  }
  let lastPier = -Infinity;
  const mine = net ? net.rank(selfId) : 0;
  const myRank = Number.isFinite(mine) ? mine : Infinity;
  for (let i = 0; i < n; i++) {
    if (!isBr(i) || blocked[i]) continue;
    const A = S[i];
    const g = groundAt(A.x, A.z);
    if (!Number.isFinite(g)) continue;
    const before = isBr(i - 1) && blocked[i - 1], after = isBr(i + 1) && blocked[i + 1];
    if (before || after) {
      out.push({ i, type: 'abutment', dir: after ? 1 : -1, oc: 0, wk: 1 });
      lastPier = A.s;
      continue;
    }
    const tall = A.y - g > 2.3;
    if (A.s - lastPier < (tall ? pierEvery * 2 : pierEvery)) continue;
    lastPier = A.s;
    let lo = 0, hi = 0, yield_ = false;
    if (net && net.size) {
      for (const h of lateralHits(net, selfId, A, A.y - RAIL_LIFT, 0.9)) {
        if (Math.abs(h.dy) > LANES.sameLevel || h.kind !== 'bridge') continue;
        if (net.rank(h.id) < myRank) yield_ = true;
        lo = Math.min(lo, h.lat); hi = Math.max(hi, h.lat);
      }
    }
    if (yield_) continue;
    out.push({ i, type: 'pier', dir: 0, oc: (lo + hi) / 2, wk: Math.min(3, (hi - lo + 0.36) / 0.36) });
  }
  return out;
}

/** Per bridge segment, how close it is to a crossing span (1 over the lower track, 0 well clear). */
export function spanWeights(S, kinds, buried, net, selfId) {
  const n = S.length - 1;
  const w = new Array(n).fill(0);
  if (!net || !net.size) return w;
  const hit = [];
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== 'bridge' || buried[i]) continue;
    const o = nearestOther(net, selfId, S[i].x, S[i].z, LANES.pierClear, { below: S[i].y - RAIL_LIFT - LANES.sameLevel });
    if (o && o.d < LANES.pierClear) hit.push(i);
  }
  for (const h of hit) {
    for (let k = -6; k <= 6; k++) {
      const i = h + k;
      if (i >= 0 && i < n && kinds[i] === 'bridge') w[i] = Math.max(w[i], 1 - Math.abs(k) / 7);
    }
  }
  return w;
}
