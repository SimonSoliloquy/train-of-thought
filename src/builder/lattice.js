// An endless map of places to build, with no words in it. It stands where Wikipedia stands in
// the game (the WikiApi contract in src/types.js), so the same rules and map can run on it.
//
// Places are the points of a triangular lattice; a place "links" to some of its six neighbours.
// Which ones is decided by a hash, so the network is irregular, the same for a given seed, and
// full of loops: two stations you built can share a neighbour, or be neighbours themselves.

const NEIGHBOURS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const LINK_CHANCE = 0.55; // share of lattice edges that exist, before the two every place is guaranteed
const GUARANTEED = 2;     // every place keeps at least this many links, so no line is a dead end

export const key = (i, j) => `${i},${j}`;
export function parse(title) {
  const [i, j] = String(title).split(',').map(Number);
  return Number.isInteger(i) && Number.isInteger(j) ? { i, j } : null;
}

function mix(a) {
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  return (a ^ (a >>> 16)) >>> 0;
}
function hash(seed, ...n) {
  let h = mix(seed >>> 0 || 1);
  for (const v of n) h = mix(h ^ mix((v | 0) + 0x9e3779b9));
  return h / 4294967296;
}

export function createLattice(seed = 1) {
  /** One number per edge, the same from either end. */
  const edgeHash = (a, b) => {
    const first = a.i < b.i || (a.i === b.i && a.j <= b.j);
    const p = first ? a : b, q = first ? b : a;
    return hash(seed, p.i, p.j, q.i, q.j);
  };
  const around = (p) => NEIGHBOURS.map(([di, dj]) => ({ i: p.i + di, j: p.j + dj }));
  /** The links a place always keeps: its lowest-numbered edges. */
  const kept = (p) => around(p)
    .map((q) => ({ q, h: edgeHash(p, q) }))
    .sort((x, y) => x.h - y.h)
    .slice(0, GUARANTEED)
    .map((x) => key(x.q.i, x.q.j));
  const linked = (a, b) => edgeHash(a, b) < LINK_CHANCE || kept(a).includes(key(b.i, b.j)) || kept(b).includes(key(a.i, a.j));

  const cache = new Map();
  /** Titles this place links to, in a fixed order. Always mutual. */
  function links(title) {
    if (cache.has(title)) return cache.get(title);
    const p = parse(title);
    const out = p ? around(p).filter((q) => linked(p, q)).map((q) => key(q.i, q.j)) : [];
    cache.set(title, out);
    return out;
  }

  const stub = (title) => {
    const p = parse(title);
    return { title, kind: 'article', description: '', popularity: p ? 0.15 + 0.7 * hash(seed ^ 0x5bd1e995, p.i, p.j) : 0.3 };
  };
  const article = (title) => {
    const l = links(title);
    return { ...stub(title), summary: '', thumbnail: null, url: '', leadLinks: l.slice(), links: l.slice() };
  };

  return {
    links,
    async randomStart() { return article(key(0, 0)); },
    async getArticle(title) {
      if (!parse(title)) throw new Error(`No place ${title}`);
      return article(title);
    },
    async getStubs(titles) {
      const out = new Map();
      for (const t of titles) if (parse(t)) out.set(t, stub(t));
      return out;
    },
    async getArticleHtml() { return ''; },
  };
}
