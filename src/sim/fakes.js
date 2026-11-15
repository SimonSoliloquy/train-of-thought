// Test doubles that implement the WikiApi and World contracts (src/types.js).
// Used by the sim tests and by bot.mjs. Not imported by the game.
import { ECON, WORLD } from '../config.js';
import { hexToWorld, hexDistance, hexRound, hexSpiral, hexRing } from '../hex.js';
import { routeLength } from '../route.js';

/**
 * graph: { [title]: { kind?, popularity?, description?, leadLinks: string[], links?: string[] } }
 * links defaults to leadLinks; leadLinks are always merged into links.
 * opts.gate: when set to a function returning a Promise, getArticle awaits it first (for concurrency tests).
 */
export function createFakeWiki(graph, { start, gate = null, failTitles = [] } = {}) {
  const calls = { getArticle: 0, getStubs: 0, randomStart: 0 };
  const article = (title) => {
    const g = graph[title];
    const links = [...new Set([...(g.leadLinks || []), ...(g.links || [])])];
    return {
      title,
      kind: g.kind || 'article',
      description: g.description ?? `About ${title}`,
      popularity: g.popularity ?? 0.5,
      summary: `${title} summary.`,
      thumbnail: null,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      leadLinks: [...(g.leadLinks || [])],
      links,
    };
  };
  const wiki = {
    calls,
    gate,
    async randomStart() {
      calls.randomStart++;
      return article(start ?? Object.keys(graph)[0]);
    },
    async getArticle(title) {
      calls.getArticle++;
      if (wiki.gate) await wiki.gate(title);
      if (!graph[title] || failTitles.includes(title)) throw new Error(`No page ${title}`);
      return article(title);
    },
    async getStubs(titles) {
      calls.getStubs++;
      const out = new Map();
      for (const t of titles) {
        const g = graph[t];
        if (!g) continue;
        out.set(t, { title: t, kind: g.kind || 'article', description: g.description ?? `About ${t}`, popularity: g.popularity ?? 0.5 });
      }
      return out;
    },
  };
  return wiki;
}

function tile(q, r) {
  return { q, r, biome: 'grassland', elevation: 0, water: false, detail: 0.5 };
}

function lineHexes(a, b) {
  const n = hexDistance(a, b);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = n === 0 ? 0 : i / n;
    out.push(hexRound(a.q + (b.q - a.q) * f + 1e-6, a.r + (b.r - a.r) * f + 1e-6));
  }
  return out;
}

function makeRoute(from, to, a, b, style) {
  const hexes = lineHexes(a, b).map((h, i, arr) => ({
    q: h.q,
    r: h.r,
    kind: style === 'direct' && i === 1 && arr.length > 2 ? 'bridge' : 'ground',
  }));
  const points = [];
  const pa = hexToWorld(a.q, a.r), pb = hexToWorld(b.q, b.r);
  const steps = Math.max(1, (hexes.length - 1) * 8);
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    points.push({ x: pa.x + (pb.x - pa.x) * f, y: 0.2, z: pa.z + (pb.z - pa.z) * f, kind: 'ground' });
  }
  const route = { from, to, style, hexes, points, length: 0, cost: 0 };
  route.length = routeLength(route);
  route.cost = hexes.reduce((s, h) => s + ECON.trackCostPerHex[h.kind], 0);
  return route;
}

/** Flat world; ghosts placed on a deterministic spiral around their parent; straight-line routes. */
export function createFakeWorld({ positions = {} } = {}) {
  const placements = new Map();
  const revealed = new Map();
  const reveal = (q, r, radius) => {
    const out = [];
    for (const h of hexSpiral(q, r, radius)) {
      const k = `${h.q},${h.r}`;
      if (revealed.has(k)) continue;
      const t = tile(h.q, h.r);
      revealed.set(k, t);
      out.push(t);
    }
    return out;
  };
  const free = (q, r) => {
    for (const p of placements.values()) if (hexDistance(p, { q, r }) < WORLD.minStationSpacing) return false;
    return true;
  };
  const committed = [];
  return {
    placements,
    committed,
    placeStart(title) {
      const placement = { title, q: 0, r: 0, state: 'built', parent: null };
      placements.set(title, placement);
      return { placement, revealed: reveal(0, 0, WORLD.revealStation) };
    },
    placeGhosts(parentTitle, titles) {
      const parent = placements.get(parentTitle);
      const out = [];
      const rev = [];
      for (const title of titles) {
        if (placements.has(title)) continue;
        let spot = positions[title] || null;
        for (let rad = WORLD.ghostMinDist; !spot && rad < 60; rad++) {
          for (const h of hexRing(parent.q, parent.r, rad)) if (free(h.q, h.r)) { spot = h; break; }
        }
        const p = { title, q: spot.q, r: spot.r, state: 'ghost', parent: parentTitle };
        placements.set(title, p);
        out.push(p);
        rev.push(...reveal(p.q, p.r, WORLD.revealGhost));
      }
      return { placements: out, revealed: rev };
    },
    setBuilt(title) {
      const p = placements.get(title);
      p.state = 'built';
      return { revealed: reveal(p.q, p.r, WORLD.revealStation) };
    },
    findRoutes(fromTitle, toTitle) {
      const a = placements.get(fromTitle), b = placements.get(toTitle);
      if (!a || !b) throw new Error('not placed');
      return { cheap: makeRoute(fromTitle, toTitle, a, b, 'cheap'), direct: makeRoute(fromTitle, toTitle, a, b, 'direct'), same: false };
    },
    commitRoute(route) {
      committed.push(route);
      const rev = [];
      for (const h of route.hexes) rev.push(...reveal(h.q, h.r, 1));
      return { revealed: rev };
    },
    terrainAt: (q, r) => tile(q, r),
    isRevealed: (q, r) => revealed.has(`${q},${r}`),
    revealedTiles: () => [...revealed.values()],
  };
}

/** Lets pending promise chains (fake wiki calls) settle. */
export async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
