// The places in Rail Builder. They stand where Wikipedia stands in the game (the WikiApi
// contract in src/types.js), so the same rules and map can run on them. There are no words and
// no network laid out in advance: a place exists once you click the ground to build there, and
// it links only to the stations you join it to.

function mix(a) {
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  return (a ^ (a >>> 16)) >>> 0;
}
const hash = (seed, n) => mix(mix(seed >>> 0 || 1) ^ mix((n | 0) + 0x9e3779b9)) / 4294967296;

export const START = 'p0';

export function createPlaces(seed = 1) {
  const linked = new Map(); // title -> Set of linked titles
  const pop = new Map();    // title -> popularity, how busy its passengers make it
  let made = 0;

  function add(title) {
    linked.set(title, new Set());
    pop.set(title, 0.15 + 0.7 * hash(seed, made));
    made++;
    return title;
  }
  add(START);

  /** Links two places both ways. */
  function join(a, b) {
    if (a === b || !linked.has(a) || !linked.has(b)) return false;
    linked.get(a).add(b);
    linked.get(b).add(a);
    return true;
  }

  /** A new place, linked to `from`. */
  function create(from) {
    const title = add(`p${made}`);
    join(from, title);
    return title;
  }

  /** Forgets a place that was never built. */
  function forget(title) {
    if (title === START || !linked.has(title)) return;
    for (const other of linked.get(title)) linked.get(other)?.delete(title);
    linked.delete(title);
    pop.delete(title);
  }

  const links = (title) => [...(linked.get(title) || [])];
  const stub = (title) => ({ title, kind: 'article', description: '', popularity: pop.get(title) });
  const article = (title) => ({ ...stub(title), summary: '', thumbnail: null, url: '', leadLinks: links(title), links: links(title) });

  return {
    links,
    create,
    join,
    forget,
    stub,
    async randomStart() { return article(START); },
    async getArticle(title) {
      if (!linked.has(title)) throw new Error(`No place ${title}`);
      return article(title);
    },
    async getStubs(titles) {
      const out = new Map();
      for (const t of titles) if (linked.has(t)) out.set(t, stub(t));
      return out;
    },
    async getArticleHtml() { return ''; },
  };
}
