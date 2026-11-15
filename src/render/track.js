// Track geometry along a Route centreline: ballast, sleepers, rails; bridge decks
// with piers/trestles; tunnel portals; ledge retaining walls. Also the floating
// ribbons for route previews and line highlights. Pure (three math only).
import { MeshBuilder, rgb, shade, mix } from './builder.js';
import { sampleRoute, routeLength, RAIL_LIFT } from './rail.js';
import { TRACK_COLORS as C, ROUTE_PREVIEW } from './palette.js';
import { LANES, sharedSegments, onEarlierRails, lateralHits, sideGaps, halfGap, nearestOther, planSupports, spanWeights } from './lanes.js';

export const TRACK = {
  step: 0.13,
  gauge: 0.17,      // rail centre to rail centre
  railW: 0.024,
  railH: 0.03,
  sleeperLen: 0.32,
  sleeperW: 0.05,
  ballastTop: 0.19,
  ballastBottom: 0.27,
  pierEvery: 0.6,
};

/**
 * Resample the route evenly by arc length.
 * @returns {{x,y,z,s,kind,tx,tz,rx,rz}[]}  s: arc length; t: horizontal unit tangent; r: horizontal side vector
 */
export function resample(route, step = TRACK.step) {
  const L = routeLength(route);
  if (!(L > 0)) {
    const p = route && route.points && route.points[0];
    return p ? [{ x: p.x, y: p.y, z: p.z, s: 0, kind: p.kind || 'ground', tx: 1, tz: 0, rx: 0, rz: 1 }] : [];
  }
  const n = Math.max(2, Math.ceil(L / step) + 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * L;
    const p = sampleRoute(route, s / L);
    out.push({ x: p.x, y: p.y, z: p.z, s, kind: p.kind || 'ground', tx: p.dx, tz: p.dz, rx: 0, rz: 0 });
  }
  // smooth horizontal tangents from neighbours
  for (let i = 0; i < n; i++) {
    const a = out[Math.max(0, i - 1)], b = out[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    let l = Math.hypot(tx, tz);
    if (l < 1e-9) { tx = out[i].tx; tz = out[i].tz; l = Math.hypot(tx, tz) || 1; }
    out[i].tx = tx / l; out[i].tz = tz / l;
    out[i].rx = -out[i].tz; out[i].rz = out[i].tx;
  }
  return out;
}

function at(P, o, h) { return [P.x + P.rx * o, P.y + h, P.z + P.rz * o]; }

function segKind(route, a, b, L) {
  if (!(L > 0)) return a.kind;
  return sampleRoute(route, ((a.s + b.s) / 2) / L).kind || 'ground';
}

function ribbonQuad(bld, A, B, o0, h0, o1, h1, color) {
  bld.quad(at(A, o0, h0), at(B, o0, h0), at(B, o1, h1), at(A, o1, h1), color);
}

/** Box in the local frame of sample P: centre offset (o side, h up, f forward), sizes (w side, hh up, d forward). */
function frameBox(bld, P, o, h, f, w, hh, d, color, noBottom = true) {
  const fx = P.tx, fz = P.tz, rx = P.rx, rz = P.rz;
  const pt = (so, sh, sf) => [P.x + rx * (o + so) + fx * (f + sf), P.y + h + sh, P.z + rz * (o + so) + fz * (f + sf)];
  const w2 = w / 2, h2 = hh / 2, d2 = d / 2;
  const A = pt(-w2, -h2, -d2), B = pt(w2, -h2, -d2), Cc = pt(w2, -h2, d2), D = pt(-w2, -h2, d2);
  const E = pt(-w2, h2, -d2), F = pt(w2, h2, -d2), G = pt(w2, h2, d2), H = pt(-w2, h2, d2);
  bld.quad(E, F, G, H, color);
  if (!noBottom) bld.quad(A, D, Cc, B, shade(color, 0.6));
  bld.quad(A, B, F, E, shade(color, 0.85));
  bld.quad(D, H, G, Cc, shade(color, 0.85));
  bld.quad(B, Cc, G, F, shade(color, 0.75));
  bld.quad(A, E, H, D, shade(color, 0.75));
}

/** Sleeper half length towards a neighbouring lane: never longer than reaches its half of the gap. */
function sleeperHalf(lim) { return lim === Infinity ? TRACK.sleeperLen / 2 : Math.min(TRACK.sleeperLen / 2, Math.max(TRACK.gauge / 2 + 0.02, lim - 0.012)); }

function railsAndSleeper(bld, A, B, withSleeper, limL = Infinity, limR = Infinity) {
  const g2 = TRACK.gauge / 2, w2 = TRACK.railW / 2, rh = TRACK.railH;
  if (withSleeper) {
    const M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2, tx: A.tx, tz: A.tz, rx: A.rx, rz: A.rz };
    const hl = sleeperHalf(limL), hr = sleeperHalf(limR);
    frameBox(bld, M, (hr - hl) / 2, -rh - 0.012, 0, hl + hr, 0.024, TRACK.sleeperW, C.sleeper);
  }
  for (const sgn of [-1, 1]) {
    const o = sgn * g2;
    ribbonQuad(bld, A, B, o - w2, 0, o + w2, 0, C.rail);
    ribbonQuad(bld, A, B, o + w2 * sgn, 0, o + w2 * sgn, -rh, C.railSide);
    ribbonQuad(bld, A, B, o - w2 * sgn, -rh, o - w2 * sgn, 0, C.railSide);
  }
}

