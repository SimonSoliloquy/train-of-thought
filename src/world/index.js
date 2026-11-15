// World: station layout from the link structure, scenery terrain, and track routing.
// Pure logic: no three.js, no DOM, no network, no Math.random, no Date.

import { WORLD } from '../config.js';
import { hexSpiral, hashString } from '../hex.js';
import { createTerrain, tileKey } from './terrain.js';
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
  const layout = createLayout(terrain);
  const trackHexes = new Map(); // tileKey -> number of committed routes over the hex
  const router = createRouter(terrain, layout.stationAt, trackHexes);
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
      for (const p of placements) reveal(p.q, p.r, WORLD.revealGhost, out);
      return { placements, revealed: out };
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
      for (const h of route.hexes) {
        const k = tileKey(h.q, h.r);
        trackHexes.set(k, (trackHexes.get(k) || 0) + 1);
      }
      for (const h of route.hexes) reveal(h.q, h.r, WORLD.revealTrack, out);
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
