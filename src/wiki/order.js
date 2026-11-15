// Links in order of appearance. The API's own link list is alphabetical, so the reading order
// comes from the page's wikitext: every [[Target]] or [[Target|label]] in the order it is written.
// Pure functions; index.js does the fetching.

// Prefixes that are not articles. Anything else before a colon is treated as part of a title
// (e.g. "Star Trek: The Next Generation").
const NON_ARTICLE = new Set([
  'file', 'image', 'media', 'category', 'template', 'wikipedia', 'wp', 'help', 'portal', 'draft', 'module',
  'user', 'talk', 'special', 'mediawiki', 'book', 'timedtext', 'wikt', 'wiktionary', 's', 'wikisource',
  'commons', 'c', 'q', 'wikiquote', 'b', 'wikibooks', 'n', 'wikinews', 'v', 'wikiversity', 'voy',
  'd', 'wikidata', 'species', 'meta', 'm', 'mw', 'foundation', 'doi', 'iarchive',
]);

/** "some_title#Section" -> "Some title", or null when it is not an article link. */
export function normalizeTarget(raw) {
  let t = String(raw || '').replace(/_/g, ' ').trim();
  if (t.startsWith(':')) t = t.slice(1).trim();
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash).trim();
  if (!t) return null;
  const colon = t.indexOf(':');
  if (colon > 0) {
    const prefix = t.slice(0, colon).trim().toLowerCase();
    if (NON_ARTICLE.has(prefix) || prefix.endsWith(' talk') || /^[a-z]{2,3}(-[a-z]+)?$/.test(prefix)) return null; // namespaces and language links
  }
  t = t.replace(/\s+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Every article link target in the wikitext, in reading order, deduped. */
export function extractWikitextLinks(wikitext, cap = 4000) {
  const out = [];
  const seen = new Set();
  const text = String(wikitext || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<nowiki>[\s\S]*?<\/nowiki>/gi, '');
  const re = /\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(text)) && out.length < cap) {
    const t = normalizeTarget(m[1]);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * The page's links in order of appearance.
 * @param {string[]} written   targets as written in the wikitext, in order (may be redirects)
 * @param {(t: string) => string|null} canonical   resolves a written target to its real title, or null
 * @param {string[]} known     every link the API reports for the page (canonical titles)
 * @param {string} self        the page's own title
 * @returns {string[]} written links that the page really has, in order, then any the wikitext did
 *   not spell out (links made by templates such as navigation boxes), in the order given.
 */
export function orderLinks(written, canonical, known, self, cap = Infinity) {
  const has = new Set(known);
  const out = [];
  const seen = new Set([self]);
  for (const w of written) {
    if (out.length >= cap) return out;
    const t = has.has(w) ? w : canonical(w);
    if (!t || !has.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  for (const t of known) {
    if (out.length >= cap) break;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