/**
 * The bed under one track. limL / limR: half the gap to a neighbouring lane on that side (Infinity when
 * none): the two beds then meet exactly half way, flat at the same height, so side by side they read as
 * one wide bed with nothing drawn twice (no z-fighting) and no bank between the tracks.
 */
function ballast(bld, A, B, limL = Infinity, limR = Infinity) {
  const t = TRACK.ballastTop, bb = TRACK.ballastBottom;
  const top = -TRACK.railH - 0.006;
  ribbonQuad(bld, A, B, -Math.min(t, limL), top, Math.min(t, limR), top, C.ballast);
  for (const sgn of [-1, 1]) {
    const lim = sgn < 0 ? limL : limR;
    if (lim > t) {
      const e = Math.min(lim, bb), h2 = top - 0.08 * (e - t) / (bb - t);
      if (sgn > 0) ribbonQuad(bld, A, B, t, top, e, h2, C.ballastDark); else ribbonQuad(bld, A, B, -e, h2, -t, top, C.ballastDark);
    }
    if (lim >= bb) {
      if (sgn > 0) ribbonQuad(bld, A, B, bb, top - 0.08, bb + 0.01, top - 0.42, shade(C.ballastDark, 0.8));
      else ribbonQuad(bld, A, B, -bb - 0.01, top - 0.42, -bb, top - 0.08, shade(C.ballastDark, 0.8));
    }
  }
}

/** Bridge deck; depth: girder depth below the deck (deeper over a crossing span); limits as for ballast. */
function bridgeDeck(bld, A, B, limL = Infinity, limR = Infinity, span = 0) {
  const top = -TRACK.railH - 0.006, bot = top - (0.1 + 0.13 * span), par = 0.075 + 0.06 * span;
  const wl = Math.min(0.22, limL), wr = Math.min(0.22, limR);
  ribbonQuad(bld, A, B, -wl, top, wr, top, C.deck);
  if (limR >= 0.22) {
    ribbonQuad(bld, A, B, wr, top + par, wr, bot, C.girder);
    ribbonQuad(bld, A, B, wr - 0.025, top + par, wr, top + par, shade(C.girder, 1.15));
  }
  if (limL >= 0.22) {
    ribbonQuad(bld, A, B, -wl, bot, -wl, top + par, C.girder);
    ribbonQuad(bld, A, B, -wl, top + par, -wl + 0.025, top + par, shade(C.girder, 1.15));
  }
  ribbonQuad(bld, A, B, wr, bot, -wl, bot, shade(C.deck, 0.6));
}

/** Earth bank from the edge of the bed down to the land, on one side of raised ground or ledge track. */
function embankSide(bld, A, B, side, ea, eb) {
  const bb = TRACK.ballastBottom, top = -TRACK.railH - 0.006 - 0.08;
  const col = C.embank;
  const o1a = side * ea.reach, o1b = side * eb.reach;
  const a0 = at(A, side * bb, top), b0 = at(B, side * bb, top);
  const a1 = [A.x + A.rx * o1a, ea.gy, A.z + A.rz * o1a], b1 = [B.x + B.rx * o1b, eb.gy, B.z + B.rz * o1b];
  if (side > 0) bld.quad(a0, b0, b1, a1, col); else bld.quad(a1, b1, b0, a0, col);
}

