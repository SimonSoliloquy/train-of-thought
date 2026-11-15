// Extracts candidate link titles from the HTML of a page's lead section (action=parse, section=0).
// A small tolerant tokenizer instead of DOMParser so the same code runs in Node and the browser.

const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'wbr', 'area', 'col', 'source', 'track', 'base', 'embed']);

// Whole elements whose content is never a lead link.
const EXCLUDED_TAGS = new Set(['table', 'style', 'script', 'figure', 'figcaption', 'sup', 'sub', 'noscript', 'template', 'math', 'svg']);
const EXCLUDED_CLASSES = new Set([
  'infobox', 'infobox-above', 'vcard', 'biography', 'hatnote', 'dablink', 'rellink', 'navbox', 'vertical-navbox', 'navbox-inner',
  'sidebar', 'side-box', 'sistersitebox', 'metadata', 'ambox', 'mbox-small', 'navigation-not-searchable', 'toc', 'toccolours',
  'reflist', 'references', 'reference', 'reference-text', 'mw-references-wrap', 'mw-cite-backlink', 'noprint', 'thumb', 'thumbinner',
  'thumbcaption', 'tright', 'tleft', 'floatright', 'floatleft', 'gallery', 'gallerybox', 'geo', 'geo-default', 'geo-dec', 'geo-dms',
  'geo-nondefault', 'coordinates', 'shortdescription', 'mw-editsection', 'mw-empty-elt', 'portal', 'sister-box',
  'navbar', 'authority-control', 'ib-settlement', 'quotebox', 'cquote', 'pull-quote',
]);
const EXCLUDED_IDS = new Set(['coordinates', 'toc']);
// Reserved namespaces: cheap pre-filter. The real main-namespace check happens when the titles are resolved.
const RESERVED_PREFIX = /^(file|image|media|category|special|help|wikipedia|wp|project|template|portal|talk|user|user talk|draft|module|mediawiki|book|timedtext|gadget|topic|wikt|wiktionary|commons|d|wikidata)\s*:/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/** Turn an href like "/wiki/Foo_(bar)#x" into "Foo (bar)"; null if it is not a plain article link. */
export function hrefToTitle(rawHref) {
  if (!rawHref) return null;
  const href = decodeEntities(rawHref);
  if (!href.startsWith('/wiki/')) return null;
  if (href.includes('?')) return null;
  let t = href.slice(6);
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep as-is */
  }
  t = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || RESERVED_PREFIX.test(t)) return null;
  return t;
}

function isExcluded(tag, attrs) {
  if (EXCLUDED_TAGS.has(tag)) return true;
  if (attrs.id && EXCLUDED_IDS.has(attrs.id)) return true;
  if (attrs.class) {
    for (const c of attrs.class.split(/\s+/)) if (EXCLUDED_CLASSES.has(c)) return true;
  }
  if (attrs.role === 'note' || attrs.role === 'navigation') return true;
  return false;
}

/**
 * @param {string} html  rendered lead section
 * @returns {string[]} candidate titles in reading order (spaces, fragments stripped, not yet redirect-resolved):
 *   links inside lead paragraphs first, then links in lead list items; duplicates removed.
 */
export function extractLeadCandidates(html) {
  const paragraphs = [];
  const listItems = [];
  const seenP = new Set();
  const seenL = new Set();
  const stack = []; // { tag, excluded }
  let excludedDepth = 0;
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const rest = m[3];
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          while (stack.length > i) {
            const top = stack.pop();
            if (top.excluded) excludedDepth--;
          }
          break;
        }
      }
      continue;
    }
    const attrs = parseAttrs(rest);
    const selfClosing = /\/\s*$/.test(rest);
    if (tag === 'style' || tag === 'script') {
      // skip raw text content
      const end = html.indexOf('</' + tag, re.lastIndex);
      if (end >= 0) re.lastIndex = end;
      continue;
    }
    if (tag === 'a' && excludedDepth === 0) {
      const cls = (attrs.class || '').split(/\s+/);
      if (!cls.includes('new') && !cls.includes('image') && !cls.includes('external') && !cls.includes('mw-selflink')) {
        const title = hrefToTitle(attrs.href);
        if (title) {
          const inP = stack.some((s) => s.tag === 'p');
          const inList = stack.some((s) => s.tag === 'li' || s.tag === 'dd' || s.tag === 'dt');
          if (inP) {
            if (!seenP.has(title)) (seenP.add(title), paragraphs.push(title));
          } else if (inList) {
            if (!seenL.has(title)) (seenL.add(title), listItems.push(title));
          }
        }
      }
    }
    if (VOID.has(tag) || selfClosing) continue;
    const excluded = isExcluded(tag, attrs);
    if (excluded) excludedDepth++;
    stack.push({ tag, excluded });
  }
  const out = [...paragraphs];
  const have = new Set(paragraphs);
  for (const t of listItems) if (!have.has(t)) out.push(t);
  return out;
}
