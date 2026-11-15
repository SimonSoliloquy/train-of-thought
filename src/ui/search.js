// The link list: while a built station is selected, a slim panel down the right edge lists every
// link on its article, in the order the article gives them, with a filter box. Rows are rendered
// 200 at a time and more as the player scrolls. A click prices a build to that link (as a signpost
// does); a link that is already a station is selected instead. The panel stays open while pricing.
import { h, clear, setText } from './dom.js';

const CHUNK = 200;

export function createSearch(ctx) {
  const { game, state } = ctx;
  const title = h('h2', { class: 'tot-ll-title' });
  const input = h('input', {
    class: 'tot-filter', type: 'search', placeholder: 'Filter links…', 'aria-label': 'Filter links',
    autocomplete: 'off', spellcheck: 'false',
  });
  const count = h('div', { class: 'tot-ll-count' });
  const list = h('ul', { class: 'tot-links' });
  const el = h('aside', { class: 'tot-panel tot-linklist', hidden: true }, title, input, count, list);
  let station = null;
  let all = [];       // the article's links, in order
  let shown = [];     // after filtering
  let rendered = 0;
  const marks = new Map(); // link title -> mark span, for rendered rows
  const pending = new Set();

  const markOf = (t) => {
    if (state.stations.has(t)) return 'Built';
    return (state.tickets || []).some((k) => k.to === t) ? 'Ticket' : '';
  };

  function more() {
    const end = Math.min(shown.length, rendered + CHUNK);
    const frag = document.createDocumentFragment();
    for (let i = rendered; i < end; i++) {
      const t = shown[i];
      const mark = h('span', { class: 'tot-linktag' });
      setText(mark, markOf(t));
      marks.set(t, mark);
      const btn = h('button', { class: 'tot-linkbtn', type: 'button' }, h('span', { class: 'tot-linkname', text: t }), mark);
      btn.dataset.title = t;
      if (pending.has(t)) btn.classList.add('busy');
      frag.append(h('li', { class: 'tot-linkrow' }, btn));
    }
    list.append(frag);
    rendered = end;
  }

  function rebuild() {
    const q = input.value.trim().toLowerCase();
    shown = q ? all.filter((t) => t.toLowerCase().includes(q)) : all;
    clear(list);
    marks.clear();
    rendered = 0;
    list.scrollTop = 0;
    more();
    count.textContent = shown.length ? '' : (all.length ? 'No links match.' : 'This page has no links.');
    count.hidden = !count.textContent;
  }

  /** Built stations and ticket destinations change: update the marks without rebuilding rows. */
  function refresh() {
    for (const [t, m] of marks) setText(m, markOf(t));
  }

  function choose(t) {
    const from = station;
    if (state.stations.has(t)) {
      if (game.trackBetween(from, t)) ctx.select(t, { focus: true });
      else ctx.openBuild(t, from);
      return;
    }
    if (state.stubs && state.stubs.has(t)) return ctx.openBuild(t, from);
    if (pending.has(t)) return;
    pending.add(t);
    const row = [...list.querySelectorAll('button')].find((b) => b.dataset.title === t);
    if (row) row.classList.add('busy');
    Promise.resolve()
      .then(() => game.survey(from, t))
      .catch((err) => ({ ok: false, reason: (err && err.message) || 'Could not find that link.' }))
      .then((res) => {
        pending.delete(t);
        if (row) row.classList.remove('busy');
        if (ctx.report(res) && station === from) ctx.openBuild(t, from);
      });
  }

  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (input.value) { input.value = ''; rebuild(); } else input.blur();
    } else if (e.key === 'Enter') {
      const first = list.querySelector('button[data-title]');
      if (first) first.click();
    }
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-title]');
    if (btn && station) choose(btn.dataset.title);
  });
  list.addEventListener('scroll', () => {
    if (rendered < shown.length && list.scrollTop + list.clientHeight > list.scrollHeight - 160) more();
  });

  /** The selection changed. */
  function onSelection() {
    const next = ctx.sel ? ctx.sel.title : null;
    if (next === station) return;
    station = next;
    el.hidden = !station;
    input.value = '';
    if (!station) { clear(list); marks.clear(); return; }
    const st = state.stations.get(station);
    all = (st && st.article && st.article.links) || [];
    setText(title, station);
    rebuild();
  }

  ctx.bus.on('selection', onSelection);
  return { el, refresh };
}