/** Points: a small switch stand beside the fork or join where this track's own rails meet shared ones. */
function switchStand(bld, S, i, shared, net, selfId) {
  const A = S[i];
  const j = Math.min(S.length - 1, Math.max(0, shared[i + 1] ? i - 5 : i + 5));
  const hits = lateralHits(net, selfId, S[j], S[j].y - RAIL_LIFT, 1.2).filter((h) => Math.abs(h.dy) < LANES.sameLevel);
  if (!hits.length) return;
  const near = hits.reduce((b, h) => (Math.abs(h.lat) < Math.abs(b.lat) ? h : b));
  const side = near.lat > 0 ? -1 : 1; // on the outer side, away from the trunk
  const o = side * 0.3;
  frameBox(bld, A, o, -0.01, 0, 0.07, 0.03, 0.07, C.pierDark);
  frameBox(bld, A, o, 0.07, 0, 0.025, 0.16, 0.025, C.pierDark);
  frameBox(bld, A, o, 0.17, 0, 0.07, 0.05, 0.03, '#c8402e');
}

/** Stone abutment where a span ends beside another track; dir: +1 when the span lies ahead. */
function abutment(bld, P, ground, dir) {
  const top = P.y - TRACK.railH - 0.1;
  const H = top - ground;
  if (H < 0.04) return;
  const Pm = { ...P, y: ground };
  frameBox(bld, Pm, 0, H * 0.5, 0, 0.5, H, 0.26, C.pier);
  frameBox(bld, Pm, 0, H - 0.025, 0, 0.56, 0.05, 0.32, C.pierDark);
  frameBox(bld, Pm, 0, 0.05, 0, 0.58, 0.1, 0.34, C.pierDark);
  // wing walls splaying back from the span
  for (const s of [-1, 1]) frameBox(bld, Pm, s * 0.25, H * 0.4, -dir * 0.18, 0.07, H * 0.8, 0.36, shade(C.pier, 0.92));
}

function pier(bld, P, ground, oc = 0, wk = 1) {
  const top = P.y - TRACK.railH - 0.11;
  const H = top - ground;
  if (H < 0.04) return;
  // oc / wk: a pier shared by tracks side by side stands centred on them and is that much wider
  const Pm = { ...P, x: P.x + P.rx * oc, z: P.z + P.rz * oc, y: ground };
  if (H < 1.1) {
    // stone pier, slightly tapered: draw as two stacked boxes
    frameBox(bld, Pm, 0, H * 0.5, 0, 0.36 * wk, H, 0.14, C.pier);
    frameBox(bld, Pm, 0, 0.06, 0, 0.44 * wk, 0.12, 0.2, C.pierDark);
  } else if (H < 2.2) {
    // timber trestle: legs splayed wider the taller it stands, cross braces and X-bracing
    const base = (0.3 + 0.08 * H) * wk, topHalf = 0.17 * wk;
    const halfAt = (y) => base - (base - topHalf) * (y / H);
    const segs = Math.max(2, Math.ceil(H / 0.5));
    for (const s of [-1, 1]) {
      for (let k = 0; k < segs; k++) {
        const y0 = (k / segs) * H, y1 = ((k + 1) / segs) * H;
        frameBox(bld, Pm, s * (halfAt(y0) + halfAt(y1)) / 2, (y0 + y1) / 2, 0, 0.055, y1 - y0 + 0.01, 0.055, C.deck);
      }
    }
    const nBr = Math.max(1, Math.floor(H / 0.45));
    let yPrev = 0;
    for (let k = 1; k <= nBr + 1; k++) {
      const y = k <= nBr ? (k / (nBr + 1)) * H : H - 0.04;
      if (k <= nBr) frameBox(bld, Pm, 0, y, 0, halfAt(y) * 2, 0.035, 0.035, shade(C.deck, 0.85));
      // one diagonal per bay, alternating, reads as X-bracing along the viaduct
      const sgn = k % 2 ? 1 : -1;
      const ax = -sgn * halfAt(yPrev), bx = sgn * halfAt(y);
      const len = Math.hypot(bx - ax, y - yPrev);
      const mid = { ...Pm, y: ground + (y + yPrev) / 2 };
      strut(bld, mid, (ax + bx) / 2, Math.atan2(y - yPrev, bx - ax), len, shade(C.deck, 0.78));
      yPrev = y;
    }
    frameBox(bld, Pm, 0, H - 0.02, 0, 0.42 * wk, 0.05, 0.08, shade(C.deck, 0.9));
  } else {
    // tall stone viaduct pier: tapered column with string courses, wide footing
    const n = Math.max(3, Math.ceil(H / 0.6));
    for (let k = 0; k < n; k++) {
      const y0 = (k / n) * H, y1 = ((k + 1) / n) * H;
      const u = (y0 + y1) / 2 / H;
      const w = (0.62 - 0.26 * u) * wk, d = 0.3 - 0.12 * u;
      frameBox(bld, Pm, 0, (y0 + y1) / 2, 0, w, y1 - y0 + 0.005, d, k % 2 ? C.pier : shade(C.pier, 0.94));
      if (k > 0) frameBox(bld, Pm, 0, y0, 0, w + 0.04, 0.04, d + 0.04, C.pierDark);
    }
    frameBox(bld, Pm, 0, 0.08, 0, 0.74 * wk, 0.16, 0.38, C.pierDark);
    frameBox(bld, Pm, 0, H - 0.03, 0, 0.46 * wk, 0.06, 0.2, C.pierDark);
  }
}

