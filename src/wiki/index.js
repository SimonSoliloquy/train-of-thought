// Wikipedia data layer for Train of Thought. Implements WikiApi (see src/types.js) on top of the
// live English Wikipedia Action API. Browser (anonymous CORS) and Node 24 compatible.
import { WIKI } from '../config.js';
import { createClient } from './http.js';
import { extractLeadCandidates } from './lead.js';
import { extractWikitextLinks, orderLinks } from './order.js';
import { FALLBACK_STARTS } from './fallback.js';

const LIST_PREFIXES = ['List of ', 'Lists of ', 'Outline of ', 'Index of ', 'Timeline of '];
const TITLE_CHUNK = 50; // titles per metadata request (API limit for anonymous clients)
const VIEWS_CHUNK = 5; // titles per pageviews request: a cold lookup fills only ~5 titles per call, so ask for 5 in parallel
const VIEWS_DAYS = 7;
const LEAD_CANDIDATE_CAP = 50;
const POP_DECENT = 0.5; // ~300 views/day: good enough to stop sampling
const RANDOM_SAMPLE = 100;
const RANDOM_ROUNDS = 3;
const RANDOM_MIN_BYTES = 8000;
const RANDOM_VIEW_CHECKS = 12;
const RANDOM_ARTICLE_TRIES = 4;
const CACHE_MAX = 30000;

export const normTitle = (t) => String(t).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

export function detectKind(title, pageprops) {
  if (pageprops && pageprops.disambiguation !== undefined) return 'disambiguation';
  if (LIST_PREFIXES.some((p) => title.startsWith(p))) return 'list';
  return 'article';
}

/** Average of the non-null daily views -> 0..1, log scaled: 100,000/day = 1, 10/day ~ 0.2, 0 = 0. */
export function popularityFromViews(pageviews) {
  if (!pageviews) return 0;
  let sum = 0;
  let n = 0;
  for (const v of Object.values(pageviews)) {
    if (typeof v === 'number') {
      sum += v;
      n++;
    }
  }
  if (!n) return 0;
  return scaleViews(sum / n);
}

export function scaleViews(perDay) {
  if (!(perDay > 0)) return 0;
  const p = Math.log10(1 + perDay) / 5;
  return Math.round(Math.min(1, Math.max(0, p)) * 1000) / 1000;
}

function articleUrl(apiUrl, title) {
  let origin = 'https://en.wikipedia.org';
  try {
    origin = new URL(apiUrl).origin;
  } catch {
    /* keep default */
  }
  return `${origin}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%3A/gi, ':').replace(/%2C/gi, ',').replace(/%28/g, '(').replace(/%29/g, ')')}`;
}

function firstParagraph(extract) {
  if (!extract) return '';
  const para = String(extract)
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .find((s) => s.length > 0);
  return para || '';
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Merge continuation pieces of the same page (objects merge one level deep). */
function mergePage(into, add) {
  for (const [k, v] of Object.entries(add)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object') Object.assign(into[k], v);
    else into[k] = v;
  }
  return into;
}

/** Follows `normalized` and `redirects` from a query response to the canonical title for a requested key. */
function mapTitle(maps, key) {
  let t = maps.normalized.get(key) || key;
  for (let i = 0; i < 6 && maps.redirects.has(t); i++) t = maps.redirects.get(t);
  return t;
}

function collectMaps(maps, body) {
  const q = body.query || {};
  for (const n of q.normalized || []) maps.normalized.set(n.from, n.to);
  for (const r of q.redirects || []) maps.redirects.set(r.from, r.to);
  return q;
}

function boundedSet(map, key, value) {
  map.set(key, value);
  if (map.size > CACHE_MAX) {
    let drop = Math.floor(CACHE_MAX / 6);
    for (const k of map.keys()) {
      if (drop-- <= 0) break;
      map.delete(k);
    }
  }
}

/**
 * @param {{
 *   fetch?: typeof fetch, apiUrl?: string, concurrency?: number, retries?: number, timeoutMs?: number,
 *   sleep?: (ms:number)=>Promise<void>, random?: ()=>number, userAgent?: string
 * }} [options]
 * @returns {import('../types.js').WikiApi & { stats: {requests:number, attempts:number, retries:number}, clearCache: () => void }}
 */
const FEATURED_CATEGORY = 'Category:Featured articles';
const FEATURED_SAMPLE = 40;
const FEATURED_ROUNDS = 3;
const FEATURED_TRIES = 5;

/** A random sort-key prefix ("Mo", "T") for jumping into the featured-articles category. Pure. */
export function featuredPrefix(random, letters = 2) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const a = 'abcdefghijklmnopqrstuvwxyz';
  let out = A[Math.min(25, Math.floor(random() * 26))];
  for (let i = 1; i < letters; i++) out += a[Math.min(25, Math.floor(random() * 26))];
  return out;
}

