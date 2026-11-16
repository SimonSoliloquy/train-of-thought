// Station layout. Positions come only from the link structure: who links to whom, and in what
// reading order. Terrain only nudges a station off water or cliffs to the nearest acceptable hex.
//
// An unbuilt link C is a reservation. Its target point starts from its first linker P (the
// station whose placeGhosts put it on the map): distance by reading order, heading in a fan
// pointing away from P's own parent (the start station fans all the way round), jittered by
// hashString(C). The target is then pulled towards the centroid of every OTHER built station
// that also links to C (known from noteLinks), more strongly the more of them there are, so
// related articles sit together and widely shared articles become junctions. Reservations are
// invisible and are re-placed whenever a newly noted station links to them, when a station is
// built too close to them, or when track is laid over them. Built stations never move.

import { WORLD, HEX_SIZE } from '../config.js';
import { hexToWorld, worldToHex, hexRing, hexSpiral, hashString, hexDistance } from '../hex.js';
import { tileKey } from './terrain.js';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~137.5 degrees
const PHI_FRAC = (Math.sqrt(5) - 1) / 2;           // ~0.618
const HEX_STEP = HEX_SIZE * Math.sqrt(3);          // world distance between neighbouring centres
/** Total width of the fan of a non-start station's ghosts (radians). */
export const FAN_WIDTH = (200 * Math.PI) / 180;
/** Hex distance a reservation keeps from other reservations (built stations keep minStationSpacing). */
export const RESERVATION_SPACING = 1;
/** A reservation stays within this many hexes of its nearest built linker whenever it can. */
export const RESERVATION_REACH = WORLD.ghostMaxDist + 2;
/** Pull towards the other linkers' centroid: k / (k + PULL_HALF) for k other linkers. */
const PULL_HALF = 0.5;
const PULL_MAX = 0.85;

/**
 * @param {{isBuildable:(q:number,r:number)=>boolean}} terrain
 * @param {(q:number,r:number)=>boolean} isTrack  committed track on this hex
 */