/** A thin beam in the cross-section plane of P, centred at side offset o, tilted by angle a. */
function strut(bld, P, o, a, len, color) {
  const c = Math.cos(a), s = Math.sin(a), t = 0.016, f = 0.02;
  const pt = (u, v, w) => {
    const so = o + u * c - v * s, sh = u * s + v * c;
    return [P.x + P.rx * so + P.tx * w, P.y + sh, P.z + P.rz * so + P.tz * w];
  };
  const l2 = len / 2;
  bld.quad(pt(-l2, -t, -f), pt(l2, -t, -f), pt(l2, t, -f), pt(-l2, t, -f), color);
  bld.quad(pt(-l2, t, f), pt(l2, t, f), pt(l2, -t, f), pt(-l2, -t, f), color);
  bld.quad(pt(-l2, t, -f), pt(l2, t, -f), pt(l2, t, f), pt(-l2, t, f), shade(color, 1.1));
  bld.quad(pt(-l2, -t, f), pt(l2, -t, f), pt(l2, -t, -f), pt(-l2, -t, -f), shade(color, 0.7));
}

function retainingWall(bld, A, B, side, dropA, dropB) {
  // side: -1 or 1; drop: how far below rail height the ground is (positive)
  const o = side * 0.27;
  const top = 0.01;
  const a0 = at(A, o, top), b0 = at(B, o, top);
  const a1 = at(A, o, -dropA - 0.1), b1 = at(B, o, -dropB - 0.1);
  bld.quad(a1, b1, b0, a0, C.wall);
  // coping
  const ao = at(A, o + side * 0.05, top), bo = at(B, o + side * 0.05, top);
  const ai = at(A, o - side * 0.02, top + 0.035), bi = at(B, o - side * 0.02, top + 0.035);
  bld.quad(ai, bi, bo, ao, C.wallCap);
  // mortar course lines: a slightly darker lower band
  const mA = at(A, o + side * 0.002, -dropA * 0.5), mB = at(B, o + side * 0.002, -dropB * 0.5);
  bld.quad(a1, b1, mB, mA, shade(C.wall, 0.86));
}

/** Tunnel portal at sample P; d = +1 when the tunnel lies ahead (toward route.to). */
function portal(bld, P, d, mountainTop) {
  const F = { ...P, tx: P.tx * d, tz: P.tz * d, rx: P.rx * d, rz: P.rz * d };
  // on a steep hillside the headwall stands taller, and a stone collar runs back into the
  // hill so no gap shows between the facade and the slope above and beside it
  const wallH = Math.min(1.5, Math.max(0.64, mountainTop - P.y + 0.05));
  const stone = C.portal;
  const open = 0.26;
  // the collar stays under the hill surface behind the facade (never a block on top of it)
  const collarH = Math.max(0.55, Math.min(wallH, mountainTop - P.y - 0.08));
  frameBox(bld, F, 0, collarH / 2 - 0.14, 0.36, open * 2 + 0.4, collarH + 0.04, 0.58, shade(stone, 0.8), false);
  if (mountainTop - P.y > 1.0) {
    for (const s of [-1, 1]) {
      // wing walls splaying out into a steep slope
      frameBox(bld, F, s * (open + 0.36), wallH * 0.3 - 0.12, 0.1, 0.22, wallH * 0.6, 0.3, shade(stone, 0.88), false);
    }
  }
  // pillars
  frameBox(bld, F, -open - 0.12, wallH / 2 - 0.12, 0, 0.24, wallH, 0.14, stone, false);
  frameBox(bld, F, open + 0.12, wallH / 2 - 0.12, 0, 0.24, wallH, 0.14, stone, false);
  // lintel over the opening
  const archTop = 0.5;
  frameBox(bld, F, 0, (archTop + wallH - 0.12) / 2, 0, open * 2 + 0.02, wallH - 0.12 - archTop, 0.14, shade(stone, 0.95), false);
  // arch corner fillers (low-poly arch)
  const pt = (o, h, f) => [F.x + F.rx * o + F.tx * f, F.y + h, F.z + F.rz * o + F.tz * f];
  for (const s of [-1, 1]) {
    for (const f of [-0.07, 0.07]) {
      bld.tri(pt(s * open, archTop, f), pt(s * open, 0.34, f), pt(s * (open - 0.12), archTop, f), shade(stone, 0.9));
    }
    bld.quad(pt(s * open, 0.34, -0.07), pt(s * open, 0.34, 0.07), pt(s * (open - 0.12), archTop, 0.07), pt(s * (open - 0.12), archTop, -0.07), shade(stone, 0.8));
  }
  // keystone
  frameBox(bld, F, 0, archTop + 0.03, -0.075, 0.09, 0.1, 0.03, shade(stone, 1.18));
  // dark mouth, recessed slightly into the tunnel
  bld.quad(pt(-open, -0.12, 0.05), pt(open, -0.12, 0.05), pt(open, archTop, 0.05), pt(-open, archTop, 0.05), C.portalDark);
  // short dark interior walls so the mouth reads as depth from an angle
  for (const s of [-1, 1]) bld.quad(pt(s * open, -0.12, -0.07), pt(s * open, -0.12, 0.05), pt(s * open, archTop, 0.05), pt(s * open, archTop, -0.07), shade(C.portalDark, 3));
}

