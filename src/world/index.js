// World: station layout from the link structure, scenery terrain, and track routing.
// Pure logic: no three.js, no DOM, no network, no Math.random, no Date.

import { WORLD } from '../config.js';
import { HEX_DIRS, hexSpiral, hashString } from '../hex.js';
import { createTerrain, tileKey, ELEV_STEP } from './terrain.js';
import { createTrackStore } from './tracks.js';
import { createLayout } from './layout.js';
import { createRouter } from './router.js';

function seedToInt(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return Number.isInteger(seed) && Math.abs(seed) < 2 ** 31 ? seed | 0 : hashString(String(seed)) | 0;
  }
  return hashString(String(seed ?? 0)) | 0;
}

/**
 * @param {{seed: number|string}} opts
 * @returns {import('../types.js').World}
 */
export function createWorld({ seed } = {}) {
  const terrain = createTerrain(seedToInt(seed));
  const trackHexes = new Map(); // tileKey -> number of committed routes over the hex
  const layout = createLayout(terrain, (q, r) => trackHexes.has(tileKey(q, r)));
  // Built track, hex by hex (base track, lanes beside it, the track crossing it): see tracks.js.
  const store = createTrackStore();
  // Only built stations block track; unbuilt reservations are invisible and move off new track.
  const router = createRouter(terrain, layout.builtAt, store);
  const committed = new WeakSet();
  const revealed = new Map(); // tileKey -> Tile, in reveal order

  function reveal(q, r, radius, out) {
    for (const h of hexSpiral(q, r, radius)) {
      const k = tileKey(h.q, h.r);
      if (revealed.has(k)) continue;
      const t = terrain.terrainAt(h.q, h.r);
      revealed.set(k, t);
      out.push(t);
    }
    return out;
  }

  /**
   * Records a route in the track store. A route priced before other track was laid where it runs
   * (the sim builds after an article loads) is recorded as far as it is still legal; the hexes
   * taken meanwhile are left to the track that got there first.
   */
  function recordTrack(route) {
    const plan = router.planOf(route);
    store.commit(plan ? plan.steps : stepsOf(route), route.points);
  }

  /** Steps for a route this world did not make (no search plan): its hexes as plain track. */
  function stepsOf(route) {
    const hx = route.hexes, n = hx.length;
    const dirTo = (a, b) => HEX_DIRS.findIndex((d) => a.q + d.q === b.q && a.r + d.r === b.r);
    return hx.map((h, i) => ({
      q: h.q, r: h.r, kind: h.kind,
      level: Math.round((route.points[Math.min(route.points.length - 1, i * 8)]?.y ?? 0) / ELEV_STEP),
      mode: i === 0 || i === n - 1 ? 'station' : h.lane ? 'lane' : h.over || h.under ? 'cross' : 'free',
      lane: h.lane || 0, over: !!h.over, under: !!h.under,
      hin: i > 0 ? dirTo(hx[i - 1], h) : -1, hout: i + 1 < n ? dirTo(h, hx[i + 1]) : -1,
    }));
  }

  function mustGet(title, fn) {
    const p = layout.placements.get(title);
    if (!p) throw new Error(`world.${fn}: "${title}" is not on the map`);
    return p;
  }

  return {
    placements: layout.placements,

    placeStart(title) {
      const placement = layout.placeStart(title);
      return { placement, revealed: reveal(placement.q, placement.r, WORLD.revealStation, []) };
    },

    placeGhosts(parentTitle, titles) {
      const placements = layout.placeGhosts(parentTitle, titles);
      const out = [];
      // revealGhost < 0: unbuilt links reveal nothing (nothing shows in the fog)
      if (WORLD.revealGhost >= 0) for (const p of placements) reveal(p.q, p.r, WORLD.revealGhost, out);
      return { placements, revealed: out };
    },

    noteLinks(title, links) {
      layout.noteLinks(title, links);
    },

    /** An unbuilt spot at the acceptable hex nearest world point (x, z); it never moves. */
    placeAt(parentTitle, title, x, z) {
      return { placement: layout.placeAt(parentTitle, title, x, z), revealed: [] };
    },

    /** Removes an unbuilt spot again. */
    dropGhost(title) {
      return layout.drop(title);
    },

    setBuilt(title) {
      const p = layout.setBuilt(title);
      return { revealed: reveal(p.q, p.r, WORLD.revealStation, []) };
    },

    findRoutes(fromTitle, toTitle) {
      const a = mustGet(fromTitle, 'findRoutes');
      const b = mustGet(toTitle, 'findRoutes');
      return router.findRoutes(fromTitle, a, toTitle, b);
    },

    commitRoute(route) {
      if (!route || !Array.isArray(route.hexes)) throw new Error('world.commitRoute: not a route');
      const out = [];
      if (committed.has(route)) { // the same track again: nothing new to record
        for (const h of route.hexes) reveal(h.q, h.r, WORLD.revealTrack, out);
        return { revealed: out };
      }
      committed.add(route);
      recordTrack(route);
      for (const h of route.hexes) {
        const k = tileKey(h.q, h.r);
        trackHexes.set(k, (trackHexes.get(k) || 0) + 1);
      }
      for (const h of route.hexes) reveal(h.q, h.r, WORLD.revealTrack, out);
      // reservations (other than the route's own ends) never sit on track
      const ends = new Set([route.from, route.to]);
      layout.clearHexes(route.hexes.filter((h) => !ends.has(layout.stationAt(h.q, h.r))));
      return { revealed: out };
    },

    terrainAt: terrain.terrainAt,

    isRevealed(q, r) {
      return revealed.has(tileKey(q, r));
    },

    revealedTiles() {
      return [...revealed.values()];
    },
  };
}
