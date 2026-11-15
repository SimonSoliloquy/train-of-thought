// The article panel: the station's real Wikipedia article. It opens ONLY when the player clicks a
// station (or the picture floating above it), never by itself, and closes with its close button,
// Esc, a click on empty map, or when the game moves on to another station. Closing it leaves the
// station selected, so its signposts stay. The article is the game board:
// every link in it to another article can be clicked to price a build towards that article,
// exactly as a signpost can. Stations you already have and ticket ends are marked in the text.
import { h, clear, setText } from './dom.js';
import { sanitizeArticle } from './sanitize.js';

export function createArticle(ctx, wiki) {
  const { game, state } = ctx;
  const title = h('h2', { class: 'tot-art-title' });
  const closeBtn = h('button', { class: 'tot-art-close', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close the article', text: '\u00d7', onClick: () => close() });
  const head = h('div', { class: 'tot-art-head' }, title, closeBtn);
  const body = h('div', { class: 'tot-article' });
  const el = h('aside', { class: 'tot-panel tot-artpanel', hidden: true, 'aria-label': 'Article' }, head, body);
  let station = null;   // title of the station whose article is showing
  let links = new Set(); // that article's links (canonical titles)
  let token = 0;         // guards against a slow article arriving after the selection moved on
  const pending = new Set();

  /** When the real page cannot be had: the intro, then every link in page order. */
  function fallback(st) {
    const a = (st && st.article) || {};
    const frag = document.createDocumentFragment();
    if (a.summary) frag.append(h('p', { text: a.summary }));
    const list = h('p', { class: 'tot-art-links' });
    (a.links || []).slice(0, 600).forEach((t, i) => {
      if (i) list.append(document.createTextNode(' · '));
      list.append(h('a', { class: 'tot-wl', 'data-title': t, role: 'button', tabindex: '0', text: t }));
    });
    frag.append(list);
    return frag;
  }

  async function show(t) {
    station = t;
    const st = state.stations.get(t);
    links = new Set((st && st.article && st.article.links) || []);
    el.hidden = false;
    setText(title, t);
    clear(body);
    body.scrollTop = 0;
    body.append(h('p', { class: 'tot-art-note', text: 'Loading the article…' }));
    const mine = ++token;
    let frag = null;
    try {
      if (!wiki || typeof wiki.getArticleHtml !== 'function') throw new Error('no article source');
      frag = sanitizeArticle(await wiki.getArticleHtml(t), document);
    } catch {
      frag = null;
    }
    if (mine !== token) return;
    clear(body);
    body.append(frag && frag.childNodes.length ? frag : fallback(st));
    body.scrollTop = 0;
    mark();
  }

  /** Mark links that are already stations, and the ends of tickets. */
  function mark() {
    if (!station) return;
    const ends = new Set();
    for (const t of state.tickets || []) { ends.add(t.to); if (!state.stations.has(t.from)) ends.add(t.from); }
    for (const a of body.querySelectorAll('a.tot-wl')) {
      const t = a.dataset.title;
      a.classList.toggle('built', state.stations.has(t));
      a.classList.toggle('ticket', ends.has(t));
    }
  }

  /** A written link may be a redirect: find the article it really leads to. */
  async function resolve(raw) {
    if (links.has(raw)) return raw;
    if (!wiki || typeof wiki.getStubs !== 'function') return null;
    try {
      const got = await wiki.getStubs([raw]);
      const stub = got.get(raw);
      return stub && links.has(stub.title) ? stub.title : null;
    } catch {
      return null;
    }
  }

  async function choose(raw, anchor) {
    const from = station;
    if (!from || pending.has(raw)) return;
    pending.add(raw);
    if (anchor) anchor.classList.add('busy');
    try {
      const t = await resolve(raw);
      if (station !== from) return;
      if (!t) { ctx.toast('That page cannot be built towards from here.', 'bad'); return; }
      if (state.stations.has(t)) {
        if (game.trackBetween(from, t)) ctx.select(t, { focus: true });
        else ctx.openBuild(t, from);
        return;
      }
      if (!(state.stubs && state.stubs.has(t))) {
        let res;
        try { res = await game.survey(from, t); } catch (err) { res = { ok: false, reason: (err && err.message) || 'Could not find that link.' }; }
        if (!ctx.report(res) || station !== from) return;
      }
      ctx.openBuild(t, from);
    } finally {
      pending.delete(raw);
      if (anchor) anchor.classList.remove('busy');
    }
  }

  function onActivate(e) {
    const a = e.target && e.target.closest ? e.target.closest('a.tot-wl') : null;
    if (!a) return;
    e.preventDefault();
    choose(a.dataset.title, a);
  }
  body.addEventListener('click', onActivate);
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter') onActivate(e); });

  /** Close the panel (the station stays selected). Returns whether it was open. */
  function close() {
    if (!station) return false;
    station = null;
    token++;
    el.hidden = true;
    clear(body);
    return true;
  }

  /** The player clicked a station: show its article. */
  function open(t) {
    if (!t || !state.stations.has(t)) return;
    if (t === station) return;
    show(t);
  }

  /** The selection moved without a click on a station (a build finished, or it was cleared): put the article away. */
  function onSelection() {
    const next = ctx.sel ? ctx.sel.title : null;
    if (station && next !== station) close();
  }

  ctx.bus.on('selection', onSelection);
  return { el, open, close, refresh: mark, get isOpen() { return !!station; } };
}