/** Hill this far above the (lifted) rail top hides the track: tunnel. */
export const TUNNEL_COVER = 0.55;

/**
 * Per resampled segment: its kind and whether it is buried (a tunnel stretch under enough
 * natural hill). Tiny open gaps inside a tunnel are closed so they do not spawn portals.
 */
export function buriedSegments(route, S, naturalAt) {
  const L = routeLength(route);
  const kinds = [], buried = [];
  const has = typeof naturalAt === 'function';
  for (let i = 0; i + 1 < S.length; i++) {
    const A = S[i], B = S[i + 1];
    const kind = segKind(route, A, B, L);
    kinds.push(kind);
    let b = kind === 'tunnel';
    if (b && has) {
      const g = naturalAt((A.x + B.x) / 2, (A.z + B.z) / 2);
      b = Number.isFinite(g) ? g > (A.y + B.y) / 2 + TUNNEL_COVER : true;
    }
    buried.push(b);
  }
  // Close open gaps inside one tunnel: short ones always, longer ones while the rail is still
  // under the land there (a long tunnel under a dip must not pop out as a cutting with portals,
  // and its train must stay hidden all the way through).
  for (let i = 1; i + 1 < buried.length; i++) {
    if (buried[i]) continue;
    let j = i; while (j < buried.length && !buried[j]) j++;
    if (j < buried.length && buried[i - 1] && kinds.slice(i, j).every((k) => k === 'tunnel')) {
      let under = true;
      if (j - i > 3 && has) {
        for (let k = i; k < j && under; k++) {
          const A = S[k], B = S[k + 1];
          const g = naturalAt((A.x + B.x) / 2, (A.z + B.z) / 2);
          if (Number.isFinite(g) && g < (A.y + B.y) / 2 + 0.12) under = false;
        }
      }
      if (under) for (let k = i; k < j; k++) buried[k] = true;
    }
    i = j;
  }
  return { kinds, buried };
}

/** Arc-length intervals [s0, s1] of the resampled route that are buried (inside a tunnel). Pure. */
export function buriedIntervals(S, buried) {
  const out = [];
  for (let i = 0; i < buried.length; i++) {
    if (!buried[i]) continue;
    let j = i; while (j + 1 < buried.length && buried[j + 1]) j++;
    out.push([S[i].s, S[j + 1].s]);
    i = j;
  }
  return out;
}

/**
 * Where the land should be graded under a committed track: open (not buried) stretches
 * that are not bridges, as segments {ax, az, ay, bx, bz, by, capA, capB} with the target
 * ground height just under the trackbed. Ends next to a tunnel portal do not grade past
 * the portal, so the hill over the tunnel mouth stays whole.
 * opts.network / opts.id: the other built tracks. A stretch with another track passing under it nearby is
 * not graded up to its height (the lower track's bench wins there; the stretch stands on the earth bank
 * that buildTrack draws instead), so the upper track never buries the lower one.
 */
