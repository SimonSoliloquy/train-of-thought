// Right-hand card: station card, ghost card, or connect card (with the build panel).
import { h, clear, setText, setWidth, thumbImg } from './dom.js';
import { createBuildPanel } from './buildpanel.js';
import {
  fmtInt, fmtRate, fmtMoney, filterLinks, mapStatus, STATUS_LABEL, kindInfo, safeThumb, safeWikiUrl, LINK_ROW_LIMIT,
  patienceFraction, patienceTone, passengerMood, thoughtLine, destinationStatus,
} from './format.js';

export function createCard(ctx) {
  const { game, renderer, state } = ctx;
  const el = h('aside', { class: 'tot-panel tot-card', hidden: true });
  const build = createBuildPanel(ctx);
  let live = null; // refs for per-tick numbers on the station card
  let linksView = null; // { station, filter, input, list, count, pending }
  let passenger = null; // refs for the live passenger card
  const outcomes = new Map(); // thought id -> how it ended, for a card left open
  let renderedKey = '';

  function closeBtn() {
    return h('button', { class: 'tot-iconbtn tot-close', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', text: '×', onClick: () => ctx.deselect() });
  }

  function thumbBox(src) {
    const box = h('div', { class: 'tot-thumb' });
    const safe = safeThumb(src);
    if (safe) box.append(thumbImg(safe, 'tot-thumb-img'));
    else box.classList.add('empty');
    return box;
  }

  function render() {
    build.close();
    clear(el);
    live = null;
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
    else if (sel.kind === 'station') ctx.deselect();
    else renderGhostOrConnect(sel);
  }

  // ---------------------------------------------------------- station card

  function renderStation(sel) {
    const st = state.stations.get(sel.title);
    const a = st.article;
    const wikiUrl = safeWikiUrl(a.url, a.title);
    const income = h('b');
    const waiting = h('b');
    const unique = h('b');
    live = { st, income, waiting, unique };

    const sign = h(
      'div',
      { class: 'tot-sign' },
      h('div', { class: 'tot-sign-text' }, h('h2', { text: a.title }), h('p', { class: 'tot-desc', text: a.description || '' })),
      closeBtn(),
    );
    // The article's main photo, shown large under the station name.
    const hero = h('div', { class: 'tot-hero' });
    const heroSrc = safeThumb(a.thumbnail);
    if (heroSrc) {
      const img = thumbImg(heroSrc, 'tot-hero-img');
      img.addEventListener('error', () => hero.classList.add('empty'));
      hero.append(img);
    }
    else hero.classList.add('empty');
    const input = h('input', { class: 'tot-filter', type: 'search', placeholder: `Filter ${fmtInt((a.links || []).length)} links…`, 'aria-label': 'Filter links', autocomplete: 'off', spellcheck: 'false' });
    const count = h('span', { class: 'tot-count' });
    const list = h('ul', { class: 'tot-links' });
    linksView = { station: st.title, filter: '', input, list, count, pending: new Set() };

    let timer = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!linksView) return;
        linksView.filter = input.value;
        renderLinks();
        list.scrollTop = 0;
      }, 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (input.value) {
          input.value = '';
          linksView.filter = '';
          renderLinks();
        } else input.blur();
      }
    });
    list.addEventListener('click', onLinkClick);

    el.append(
      sign,
      hero,
      h('div', { class: 'tot-card-scroll' },
        a.summary ? h('p', { class: 'tot-summary', text: a.summary }) : null,
        h('a', { class: 'tot-wiki', href: wikiUrl, target: '_blank', rel: 'noopener', text: 'Open on Wikipedia ↗' }),
        h('div', { class: 'tot-stats' },
          h('div', { class: 'tot-stat' }, h('span', { class: 'tot-k', text: 'Unique links' }), unique),
          h('div', { class: 'tot-stat' }, h('span', { class: 'tot-k', text: 'Income' }), income),
          h('div', { class: 'tot-stat' }, h('span', { class: 'tot-k', text: 'Waiting' }), waiting),
        ),
      ),
      h('div', { class: 'tot-links-head' }, h('h3', { text: 'Links' }), count, input),
      list,
    );
    renderLinks();
    updateLive();
  }

  function renderLinks() {
    const v = linksView;
    if (!v) return;
    const st = state.stations.get(v.station);
    if (!st) return;
    const { rows, total } = filterLinks(st.article, v.filter, LINK_ROW_LIMIT);
    const top = v.list.scrollTop;
    const frag = document.createDocumentFragment();
    let sawRest = false;
    for (const row of rows) {
      const status = mapStatus(row.title, state);
      const btn = h('button', { class: 'tot-linkbtn', type: 'button', title: row.lead ? 'Lead link: mentioned in the article intro' : '' },
        h('span', { class: 'tot-leadmark' + (row.lead ? '' : ' none'), text: row.lead ? '◆' : '' }),
        h('span', { class: 'tot-linkname', text: row.title }),
        h('span', { class: 'tot-chip tot-chip-' + status, text: STATUS_LABEL[status] }),
      );
      btn.dataset.title = row.title;
      btn.dataset.act = 'link';
      if (v.pending.has(row.title)) btn.classList.add('busy');
      const li = h('li', { class: 'tot-linkrow' + (row.lead ? ' lead' : '') + (!row.lead && !sawRest ? ' first-rest' : '') }, btn);
      if (!row.lead) sawRest = true;
      if (status === 'built' && !game.trackBetween(v.station, row.title)) {
        const c = h('button', { class: 'tot-btn tot-btn-small', type: 'button', text: 'Connect', title: 'Build track between these two stations' });
        c.dataset.title = row.title;
        c.dataset.act = 'connect';
        li.append(c);
      }
      frag.append(li);
    }
    clear(v.list);
    if (!rows.length) v.list.append(h('li', { class: 'tot-empty', text: v.filter ? 'No links match.' : 'This article has no links.' }));
    v.list.append(frag);
    v.list.scrollTop = top;
    setText(v.count, total > rows.length ? `${rows.length} of ${fmtInt(total)}` : fmtInt(total));
  }

  function onLinkClick(e) {
    const btn = e.target.closest('button[data-act]');
    const v = linksView;
    if (!btn || !v) return;
    const title = btn.dataset.title;
    const from = v.station;
    if (btn.dataset.act === 'connect') {
      ctx.select(title, { connect: true, from, focus: true });
      return;
    }
    const status = mapStatus(title, state);
    if (status !== 'absent') {
      ctx.select(title, { from, focus: true });
      return;
    }
    if (v.pending.has(title)) return;
    v.pending.add(title);
    btn.classList.add('busy');
    Promise.resolve()
      .then(() => game.survey(from, title))
      .catch((err) => ({ ok: false, reason: (err && err.message) || 'Survey failed.' }))
      .then((res) => {
        v.pending.delete(title);
        const ok = ctx.report(res);
        if (linksView === v) renderLinks();
        // Only jump to the ghost if the player is still on the station they surveyed from.
        if (ok && ctx.sel && ctx.sel.kind === 'station' && ctx.sel.title === from) {
          ctx.select(title, { from, focus: true, kind: 'ghost' });
        }
      });
  }

  function updateLive() {
    if (!live) return;
    const { st } = live;
    setText(live.unique, fmtInt(st.uniqueLinks));
    setText(live.income, fmtRate(st.incomePerMin));
    setText(live.waiting, fmtInt(st.waiting.length));
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
      closeBtn(),
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
    const actions = h('div', { class: 'tot-actions' });
    body.append(
      h('div', { class: 'tot-stats two' },
        h('div', { class: 'tot-stat' }, h('span', { class: 'tot-k', text: 'Will pay' }), fare),
        h('div', { class: 'tot-stat' }, h('span', { class: 'tot-k', text: 'Where' }), where),
      ),
      h('div', { class: 'tot-k tot-patience-k', text: 'Patience' }),
      h('div', { class: 'tot-bar tot-bar-big' }, fill),
      actions,
    );
    passenger = { id: th.id, quote, fare, where, fill, actions, key: '' };
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
    clear(p.actions);
    const here = th.at || th.from;
    if (th.state === 'waiting' && state.stations.has(here)) {
      p.actions.append(h('button', { class: 'tot-btn tot-btn-small', type: 'button', text: 'Show station', onClick: () => ctx.select(here, { focus: true }) }));
    }
    if (status === 'ghost') {
      p.actions.append(h('button', { class: 'tot-btn tot-btn-small tot-btn-primary', type: 'button', text: 'Build to ' + th.to, onClick: () => ctx.select(th.to, { from: here, focus: true }) }));
    } else if (status !== 'unknown') {
      p.actions.append(h('button', { class: 'tot-btn tot-btn-small', type: 'button', text: 'Show ' + th.to, onClick: () => ctx.select(th.to, { focus: true }) }));
    }
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
    noteOutcome(e.thought.id, { good: false, to: e.thought.to, toDescription: e.thought.toDescription, text: `Gave up waiting for ${e.thought.to} and left. Your reputation took a knock.` });
  });

  // ---------------------------------------------------------- ghost / connect

  function renderGhostOrConnect(sel) {
    const title = sel.title;
    const connect = sel.kind === 'connect';
    const stub = state.stubs && state.stubs.get(title);
    const built = state.stations.get(title);
    const desc = (built && built.article.description) || (stub && stub.description) || '';
    const kind = kindInfo((built && built.article.kind) || (stub && stub.kind));

    const badge = h('span', { class: 'tot-badge' + (kind.premium ? ' premium' : ''), text: kind.label + (kind.premium ? ' · costs ×5' : '') });
    const sign = h(
      'div',
      { class: 'tot-sign ghost' },
      thumbBox(built ? built.article.thumbnail : null),
      h('div', { class: 'tot-sign-text' },
        h('div', { class: 'tot-eyebrow', text: connect ? 'Built station' : 'Ghost station' }),
        h('h2', { text: title }),
        h('p', { class: 'tot-desc', text: desc || 'No short description.' })),
      closeBtn(),
    );
    el.append(sign);
    el.append(h('div', { class: 'tot-card-scroll grow' },
      h('div', { class: 'tot-badges' }, badge),
      kind.premium ? h('p', { class: 'tot-note', text: 'Lists and disambiguation pages cost five times as much to build and earn no link income.' }) : null,
      build.el,
    ));
    build.open(title, sel.from || ctx.lastBuilt);
  }

  // ---------------------------------------------------------- events + ticks

  /** Something on the map changed (station/track/ghost): refresh chips and quotes. */
  function refresh() {
    const sel = ctx.sel;
    if (!sel) return;
    // A ghost the player was looking at may have become a station.
    if (sel.kind === 'ghost' && state.stations.has(sel.title)) {
      ctx.select(sel.title, { kind: 'station' });
      return;
    }
    if (sel.kind === 'station') renderLinks();
    else if (build.isOpen && !build.busy) build.requote();
  }

  function update() {
    updateLive();
    updatePassenger();
    build.update();
  }

  ctx.bus.on('selection', render);

  return { el, refresh, update, get key() { return renderedKey; } };
}