const REDIRECT_RESOLVE_CAP = 200; // written link targets to resolve per article (4 requests at most)

export function createWiki(options = {}) {
  const apiUrl = options.apiUrl || WIKI.apiUrl;
  const random = options.random || Math.random;
  const client = createClient({
    apiUrl,
    fetch: options.fetch,
    concurrency: options.concurrency ?? 4,
    retries: options.retries,
    timeoutMs: options.timeoutMs,
    sleep: options.sleep,
    userAgent: options.userAgent,
    backoffMs: options.backoffMs,
  });

  // key (a title as requested, normalised) -> { title, ns, kind, description, length } | null (missing)
  const baseCache = new Map();
  const baseInflight = new Map();
  // canonical title -> popularity
  const viewsCache = new Map();
  const viewsInflight = new Map();
  // canonical title -> Article
  const articleCache = new Map();
  const articleInflight = new Map();

  // ------------------------------------------------------------------ metadata (cheap, 50 per request)

  function rememberBase(key, entry, maps) {
    boundedSet(baseCache, key, entry);
    if (entry) {
      boundedSet(baseCache, entry.title, entry);
      if (maps) {
        // every redirect source we saw also resolves to its target
        for (const [from, to] of maps.redirects) if (to === entry.title) boundedSet(baseCache, from, entry);
      }
    }
  }

  async function fetchBaseChunk(keys) {
    const maps = { normalized: new Map(), redirects: new Map() };
    const pages = new Map(); // title -> page
    await client.getAll(
      { action: 'query', titles: keys, redirects: 1, prop: 'pageprops|description|info', ppprop: 'disambiguation' },
      (body) => {
        const q = collectMaps(maps, body);
        for (const p of q.pages || []) {
          const id = p.title ?? `#${pages.size}`;
          pages.set(id, pages.has(id) ? mergePage(pages.get(id), p) : p);
        }
      },
    );
    const result = new Map();
    for (const key of keys) {
      const page = pages.get(mapTitle(maps, key));
      if (!page || page.missing || page.invalid) {
        result.set(key, null);
        continue;
      }
      result.set(key, {
        title: page.title,
        ns: page.ns ?? 0,
        kind: detectKind(page.title, page.pageprops),
        description: page.description || '',
        length: page.length || 0,
      });
    }
    for (const [key, entry] of result) rememberBase(key, entry, maps);
    return result;
  }

  /** Resolve titles to canonical metadata. Map key -> entry | null (missing). Cached, deduped, batched. */
  async function lookup(keys) {
    const unique = [...new Set(keys)];
    const need = [];
    for (const k of unique) if (!baseCache.has(k) && !baseInflight.has(k)) need.push(k);
    for (const group of chunk(need, TITLE_CHUNK)) {
      const p = fetchBaseChunk(group);
      for (const k of group) {
        const kp = p.then((m) => m.get(k) ?? null);
        baseInflight.set(k, kp);
        kp.then(
          () => baseInflight.delete(k),
          () => baseInflight.delete(k),
        );
      }
    }
    const out = new Map();
    await Promise.all(
      unique.map(async (k) => {
        out.set(k, baseCache.has(k) ? baseCache.get(k) : await baseInflight.get(k));
      }),
    );
    return out;
  }

  // ------------------------------------------------------------------ popularity (a few titles per request)

  async function fetchViewsChunk(titles) {
    const found = new Map();
    await client.getAll({ action: 'query', titles, prop: 'pageviews', pvipdays: VIEWS_DAYS }, (body) => {
      for (const p of (body.query && body.query.pages) || []) {
        if (!p.pageviews) continue;
        found.set(p.title, mergePage(found.get(p.title) || { pageviews: {} }, { pageviews: p.pageviews }));
      }
    }, 40);
    const result = new Map();
    for (const t of titles) {
      const pv = found.get(t);
      const pop = pv ? popularityFromViews(pv.pageviews) : 0;
      result.set(t, pop);
      boundedSet(viewsCache, t, pop);
    }
    return result;
  }

  /** canonical titles -> Map title -> popularity. Failures degrade to 0 and are not cached. */
  async function popularityOf(titles) {
    const unique = [...new Set(titles)];
    const need = [];
    for (const t of unique) if (!viewsCache.has(t) && !viewsInflight.has(t)) need.push(t);
    for (const group of chunk(need, VIEWS_CHUNK)) {
      const p = fetchViewsChunk(group);
      for (const t of group) {
        const tp = p.then((m) => m.get(t) ?? 0);
        viewsInflight.set(t, tp);
        const done = () => viewsInflight.delete(t);
        tp.then(done, done);
      }
    }
    const out = new Map();
    await Promise.all(
      unique.map(async (t) => {
        if (viewsCache.has(t)) return out.set(t, viewsCache.get(t));
        try {
          out.set(t, await viewsInflight.get(t));
        } catch {
          out.set(t, 0);
        }
      }),
    );
    return out;
  }

  const toStub = (entry, popularity) => ({
    title: entry.title,
    kind: entry.kind,
    description: entry.description,
    popularity,
  });

  // ------------------------------------------------------------------ getStubs

  async function getStubs(titles) {
    const keys = titles.map(normTitle);
    const base = await lookup(keys);
    const canon = [...new Set([...base.values()].filter(Boolean).map((e) => e.title))];
    const pops = await popularityOf(canon);
    const out = new Map();
    titles.forEach((original, i) => {
      const entry = base.get(keys[i]);
      if (entry) out.set(original, toStub(entry, pops.get(entry.title) ?? 0));
    });
    return out;
  }

  // ------------------------------------------------------------------ getArticle

  async function fetchMeta(key) {
    const maps = { normalized: new Map(), redirects: new Map() };
    const pages = new Map();
    await client.getAll(
      {
        action: 'query',
        titles: key,
        redirects: 1,
        prop: 'extracts|pageimages|pageprops|description|pageviews|info',
        exintro: 1,
        explaintext: 1,
        exsentences: 3,
        piprop: 'thumbnail',
        pithumbsize: 320,
        ppprop: 'disambiguation',
        pvipdays: VIEWS_DAYS,
      },
      (body) => {
        const q = collectMaps(maps, body);
        for (const p of q.pages || []) {
          const id = p.title ?? '?';
          pages.set(id, pages.has(id) ? mergePage(pages.get(id), p) : p);
        }
      },
    );
    const page = pages.get(mapTitle(maps, key)) || [...pages.values()][0];
    if (!page || page.missing || page.invalid) return null;
    return { page, maps };
  }

  async function fetchLeadCandidates(key) {
    const body = await client.get({
      action: 'parse',
      page: key,
      prop: 'text',
      section: 0,
      redirects: 1,
      disableeditsection: 1,
      disablelimitreport: 1,
      disabletoc: 1,
    });
    const html = body.parse && body.parse.text;
    if (typeof html !== 'string') throw new Error(`No lead text for "${key}"`);
    return extractLeadCandidates(html).slice(0, LEAD_CANDIDATE_CAP);
  }

  async function fetchLeadLinks(key) {
    const candidates = await fetchLeadCandidates(key);
    const base = await lookup(candidates);
    const out = [];
    for (const c of candidates) {
      const e = base.get(c);
      if (e && e.ns === 0) out.push(e.title);
    }
    return out; // may contain duplicates / self; cleaned once the article's own title is known
  }

  /** Link targets as written on the page, in reading order (redirects not yet resolved). */
  async function fetchWrittenLinks(key) {
    const body = await client.get({ action: 'parse', page: key, prop: 'wikitext', redirects: 1 });
    const wt = body.parse && body.parse.wikitext;
    const text = typeof wt === 'string' ? wt : wt && typeof wt['*'] === 'string' ? wt['*'] : null;
    if (text === null) throw new Error(`No wikitext for "${key}"`);
    return extractWikitextLinks(text);
  }

  const htmlCache = new Map();

  /** The article as Wikipedia renders it (parser HTML). Callers must sanitise before showing it. */
  async function getArticleHtml(title) {
    const key = normTitle(title);
    if (!key) throw new Error('getArticleHtml: empty title');
    if (htmlCache.has(key)) return htmlCache.get(key);
    const body = await client.get({
      action: 'parse', page: key, prop: 'text', redirects: 1,
      disableeditsection: 1, disablelimitreport: 1, disabletoc: 1,
    });
    const html = body.parse && body.parse.text;
    const text = typeof html === 'string' ? html : html && typeof html['*'] === 'string' ? html['*'] : null;
    if (text === null) throw new Error(`No text for "${key}"`);
    boundedSet(htmlCache, key, text);
    return text;
  }

  async function fetchAllLinks(key) {
    const titles = [];
    const seen = new Set();
    await client.getAll(
      { action: 'query', generator: 'links', titles: key, redirects: 1, gplnamespace: 0, gpllimit: 'max' },
      (body) => {
        for (const p of (body.query && body.query.pages) || []) {
          if (p.missing || p.invalid || p.ns !== 0 || seen.has(p.title)) continue;
          seen.add(p.title);
          titles.push(p.title);
        }
        if (titles.length >= WIKI.maxLinks) return false;
        return undefined;
      },
      8,
    );
    return titles;
  }

  async function loadArticle(key) {
    const [metaR, leadR, linksR, writtenR] = await Promise.allSettled([fetchMeta(key), fetchLeadLinks(key), fetchAllLinks(key), fetchWrittenLinks(key)]);
    if (metaR.status === 'rejected') throw metaR.reason;
    if (!metaR.value) throw new Error(`Wikipedia has no article titled "${key}"`);
    if (leadR.status === 'rejected') throw leadR.reason;
    if (linksR.status === 'rejected') throw linksR.reason;
    const { page, maps } = metaR.value;
    const title = page.title;

    const leadLinks = [];
    const leadSeen = new Set([title]);
    for (const t of leadR.value) {
      if (leadSeen.has(t)) continue;
      leadSeen.add(t);
      leadLinks.push(t);
      if (leadLinks.length >= WIKI.maxLeadLinks) break;
    }
    // Every link in order of appearance on the page. The API lists links alphabetically, so the
    // order comes from the wikitext; written targets that are redirects are resolved (a few
    // batched lookups at most). If the wikitext cannot be had, fall back to lead links first.
    let links = null;
    if (writtenR.status === 'fulfilled' && writtenR.value.length) {
      const known = new Set(linksR.value);
      const unresolved = writtenR.value.filter((w) => !known.has(w)).slice(0, REDIRECT_RESOLVE_CAP);
      let resolved = new Map();
      try {
        resolved = unresolved.length ? await lookup(unresolved) : resolved;
      } catch {
        resolved = new Map();
      }
      const canonical = (w) => {
        const e = resolved.get(w);
        return e && e.ns === 0 ? e.title : null;
      };
      links = orderLinks(writtenR.value, canonical, [...leadLinks, ...linksR.value], title, WIKI.maxLinks);
    }
    if (!links) {
      links = [...leadLinks];
      const linkSeen = new Set([title, ...leadLinks]);
      for (const t of linksR.value) {
        if (links.length >= WIKI.maxLinks) break;
        if (linkSeen.has(t)) continue;
        linkSeen.add(t);
        links.push(t);
      }
    } else {
      // links must always contain every lead link
      const have = new Set(links);
      for (const t of leadLinks) if (!have.has(t)) links.push(t);
    }

    const entry = {
      title,
      ns: page.ns ?? 0,
      kind: detectKind(title, page.pageprops),
      description: page.description || '',
      length: page.length || 0,
    };
    const popularity = popularityFromViews(page.pageviews);
    rememberBase(key, entry, maps);
    boundedSet(viewsCache, title, popularity);

    return {
      title,
      kind: entry.kind,
      description: entry.description,
      popularity,
      summary: firstParagraph(page.extract),
      thumbnail: (page.thumbnail && page.thumbnail.source) || null,
      url: articleUrl(apiUrl, title),
      leadLinks,
      links,
    };
  }

  function getArticle(title) {
    const key = normTitle(title);
    if (!key) return Promise.reject(new Error('getArticle: empty title'));
    const known = baseCache.get(key);
    const canon = known ? known.title : key;
    if (articleCache.has(canon)) return Promise.resolve(articleCache.get(canon));
    if (articleInflight.has(canon)) return articleInflight.get(canon);
    const p = loadArticle(canon).then(
      (article) => {
        boundedSet(articleCache, article.title, article);
        articleInflight.delete(canon);
        return article;
      },
      (err) => {
        articleInflight.delete(canon);
        throw err;
      },
    );
    articleInflight.set(canon, p);
    return p;
  }

  // ------------------------------------------------------------------ randomStart

  const goodStart = (a) =>
    a.kind === 'article' && a.leadLinks.length >= WIKI.startMinLeadLinks && a.links.length >= WIKI.startMinLinks;

  async function randomRound() {
    const body = await client.get({ action: 'query', list: 'random', rnnamespace: 0, rnlimit: RANDOM_SAMPLE, rnfilterredir: 'nonredirects' });
    const titles = ((body.query && body.query.random) || []).map((r) => r.title);
    const base = await lookup(titles);
    // Long articles are a free (same request) proxy for well-known ones; check real views only for the best of them.
    const cands = [...base.values()]
      .filter((e) => e && e.ns === 0 && e.kind === 'article' && e.length >= RANDOM_MIN_BYTES)
      .sort((a, b) => b.length - a.length)
      .slice(0, RANDOM_VIEW_CHECKS);
    const pops = await popularityOf(cands.map((e) => e.title));
    return cands.map((e) => ({ title: e.title, popularity: pops.get(e.title) ?? 0 })).sort((a, b) => b.popularity - a.popularity);
  }

  /** A handful of Wikipedia's featured articles, from a random place in the alphabet. */
  async function featuredRound() {
    for (const prefix of [featuredPrefix(random, 2), featuredPrefix(random, 1)]) {
      const body = await client.get({
        action: 'query', list: 'categorymembers', cmtitle: FEATURED_CATEGORY, cmnamespace: 0,
        cmlimit: FEATURED_SAMPLE, cmsort: 'sortkey', cmstartsortkeyprefix: prefix,
      });
      const titles = ((body.query && body.query.categorymembers) || []).filter((m) => m.ns === 0).map((m) => m.title);
      if (titles.length >= 5) {
        // shuffle, so the pick is not always the first title after the prefix
        for (let i = titles.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [titles[i], titles[j]] = [titles[j], titles[i]];
        }
        return titles;
      }
    }
    return [];
  }

  async function randomStart() {
    // The start is one of Wikipedia's featured articles (Wikipedia:Featured articles): its best
    // pages, with pictures and plenty of links. Only if that list cannot be reached does the
    // game fall back to a well-known random article.
    for (let round = 0; round < FEATURED_ROUNDS; round++) {
      let titles = [];
      try {
        titles = await featuredRound();
      } catch {
        continue;
      }
      for (const title of titles.slice(0, FEATURED_TRIES)) {
        try {
          const article = await getArticle(title);
          if (goodStart(article)) return article;
        } catch {
          // try the next one
        }
      }
    }

    let best = null;
    for (let round = 0; round < RANDOM_ROUNDS; round++) {
      let cands = [];
      try {
        cands = await randomRound();
      } catch {
        continue;
      }
      let tries = 0;
      for (const c of cands) {
        if (tries >= RANDOM_ARTICLE_TRIES) break;
        if (best && c.popularity <= best.popularity) break;
        tries++;
        let article;
        try {
          article = await getArticle(c.title);
        } catch {
          continue;
        }
        if (!goodStart(article)) continue;
        if (article.popularity >= POP_DECENT) return article;
        if (!best || article.popularity > best.popularity) best = article;
      }
    }
    if (best) return best;

    const pool = [...FALLBACK_STARTS];
    let lastErr;
    while (pool.length) {
      const title = pool.splice(Math.floor(random() * pool.length), 1)[0];
      try {
        const article = await getArticle(title);
        if (goodStart(article) || !pool.length) return article;
        best = best || article;
      } catch (e) {
        lastErr = e;
      }
    }
    if (best) return best;
    throw lastErr || new Error('randomStart: could not load any starting article');
  }

  return {
    randomStart,
    getArticle,
    getArticleHtml,
    getStubs,
    stats: client.stats,
    clearCache() {
      baseCache.clear();
      viewsCache.clear();
      articleCache.clear();
    },
  };
}