export function gradeSegments(route, naturalAt, opts = {}) {
  const S = resample(route, 0.3);
  const { kinds, buried } = buriedSegments(route, S, naturalAt);
  const net = opts.network || null;
  const out = [];
  const drop = RAIL_LIFT + 0.03;
  const clear = 1.0; // a lower track this near would be buried by the bench of this one
  for (let i = 0; i + 1 < S.length; i++) {
    if (buried[i] || kinds[i] === 'bridge') continue;
    const A = S[i], B = S[i + 1];
    if (net && net.size && onEarlierRails(net, opts.id, (A.x + B.x) / 2, (A.z + B.z) / 2, (A.y + B.y) / 2 - RAIL_LIFT)) continue; // graded by the track whose rails these are
    if (net && net.size) {
      let over = false;
      for (const P of [A, B, { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2, y: (A.y + B.y) / 2 }]) {
        if (nearestOther(net, opts.id, P.x, P.z, clear, { below: P.y - RAIL_LIFT - 0.5 })) { over = true; break; }
      }
      if (over) continue;
    }
    // how far the bed sits above or below the natural land beside it (embankment / cutting)
    let rise = 0;
    if (typeof naturalAt === 'function') {
      for (const P of [A, B]) {
        for (const side of [-1, 1]) {
          const g = naturalAt(P.x + P.rx * side * 0.9, P.z + P.rz * side * 0.9);
          if (Number.isFinite(g)) rise = Math.max(rise, Math.abs(g - (P.y - drop)));
        }
      }
    }
    out.push({
      ax: A.x, az: A.z, ay: A.y - drop, bx: B.x, bz: B.z, by: B.y - drop, rise,
      capA: !(i > 0 && buried[i - 1]),
      capB: !(i + 2 < S.length && buried[i + 1]),
    });
  }
  return out;
}

/**
 * Build the whole track for one route, emitted in arc-length order so drawRange can
 * animate it drawing itself from -> to.
 * env.network (lanes.js Network) and env.id: the other built tracks, so beds merge beside a parallel lane,
 * piers keep clear of any track beneath a bridge, and raised track gets an earth bank.
 * @param {import('../types.js').Route} route
 * @param {{groundAt?: (x:number,z:number)=>number, naturalAt?: Function, network?: object, id?: any}} [env]
 * @returns {{builder: MeshBuilder, marks: {s:number, v:number}[], portals: {x:number,y:number,z:number,into:number}[], supports: {x:number,z:number,type:string,i:number}[], length:number, kinds: Record<string, number>}}
 */
