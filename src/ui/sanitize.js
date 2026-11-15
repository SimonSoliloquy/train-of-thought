// Turns Wikipedia's article HTML into a safe DOM fragment for the article panel.
// Nothing from the page is trusted: only listed tags and attributes survive, scripts, styles,
// forms and embeds are dropped whole, images may only come from Wikimedia's image hosts, and
// every link is rewritten. A link to another article becomes a button-like anchor carrying
// data-title (clicking it builds towards that article); every other link becomes plain text.
import { hrefToTitle } from '../wiki/lead.js';

const KEEP = new Set([
  'div', 'p', 'span', 'a', 'b', 'i', 'em', 'strong', 'u', 's', 'sub', 'sup', 'small', 'br', 'hr',
  'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'td', 'th', 'caption', 'blockquote', 'pre', 'code', 'cite', 'q', 'abbr', 'img', 'figure', 'figcaption',
  'section', 'center', 'wbr', 'var', 'kbd', 'ins', 'del', 'mark', 'time', 'bdi', 'ruby', 'rt', 'rp',
]);
// Removed with everything inside them.
const DROP = new Set([
  'script', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select',
  'textarea', 'video', 'audio', 'source', 'track', 'svg', 'math', 'template', 'noscript', 'base', 'map', 'area',
  'canvas', 'frame', 'frameset', 'applet', 'title', 'head',
]);
// Whole blocks of the page that are furniture, not article: navigation boxes, notices, reference lists.
const DROP_CLASS = /(^|\s)(navbox|navbox-styles|vertical-navbox|sidebar|metadata|ambox|ombox|tmbox|sistersitebox|side-box|noprint|mw-editsection|reflist|references|mw-references-wrap|refbegin|reference|noexcerpt|mw-empty-elt|authority-control|portalbox|portal-bar|stub|catlinks|printfooter|shortdescription|toc|mw-jump-link|geo-nondefault|coordinates|haudio|listen)(\s|$)/;
const KEEP_CLASS = /^(infobox|infobox-[a-z-]+|hatnote|thumb|thumbinner|thumbcaption|thumbimage|mw-heading|mw-heading[2-6]|mw-headline|wikitable|mw-default-size|mw-halign-[a-z]+|mw-file-description|mw-file-element|gallery|gallerybox|gallerytext|quotebox|plainlist|hlist|mw-parser-output|IPA|nowrap|mw-redirect|mw-disambig)$/;
const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);

/** https image URL on a Wikimedia image host, or null. Accepts protocol-relative URLs. */
export function safeImageSrc(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw.startsWith('//') ? 'https:' + raw : raw, 'https://en.wikipedia.org');
    return u.protocol === 'https:' && IMAGE_HOSTS.has(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

function keptClasses(el) {
  const out = [];
  for (const c of String(el.getAttribute('class') || '').split(/\s+/)) if (c && KEEP_CLASS.test(c)) out.push(c);
  return out;
}

function cleanNode(node, doc, out) {
  if (node.nodeType === 3) { // text
    out.appendChild(doc.createTextNode(node.nodeValue));
    return;
  }
  if (node.nodeType !== 1) return; // comments and the rest
  const tag = node.tagName.toLowerCase();
  if (DROP.has(tag)) return;
  if (DROP_CLASS.test(node.getAttribute('class') || '')) return;
  if (!KEEP.has(tag)) { // unknown wrapper: keep what is inside it
    for (const child of node.childNodes) cleanNode(child, doc, out);
    return;
  }
  if (tag === 'img') {
    const src = safeImageSrc(node.getAttribute('src'));
    if (!src) return;
    const img = doc.createElement('img');
    img.setAttribute('src', src);
    img.setAttribute('alt', node.getAttribute('alt') || '');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('referrerpolicy', 'no-referrer');
    out.appendChild(img);
    return;
  }
  if (tag === 'a') {
    const cls = node.getAttribute('class') || '';
    const title = /(^|\s)new(\s|$)/.test(cls) ? null : hrefToTitle(node.getAttribute('href'));
    // An article link: something to build towards. Anything else: just its words.
    const el = doc.createElement(title ? 'a' : 'span');
    if (title) {
      el.setAttribute('class', 'tot-wl');
      el.setAttribute('data-title', title);
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
    }
    for (const child of node.childNodes) cleanNode(child, doc, el);
    if (el.childNodes.length) out.appendChild(el);
    return;
  }
  const el = doc.createElement(tag);
  const classes = keptClasses(node);
  if (classes.length) el.setAttribute('class', classes.join(' '));
  if (tag === 'td' || tag === 'th') {
    for (const a of ['colspan', 'rowspan']) {
      const v = node.getAttribute(a);
      if (v && /^\d{1,2}$/.test(v)) el.setAttribute(a, v);
    }
  }
  for (const child of node.childNodes) cleanNode(child, doc, el);
  out.appendChild(el);
}

/**
 * @param {string} html   Wikipedia parser output
 * @param {Document} doc  the page's document (elements are created with it)
 * @param {(html: string) => Document} [parse]  parses HTML without running it (DOMParser by default)
 * @returns {DocumentFragment}
 */
export function sanitizeArticle(html, doc, parse) {
  const parser = parse || ((h) => new doc.defaultView.DOMParser().parseFromString(h, 'text/html'));
  const parsed = parser(String(html || ''));
  const frag = doc.createDocumentFragment();
  for (const child of parsed.body.childNodes) cleanNode(child, doc, frag);
  return frag;
}
