// The station card (photo, title, a few lines of intro, a search box for other links) and the passenger card.
import { h, add, clear, setText, setWidth, thumbImg } from './dom.js';
import {
  fmtInt, fmtMoney, filterLinks, safeThumb, LINK_ROW_LIMIT,
  patienceFraction, patienceTone, passengerMood, thoughtLine, destinationStatus,
} from './format.js';

export function createCard(ctx) {
  const { game, state } = ctx;
  const el = h('aside', { class: 'tot-panel tot-card', hidden: true });
  let linksView = null; // { station, filter, input, list, wrap, pending, focused }
  let passenger = null; // refs for the live passenger card
  const outcomes = new Map(); // thought id -> how it ended, for a card left open
  let renderedKey = '';

  function render() {
    clear(el);
    linksView = null;
    passenger = null;
    const sel = ctx.sel;
    if (!sel) {
      renderedKey = '';
      el.hidden = true;
      return;
    }
    renderedKey = sel.kind + ':' + sel.title;
    el.hidden = false;
    el.scrollTop = 0;
    if (sel.kind === 'thought') renderThought(sel);
    else if (sel.kind === 'station' && state.stations.has(sel.title)) renderStation(sel);
    else ctx.deselect();
  }

  // ---------------------------------------------------------- station card

  function renderStation(sel) {
    const st = state.stations.get(sel.title);
    const a = st.article;

    const sign = h(
      'div',
      { class: 'tot-sign' },
      h('div', { class: 'tot-sign-text' }, h('h2', { text: a.title }), a.description ? h('p', { class: 'tot-desc', text: a.description }) : null),
    );
    // The article's main photo, shown under the station name.
    const hero = h('div', { class: 'tot-hero' });
    const heroSrc = safeThumb(a.thumbnail);
    if (heroSrc) {
      const img = thumbImg(heroSrc, 'tot-hero-img');
      img.addEventListener('error', () => hero.classList.add('empty'));
      hero.append(img);
    } else hero.classList.add('empty');

    // One search box. Matching links show only while it has focus or text in it.
    const input = h('input', {
      class: 'tot-filter', type: 'search', placeholder: 'Find another link to build towards\u2026',
      'aria-label': 'Find another link to build towards', autocomplete: 'off', spellcheck: 'false',
    });
    const list = h('ul', { class: 'tot-links', hidden: true });
    const wrap = h('div', { class: 'tot-search' }, input, list);
    linksView = { station: st.title, filter: '', input, list, wrap, pending: new Set(), focused: false };

    const syncOpen = () => {
      const v = linksView;
      if (!v) return;
      const open = v.focused || !!input.value;
      list.hidden = !open;
      wrap.classList.toggle('open', open);
      if (open) renderLinks();
    };
    let timer = 0;
    input.addEventListener('focus', () => { linksView.focused = true; syncOpen(); });
    input.addEventListener('blur', () => { if (linksView) { linksView.focused = false; syncOpen(); } });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!linksView) return;
        linksView.filter = input.value;
        syncOpen();
        list.scrollTop = 0;
      }, 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (input.value) {
          input.value = '';
          linksView.filter = '';
          syncOpen();
        } else input.blur();
      } else if (e.key === 'Enter') {
        const first = list.querySelector('button[data-act]');
        if (first) first.click();
      }
    });
    // Keep the box focused while a result is pressed, or the list would close before the click lands.
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', onLinkClick);

    add(el, [
      sign,
      hero,
      a.summary ? h('p', { class: 'tot-summary', text: a.summary }) : null,
      wrap,
    ]);
  }

  function renderLinks() {
    const v = linksView;
    if (!v || v.list.hidden) return;
    const st = state.stations.get(v.station);
    if (!st) return;
    const { rows, total } = filterLinks(st.article, v.filter, LINK_ROW_LIMIT);
    const top = v.list.scrollTop;
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const isStation = state.stations.has(row.title);
      const btn = h('button', { class: 'tot-linkbtn', type: 'button' },
        h('span', { class: 'tot-linkname', text: row.title }),
        isStation ? h('span', { class: 'tot-linktag', text: 'Station' }) : null,
      );
      btn.dataset.title = row.title;
      btn.dataset.act = 'link';
      if (v.pending.has(row.title)) btn.classList.add('busy');
      frag.append(h('li', { class: 'tot-linkrow' }, btn));
    }
    clear(v.list);
    if (!rows.length) v.list.append(h('li', { class: 'tot-empty', text: v.filter ? 'No links match.' : 'This page has no links.' }));
    v.list.append(frag);
    if (total > rows.length) v.list.append(h('li', { class: 'tot-empty', text: `${fmtInt(total - rows.length)} more. Type to narrow it down.` }));
    v.list.scrollTop = top;
  }

  function onLinkClick(e) {
    const btn = e.target.closest('button[data-act]');
    const v = linksView;
    if (!btn || !v) return;
    const title = btn.dataset.title;
    const from = v.station;
    const done = () => {
      v.input.value = '';
      v.filter = '';
      v.input.blur();
    };
    // A station already joined by track just gets selected; anything else is priced.
    if (state.stations.has(title)) {
      if (game.trackBetween(from, title)) ctx.select(title, { focus: true });
      else ctx.openBuild(title, from, { focus: true });
      done();
      return;
    }
    if (state.stubs && state.stubs.has(title)) {
      ctx.openBuild(title, from, { focus: true });
      done();
      return;
    }
    if (v.pending.has(title)) return;
    v.pending.add(title);
    btn.classList.add('busy');
    Promise.resolve()
      .then(() => game.survey(from, title))
      .catch((err) => ({ ok: false, reason: (err && err.message) || 'Could not find that link.' }))
      .then((res) => {
        v.pending.delete(title);
        const ok = ctx.report(res);
        if (linksView === v) renderLinks();
        // Only jump to the build card if the player is still on the station they searched from.
        if (ok && ctx.sel && ctx.sel.kind === 'station' && ctx.sel.title === from) {
          ctx.openBuild(title, from, { focus: true });
          if (linksView === v) done();
        }
      });
  }

  // ---------------------------------------------------------- passenger (a thought)

  function renderThought(sel) {
    const th = state.thoughts.find((t) => t.id === sel.id);
    const ended = outcomes.get(sel.id);
    if (!th && !ended) { ctx.deselect(); return; }
    const to = th ? th.to : ended.to;
    const sign = h(
      'div',
      { class: 'tot-sign ghost' },
      h('div', { class: 'tot-sign-text' },
        h('div', { class: 'tot-eyebrow', text: th ? (th.state === 'riding' ? 'Passenger on a train' : 'Passenger waiting') : 'Passenger' }),
        h('h2', { text: '\u2192 ' + to }),
        h('p', { class: 'tot-desc', text: (th ? th.toDescription : ended.toDescription) || '' })),
    );
    const quote = h('p', { class: 'tot-quote' });
    const body = h('div', { class: 'tot-card-scroll grow' }, quote);
    el.append(sign, body);
    if (!th) {
      setText(quote, ended.text);
      quote.classList.add(ended.good ? 'good' : 'bad');
      return;
    }
    const fare = h('b');
    const where = h('b');
    const fill = h('div', { class: 'tot-bar-fill' });
    body.append(
      h('div', { class: 'tot-stats two' },
        h('div', { class: 'tot-stat' }, h('span', { class: 'tot-k', text: 'Will pay' }), fare),
        h('div', { class: 'tot-stat' }, h('span', { class: 'tot-k', text: 'Where' }), where),
      ),
      h('div', { class: 'tot-k tot-patience-k', text: 'Patience' }),
      h('div', { class: 'tot-bar tot-bar-big' }, fill),
    );
    passenger = { id: th.id, quote, fare, where, fill, key: '' };
    updatePassenger();
  }

  function updatePassenger() {
    const p = passenger;
    if (!p) return;
    const th = state.thoughts.find((t) => t.id === p.id);
    if (!th) { render(); return; } // delivered or gave up: redraw with the outcome, or close
    const frac = patienceFraction(th);
    const mood = passengerMood(frac);
    const status = destinationStatus(th, state);
    setText(p.fare, fmtMoney(th.fare));
    setText(p.where, th.state === 'riding' ? 'On a train' : th.at || th.from);
    setWidth(p.fill, frac);
    const tone = patienceTone(frac);
    if (p.fill._tone !== tone) { p.fill.className = 'tot-bar-fill ' + tone; p.fill._tone = tone; }
    // the words and buttons only change when the passenger's situation does
    const key = [th.state, mood, status, th.at].join('|');
    if (key === p.key) return;
    p.key = key;
    setText(p.quote, '\u201C' + thoughtLine({ to: th.to, state: th.state, mood, where: status, variant: th.id }) + '\u201D');
    p.quote.className = 'tot-quote' + (mood === 2 ? ' bad' : mood === 1 ? ' warn' : '');
  }

  // Remember how a passenger's journey ended, so a card left open can say so.
  const noteOutcome = (id, outcome) => {
    if (ctx.sel && ctx.sel.kind === 'thought' && ctx.sel.id === id) outcomes.set(id, outcome);
  };
  game.on('thoughtDelivered', (e) => {
    if (!e || !e.thought) return;
    noteOutcome(e.thought.id, { good: true, to: e.thought.to, toDescription: e.thought.toDescription, text: `Arrived at ${e.thought.to} and paid ${fmtMoney(e.fare)}.` });
  });
  game.on('thoughtLost', (e) => {
    if (!e || !e.thought) return;
    noteOutcome(e.thought.id, { good: false, to: e.thought.to, toDescription: e.thought.toDescription, text: `Gave up waiting for ${e.thought.to} and left.` });
  });

  /** Something on the map changed: refresh the link chips. */
  function refresh() {
    if (ctx.sel && ctx.sel.kind === 'station') renderLinks();
  }

  function update() {
    updatePassenger();
  }

  ctx.bus.on('selection', render);

  return { el, refresh, update, get key() { return renderedKey; } };
}