export function buildTrack(route, env = {}) {
  const groundAt = env.groundAt || (() => -Infinity);
  const net = env.network && env.network.size ? env.network : null;
  const selfId = env.id;
  const bld = new MeshBuilder();
  const S = resample(route);
  const L = routeLength(route);
  const marks = [{ s: 0, v: 0 }];
  const portals = [];
  const kinds = { ground: 0, ledge: 0, bridge: 0, tunnel: 0 };
  // A tunnel segment is only hidden where it is actually under enough hill; tunnel-kind
  // stretches still in the open are drawn as a cutting. Portals sit at the hill face.
  const natAt = env.naturalAt || env.groundAt;
  const hasGround = typeof natAt === 'function';
  const { kinds: segKinds, buried } = buriedSegments(route, S, natAt);
  const rockAt = (x, y, z) => { const g = natAt(x, z); return Number.isFinite(g) ? g > y + TUNNEL_COVER : true; };
  // stretches on an earlier track's rails are drawn once, by that track
  const shared = net ? sharedSegments(S, net, selfId) : S.slice(1).map(() => false);
  const supportAt = new Map();
  const supports = [];
  for (const sp of planSupports({ S, kinds: segKinds, buried, groundAt, net, selfId, pierEvery: TRACK.pierEvery, shared })) {
    supportAt.set(sp.i, sp);
    supports.push({ x: S[sp.i].x, z: S[sp.i].z, type: sp.type, i: sp.i });
  }
  const span = spanWeights(S, segKinds, buried, net, selfId);
  // neighbouring lanes beside a segment (half gaps), and the earth bank under raised track
  const lims = (A, B) => {
    if (!net) return [Infinity, Infinity, false, false];
    const P = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2, tx: A.tx, tz: A.tz, rx: A.rx, rz: A.rz };
    // a track on these very rails is not a neighbour; one diverging from them is (the beds meet half way: a wedge)
    const hits = lateralHits(net, selfId, P, (A.y + B.y) / 2 - RAIL_LIFT, LANES.reach).filter((h) => Math.abs(h.lat) > 0.04);
    const g = sideGaps(hits);
    // anything else (a track under or over) within reach of a side: no wall or bank may stand there
    let nearL = false, nearR = false;
    for (const h of hits) { if (h.lat < 0) nearL = true; else nearR = true; }
    return [halfGap(g.left), halfGap(g.right), nearL, nearR];
  };
  const bankCache = new Map();
  const bank = (i, side) => {
    const key = i * 2 + (side > 0 ? 1 : 0);
    let v = bankCache.get(key);
    if (v !== undefined) return v;
    const P = S[i];
    const bb = TRACK.ballastBottom, bedY = P.y - TRACK.railH - 0.006 - 0.08;
    const gAt = (o) => groundAt(P.x + P.rx * side * o, P.z + P.rz * side * o);
    const g0 = gAt(bb);
    v = null;
    if (Number.isFinite(g0) && bedY - g0 > 0.3) {
      let reach = bb + (bedY - g0) * 0.9;
      let g1 = gAt(reach);
      if (Number.isFinite(g1)) reach = Math.min(2.2, bb + Math.max(0, bedY - g1) * 0.9);
      if (net) {
        const hits = lateralHits(net, selfId, P, P.y - RAIL_LIFT, reach + 0.4);
        for (const h of hits) {
          if (h.dy > -LANES.sameLevel || h.lat * side <= 0) continue;
          reach = Math.min(reach, Math.max(bb + 0.05, Math.abs(h.lat) - 0.34));
        }
      }
      g1 = gAt(reach);
      if (Number.isFinite(g1)) v = { reach, gy: Math.min(g1, bedY - 0.05) - 0.03 };
    }
    bankCache.set(key, v);
    return v;
  };
  for (let i = 0; i + 1 < S.length; i++) {
    const A = S[i], B = S[i + 1];
    const kind = segKinds[i];
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (shared[i]) { marks.push({ s: B.s, v: bld.vertexCount }); continue; }
    if (i > 0 && buried[i] !== buried[i - 1]) {
      // d = +1: rock ahead (toward route.to). Find the rock face between the neighbouring samples.
      const d = buried[i] ? 1 : -1;
      const P0 = S[i - 1], P1 = S[Math.min(S.length - 1, i + 1)];
      let wall = A;
      if (hasGround) {
        const N = 12;
        let found = null;
        for (let k = 0; k <= N; k++) {
          const u = d > 0 ? k / N : 1 - k / N;
          const x = P0.x + (P1.x - P0.x) * u, y = P0.y + (P1.y - P0.y) * u, z = P0.z + (P1.z - P0.z) * u;
          if (rockAt(x, y, z)) { found = { x, y, z }; break; }
        }
        if (found) wall = { ...A, x: found.x, y: found.y, z: found.z };
      }
      const C0 = { ...wall, x: wall.x - A.tx * d * 0.07, z: wall.z - A.tz * d * 0.07 };
      const mt = groundAt(wall.x + A.tx * d * 0.5, wall.z + A.tz * d * 0.5);
      portal(bld, C0, d, Number.isFinite(mt) ? mt : C0.y + 0.8);
      portals.push({ x: C0.x, y: C0.y, z: C0.z, into: d });
    }
    if (buried[i]) { marks.push({ s: B.s, v: bld.vertexCount }); continue; }
    const [limL, limR, nearL, nearR] = lims(A, B);
    if (kind === 'bridge') {
      bridgeDeck(bld, A, B, limL, limR, span[i]);
      const sp = supportAt.get(i);
      if (sp) {
        const g = groundAt(A.x, A.z);
        if (Number.isFinite(g)) {
          if (sp.type === 'abutment') abutment(bld, A, g, sp.dir); else pier(bld, A, g, sp.oc, sp.wk);
        }
      }
    } else {
      ballast(bld, A, B, limL, limR);
      let wallSide = 0;
      if (kind === 'ledge') {
        const side = 0.62;
        const gl = groundAt(A.x - A.rx * side, A.z - A.rz * side);
        const gr = groundAt(A.x + A.rx * side, A.z + A.rz * side);
        if (Number.isFinite(gl) && Number.isFinite(gr)) {
          const sgn = gl < gr ? -1 : 1;
          const low = Math.min(gl, gr);
          const glB = groundAt(B.x + B.rx * side * sgn, B.z + B.rz * side * sgn);
          const dropA = Math.max(0.05, A.y - low);
          const dropB = Math.max(0.05, B.y - (Number.isFinite(glB) ? Math.min(glB, B.y) : low));
          if (!(sgn < 0 ? nearL : nearR)) { retainingWall(bld, A, B, sgn, Math.min(dropA, 3), Math.min(dropB, 3)); wallSide = sgn; }
        } else if (!nearR) {
          retainingWall(bld, A, B, 1, 0.4, 0.4); wallSide = 1;
        }
      }
      // raised track stands on an earth bank, not in the air (where the land is not graded up to it)
      for (const side of [-1, 1]) {
        if (side === wallSide) continue;
        const ea = bank(i, side), eb = bank(i + 1, side);
        if (ea && eb) embankSide(bld, A, B, side, ea, eb);
      }
    }
    railsAndSleeper(bld, A, B, true, limL, limR);
    if (net && kind !== 'bridge' && ((i > 0 && shared[i - 1]) || shared[i + 1])) switchStand(bld, S, i, shared, net, selfId);
    marks.push({ s: B.s, v: bld.vertexCount });
  }
  return { builder: bld, marks, portals, supports, length: L, kinds, buried: buriedIntervals(S, buried) };
}