export function createLayout(terrain, isTrack = () => false) {
  /** @type {Map<string, import('../types.js').Placement>} */
  const placements = new Map();
  const occupied = new Map();  // tileKey -> title
  const slot = new Map();      // reservation title -> {index, n} in its first linker's lead links
  const noted = new Map();     // built title -> Set of linked titles
  const linkers = new Map();   // title -> [built titles that link to it], in noting order

  const maxSpacing = Math.max(WORLD.minStationSpacing, RESERVATION_SPACING);

  /** Can reservation `self` stand on (q, r)? */
  function acceptable(q, r, self) {
    if (!terrain.isBuildable(q, r) || isTrack(q, r)) return false;
    for (const h of hexSpiral(q, r, maxSpacing - 1)) {
      const t = occupied.get(tileKey(h.q, h.r));
      if (t === undefined || t === self) continue;
      const d = hexDistance(h, { q, r });
      const need = placements.get(t).state === 'built' ? WORLD.minStationSpacing : RESERVATION_SPACING;
      if (d < need) return false;
    }
    return true;
  }

  /**
   * Closest acceptable hex to a world-space target point. Prefers hexes within `reach` of
   * one of `anchors`; widens without that limit when none exists. Always succeeds.
   */
  function findSpot(tx, tz, self, anchors) {
    const c = worldToHex(tx, tz);
    const near = (h) => anchors.length === 0 || anchors.some((a) => hexDistance(a, h) <= RESERVATION_REACH);
    for (const limited of [true, false]) {
      let best = null, bestD = Infinity, foundAt = -1;
      const maxK = limited ? RESERVATION_REACH * 2 + 4 : 4096;
      for (let k = 0; k <= maxK; k++) {
        if (foundAt >= 0 && k > foundAt + 1) break;
        for (const h of hexRing(c.q, c.r, k)) {
          if (limited && !near(h)) continue;
          if (!acceptable(h.q, h.r, self)) continue;
          const w = hexToWorld(h.q, h.r);
          const d = Math.hypot(w.x - tx, w.z - tz);
          if (d < bestD - 1e-9) { best = h; bestD = d; }
          if (foundAt < 0) foundAt = k;
        }
      }
      if (best) return best;
    }
    throw new Error('world: no acceptable hex found for a station');
  }

  function occupy(p) { occupied.set(tileKey(p.q, p.r), p.title); }
  function vacate(p) { if (occupied.get(tileKey(p.q, p.r)) === p.title) occupied.delete(tileKey(p.q, p.r)); }

  function placeStart(title) {
    if (placements.size > 0) throw new Error('world.placeStart: the map already has stations');
    const p = { title, q: 0, r: 0, state: 'built', parent: null };
    placements.set(title, p);
    occupy(p);
    return p;
  }

  /** Heading (radians, world x/z plane) of the fan of `parent`'s links. */
  function fanFor(parent) {
    const pw = hexToWorld(parent.q, parent.r);
    const gp = parent.parent != null ? placements.get(parent.parent) : null;
    if (gp && (gp.q !== parent.q || gp.r !== parent.r)) {
      const gw = hexToWorld(gp.q, gp.r);
      return { full: false, base: Math.atan2(pw.z - gw.z, pw.x - gw.x) };
    }
    return { full: true, base: (hashString(parent.title) / 4294967296) * Math.PI * 2 };
  }

  /** The reading-order target from the first linker alone. */
  function baseTarget(title, parent, index, n) {
    const fan = fanFor(parent);
    const pw = hexToWorld(parent.q, parent.r);
    const f = n > 1 ? index / (n - 1) : 0;
    const dist = WORLD.ghostMinDist + (WORLD.ghostMaxDist - WORLD.ghostMinDist) * f;
    const jitter = hashString(title) / 4294967296 - 0.5; // -0.5..0.5
    let angle;
    if (fan.full) {
      // phyllotaxis: consecutive links spread round the circle, distance grows with order
      angle = fan.base + index * GOLDEN_ANGLE + jitter * 0.35;
    } else {
      // low-discrepancy slots across the fan; first link points straight outward
      const u = (0.5 + index * PHI_FRAC) % 1;
      const slotW = FAN_WIDTH / Math.max(n, 4);
      angle = fan.base + FAN_WIDTH * (u - 0.5) + jitter * slotW * 0.5;
    }
    return { x: pw.x + Math.cos(angle) * dist * HEX_STEP, z: pw.z + Math.sin(angle) * dist * HEX_STEP };
  }

  /** Built stations other than `parent` whose noted links contain `title`. */
  function otherLinkers(title, parentTitle) {
    const list = linkers.get(title);
    if (!list) return [];
    const out = [];
    for (const t of list) {
      if (t === parentTitle || t === title) continue;
      const p = placements.get(t);
      if (p && p.state === 'built') out.push(p);
    }
    return out;
  }

  /** Puts reservation p (already in `placements`) on its best hex given everything known now. */
  function site(p) {
    if (p.pinned) return; // put down at a chosen point (placeAt): it stays there
    const parent = placements.get(p.parent);
    const s = slot.get(p.title) || { index: 0, n: 1 };
    const t = baseTarget(p.title, parent, s.index, s.n);
    const others = otherLinkers(p.title, p.parent);
    let tx = t.x, tz = t.z;
    if (others.length) {
      let gx = 0, gz = 0;
      for (const o of others) { const w = hexToWorld(o.q, o.r); gx += w.x; gz += w.z; }
      gx /= others.length; gz /= others.length;
      const pull = Math.min(PULL_MAX, others.length / (others.length + PULL_HALF));
      tx += (gx - tx) * pull;
      tz += (gz - tz) * pull;
    }
    const anchors = [parent, ...others].filter((a) => a.state === 'built');
    vacate(p);
    const h = findSpot(tx, tz, p.title, anchors.length ? anchors : [parent]);
    p.q = h.q;
    p.r = h.r;
    occupy(p);
  }

  function replace(title) {
    const p = placements.get(title);
    if (p && p.state === 'ghost') site(p);
  }

  function addLinker(from, title) {
    let set = noted.get(from);
    if (!set) noted.set(from, (set = new Set()));
    if (set.has(title)) return false;
    set.add(title);
    let list = linkers.get(title);
    if (!list) linkers.set(title, (list = []));
    list.push(from);
    return true;
  }

  function noteLinks(title, links) {
    if (!Array.isArray(links)) return;
    const moved = [];
    for (const l of links) {
      if (typeof l !== 'string' || l === title) continue;
      if (addLinker(title, l) && placements.get(l)?.state === 'ghost') moved.push(l);
    }
    // re-place only once this station counts as built, i.e. now or when setBuilt runs
    const self = placements.get(title);
    if (self && self.state === 'built') for (const l of moved) replace(l);
  }

  function placeGhosts(parentTitle, titles) {
    const parent = placements.get(parentTitle);
    if (!parent) throw new Error(`world.placeGhosts: "${parentTitle}" is not on the map`);
    const n = titles.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const title = typeof titles[i] === 'string' ? titles[i] : null;
      if (title === null || title === parentTitle) continue;
      const gained = parent.state === 'built' ? addLinker(parentTitle, title) : false;
      const existing = placements.get(title);
      if (existing) {
        if (gained && existing.state === 'ghost') site(existing);
        continue;
      }
      const p = { title, q: parent.q, r: parent.r, state: 'ghost', parent: parentTitle };
      placements.set(title, p);
      slot.set(title, { index: i, n });
      site(p);
      out.push(p);
    }
    return out;
  }

  /**
   * An unbuilt spot for `title` on the acceptable hex closest to world point (x, z), linked from
   * `parentTitle`. Unlike placeGhosts it never moves afterwards. Returns null if already placed.
   */
  function placeAt(parentTitle, title, x, z) {
    const parent = placements.get(parentTitle);
    if (!parent) throw new Error(`world.placeAt: "${parentTitle}" is not on the map`);
    if (placements.has(title)) return null;
    const h = findSpot(x, z, title, []);
    const p = { title, q: h.q, r: h.r, state: 'ghost', parent: parentTitle, pinned: true };
    placements.set(title, p);
    occupy(p);
    return p;
  }

  /** Takes an unbuilt spot off the map again (a build that could not go ahead). */
  function drop(title) {
    const p = placements.get(title);
    if (!p || p.state !== 'ghost') return false;
    vacate(p);
    placements.delete(title);
    slot.delete(title);
    return true;
  }

  function setBuilt(title) {
    const p = placements.get(title);
    if (!p) throw new Error(`world.setBuilt: "${title}" is not on the map`);
    if (p.state === 'built') return p;
    p.state = 'built';
    slot.delete(title);
    // links noted before it was built now pull their reservations
    const set = noted.get(title);
    if (set) for (const l of set) replace(l);
    // reservations now too close to a built station move away
    for (const h of hexSpiral(p.q, p.r, WORLD.minStationSpacing - 1)) {
      const t = occupied.get(tileKey(h.q, h.r));
      if (t !== undefined && t !== title) replace(t);
    }
    return p;
  }

  /** Reservations standing on these hexes move off them (called when track is laid). */
  function clearHexes(hexes) {
    for (const h of hexes) {
      const t = occupied.get(tileKey(h.q, h.r));
      if (t !== undefined) replace(t);
    }
  }

  function stationAt(q, r) {
    return occupied.get(tileKey(q, r)) ?? null;
  }

  function builtAt(q, r) {
    const t = occupied.get(tileKey(q, r));
    return t !== undefined && placements.get(t).state === 'built' ? t : null;
  }

  return { placements, placeStart, placeGhosts, placeAt, drop, setBuilt, noteLinks, clearHexes, stationAt, builtAt };
}
