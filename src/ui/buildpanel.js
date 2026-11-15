// The build panel: choose where to build from, compare the cheap and direct quotes, build.
import { h, clear, setText, setClass, setDisabled } from './dom.js';
import { fmtMoney, fmtInt, summarizeQuote, terrainText, quoteAffordable, needsRequote, buildSources, pickDefaultSource } from './format.js';

const STYLE_NAME = {
  cheap: { title: 'Cheap', sub: 'winds round water and hills' },
  direct: { title: 'Direct', sub: 'shortest, bridges and tunnels' },
  same: { title: 'Route', sub: 'cheap and direct are the same' },
};

export function createBuildPanel(ctx) {
  const { game, renderer, state } = ctx;
  const el = h('section', { class: 'tot-build' });
  /** open panel: { to, from, sources, style, quote, error, lastInfl, inflight, cards, buildBtn, ... } */
  let cur = null;

  function close() {
    if (cur) {
      cur = null;
      renderer.setRoutePreview(null);
    }
    clear(el);
  }

  function open(to, preferredFrom) {
    close();
    const sources = buildSources(to, state, (a, b) => !!game.trackBetween(a, b));
    cur = {
      to, sources,
      from: pickDefaultSource(sources, preferredFrom),
      style: 'cheap', quote: null, error: '', lastInfl: 0, inflight: false,
      cards: null, buildBtn: null, quotesBox: null,
    };
    const toBuilt = state.stations.has(to);
    el.append(h('h3', { text: toBuilt ? 'Connect with new track' : 'Build track' }));

    if (!sources.length) {
      el.append(h('p', { class: 'tot-note', text: toBuilt
        ? 'No unconnected station links to or from this one.'
        : 'None of your built stations links to this article.' }));
      return;
    }

    const fromBox = h('label', { class: 'tot-from-pick' }, h('span', { class: 'tot-k', text: 'Build from' }));
    if (sources.length > 1) {
      const sel = h('select', { class: 'tot-select', 'aria-label': 'Build from' });
      for (const s of sources) sel.append(h('option', { value: s, text: s }));
      sel.value = cur.from;
      sel.addEventListener('change', () => {
        cur.from = sel.value;
        requote();
      });
      fromBox.append(sel);
    } else {
      fromBox.append(h('strong', { class: 'tot-from-one', text: cur.from }));
    }
    cur.quotesBox = h('div', { class: 'tot-quotes' });
    cur.buildBtn = h('button', { class: 'tot-btn tot-btn-primary tot-buildbtn', type: 'button', onClick: doBuild, text: 'Build' });
    cur.hint = h('div', { class: 'tot-note' });
    el.append(fromBox, cur.quotesBox, h('div', { class: 'tot-buildrow' }, cur.buildBtn, cur.hint));
    requote();
  }

  function preview(active) {
    if (!cur || !cur.quote) return;
    const q = cur.quote;
    renderer.setRoutePreview(q.same ? [q.cheap.route] : [q.cheap.route, q.direct.route], active || cur.style);
  }

  function requote() {
    if (!cur) return;
    const res = game.quoteBuild(cur.from, cur.to);
    cur.lastInfl = state.inflation;
    if (!res || !res.ok) {
      cur.quote = null;
      cur.error = (res && res.reason) || 'No quote available.';
      renderer.setRoutePreview(null);
    } else {
      cur.quote = res;
      cur.error = '';
      if (res.same) cur.style = 'cheap';
    }
    drawQuotes();
    preview();
  }

  function quoteCard(key, q, same) {
    const s = summarizeQuote(q);
    const name = STYLE_NAME[same ? 'same' : key];
    const total = h('div', { class: 'tot-qtotal' });
    const poor = h('div', { class: 'tot-qpoor', text: 'Cannot afford', hidden: true });
    const card = h(
      'button',
      { class: 'tot-quote', type: 'button', 'aria-pressed': 'false' },
      h('div', { class: 'tot-qhead' }, h('strong', { text: name.title }), h('span', { text: name.sub })),
      h('dl', { class: 'tot-qrows' },
        h('dt', { text: 'Track' }), h('dd', { text: `${fmtInt(s.trackHexes)} hexes` }),
        h('dt', { text: 'Terrain' }), h('dd', { text: terrainText(s) }),
        h('dt', { text: 'Track cost' }), h('dd', { text: fmtMoney(s.trackCost) }),
        h('dt', { text: 'Station' }), h('dd', { text: s.stationCost > 0 ? fmtMoney(s.stationCost) : 'already built' }),
      ),
      h('div', { class: 'tot-qfoot' }, h('span', { text: 'Total' }), total),
      poor,
    );
    card.addEventListener('click', () => {
      cur.style = key;
      markChosen();
      preview(key);
    });
    card.addEventListener('mouseenter', () => preview(key));
    card.addEventListener('mouseleave', () => preview(cur && cur.style));
    card.addEventListener('focus', () => preview(key));
    card.addEventListener('blur', () => preview(cur && cur.style));
    return { key, el: card, total, poor, quote: q };
  }

  function drawQuotes() {
    const box = cur.quotesBox;
    clear(box);
    cur.cards = null;
    if (!cur.quote) {
      box.append(h('p', { class: 'tot-note bad', text: cur.error }));
      updateLive();
      return;
    }
    const q = cur.quote;
    box.classList.toggle('single', !!q.same);
    cur.cards = q.same ? [quoteCard('cheap', q.cheap, true)] : [quoteCard('cheap', q.cheap, false), quoteCard('direct', q.direct, false)];
    for (const c of cur.cards) box.append(c.el);
    markChosen();
    updateLive();
  }

  function markChosen() {
    if (!cur || !cur.cards) return;
    for (const c of cur.cards) {
      const on = c.key === cur.style;
      setClass(c.el, 'chosen', on);
      c.el.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /** Cheap per-tick work: affordability against live money, button state. */
  function updateLive() {
    if (!cur) return;
    let chosenOk = false;
    if (cur.cards) {
      for (const c of cur.cards) {
        setText(c.total, fmtMoney(c.quote.total));
        const ok = quoteAffordable(c.quote, state.money);
        setClass(c.el, 'poor', !ok);
        c.poor.hidden = ok;
        if (c.key === cur.style) chosenOk = ok;
      }
    }
    const q = cur.quote && (cur.style === 'direct' && !cur.quote.same ? cur.quote.direct : cur.quote.cheap);
    if (cur.inflight) setText(cur.buildBtn, 'Building…');
    else setText(cur.buildBtn, q ? `Build · ${fmtMoney(q.total)}` : 'Build');
    setDisabled(cur.buildBtn, cur.inflight || !q || !chosenOk);
    setText(cur.hint, cur.inflight ? '' : q && !chosenOk ? 'Not enough cash for this route.' : '');
  }

  function update() {
    if (!cur || !cur.quote) return;
    if (needsRequote(cur.lastInfl, state.inflation)) requote();
    else updateLive();
  }

  async function doBuild() {
    if (!cur || cur.inflight || !cur.quote) return;
    const mine = cur;
    const { from, to, style } = mine;
    mine.inflight = true;
    updateLive();
    let res;
    try {
      res = await game.build(from, to, style);
    } catch (err) {
      res = { ok: false, reason: (err && err.message) || 'Building failed.' };
    }
    mine.inflight = false;
    if (!ctx.report(res)) {
      if (cur === mine) requote();
      return;
    }
    // Only follow the new station if the player is still looking at this panel.
    if (cur === mine) ctx.select(to, { kind: 'station' });
  }

  return { el, open, close, update, requote, get isOpen() { return !!cur; }, get busy() { return !!(cur && cur.inflight); } };
}