/** Vertex count to draw so the track appears built up to arc length s. */
export function vertexCountAt(marks, s) {
  if (!marks.length) return 0;
  if (s >= marks[marks.length - 1].s) return marks[marks.length - 1].v;
  let lo = 0, hi = marks.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].s <= s) lo = mid; else hi = mid;
  }
  return marks[lo].v;
}

/**
 * A flat ribbon floating over the route (route previews, line highlights).
 * Tunnel stretches are lifted over the terrain and dashed; bridges striped; ledges amber.
 * @param {{width?:number, lift?:number, groundAt?:Function, mode?:'preview'|'highlight', chevrons?:boolean}} opts
 */
export function buildRibbon(route, opts = {}) {
  const width = opts.width || 0.3;
  const lift = opts.lift ?? 0.14;
  const groundAt = opts.groundAt || (() => -Infinity);
  const mode = opts.mode || 'preview';
  const bld = new MeshBuilder();
  const S = resample(route, 0.09);
  const L = routeLength(route);
  const ys = S.map((P) => {
    if (P.kind === 'tunnel') {
      const g = groundAt(P.x, P.z);
      return Math.max(P.y, Number.isFinite(g) ? g : P.y) + lift + 0.05;
    }
    return P.y + lift;
  });
  // smooth the lifted heights so ribbons glide over tunnels
  const sm = ys.slice();
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i + 1 < sm.length; i++) sm[i] = Math.max(ys[i], (sm[i - 1] + sm[i] * 2 + sm[i + 1]) / 4);
  }
  const w2 = width / 2;
  for (let i = 0; i + 1 < S.length; i++) {
    const A = { ...S[i], y: sm[i] }, B = { ...S[i + 1], y: sm[i + 1] };
    const kind = segKind(route, S[i], S[i + 1], L);
    const sMid = (A.s + B.s) / 2;
    let col;
    if (mode === 'highlight') {
      if (kind === 'tunnel' && Math.floor(sMid / 0.2) % 2) continue;
      col = [1, 1, 1];
    } else {
      col = rgb(ROUTE_PREVIEW[kind] || ROUTE_PREVIEW.ground);
      if (kind === 'tunnel' && Math.floor(sMid / 0.16) % 2) continue;
      if (kind === 'bridge' && Math.floor(sMid / 0.18) % 2) col = mix(col, '#ffffff', 0.6);
    }
    if (mode === 'preview' && opts.chevrons) {
      // dark borders give the bright ribbon an edge against pale ground
      const e = w2 * 0.28, dark = shade(col, 0.32);
      bld.quad(at(A, -w2, 0), at(B, -w2, 0), at(B, -w2 + e, 0), at(A, -w2 + e, 0), dark);
      bld.quad(at(A, w2 - e, 0), at(B, w2 - e, 0), at(B, w2, 0), at(A, w2, 0), dark);
      bld.quad(at(A, -w2 + e, 0), at(B, -w2 + e, 0), at(B, w2 - e, 0), at(A, w2 - e, 0), col);
    } else {
      bld.quad(at(A, -w2, 0), at(B, -w2, 0), at(B, w2, 0), at(A, w2, 0), col);
    }
  }
  if (opts.chevrons && L > 0) {
    for (let s = 0.5; s < L - 0.3; s += 0.7) {
      const i = Math.min(S.length - 1, Math.round(s / (L / (S.length - 1))));
      const P = { ...S[i], y: sm[i] + 0.005 };
      const f = (o, ff) => [P.x + P.rx * o + P.tx * ff, P.y, P.z + P.rz * o + P.tz * ff];
      const cc = rgb('#5a4422');
      bld.tri(f(-w2 * 0.55, -0.06), f(0, 0.07), f(0, 0.02), cc);
      bld.tri(f(0, 0.02), f(0, 0.07), f(w2 * 0.55, -0.06), cc);
    }
  }
  return bld;
}
