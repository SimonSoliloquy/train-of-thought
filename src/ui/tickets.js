// The tickets: at most three small rows, always visible under the gold readout. Rows are rebuilt on
// ticket events; the reward and the time bar are refreshed from update() a few times a second.
import { ECON } from '../config.js';
import { h, setText, setClass, setWidth } from './dom.js';
import { ticketView } from './format.js';

const LEAVE_MS = 1300;

export function createTickets(ctx) {
  const { state, game } = ctx;
  const el = h('div', { class: 'tot-tickets', 'aria-label': 'Tickets' });
  const rows = new Map(); // ticket id -> { el, refs, t, leaving, timer }

  function make(t) {
    const route = h('span', { class: 'tot-tk-route' });
    const reward = h('b', { class: 'tot-tk-reward' });
    const how = h('div', { class: 'tot-tk-how' });
    const fill = h('div', { class: 'tot-bar-fill' });
    // The surveyor: pay to be shown the next article to build towards this ticket.
    const survey = h('button', { class: 'tot-tk-survey', type: 'button' });
    const hint = h('div', { class: 'tot-tk-hint', hidden: true });
    const row = h('div', { class: 'tot-panel tot-ticket' },
      h('div', { class: 'tot-tk-top' }, route, reward), how, hint, survey, h('div', { class: 'tot-bar tot-tk-bar' }, fill));
    const r = { el: row, refs: { route, reward, how, fill, survey, hint }, t, leaving: false, timer: 0, busy: false };
    survey.addEventListener('click', (e) => {
      e.stopPropagation();
      if (r.leaving || r.busy) return;
      r.busy = true;
      paint(r);
      Promise.resolve()
        .then(() => game.buySurveyor(r.t.id))
        .catch((err) => ({ ok: false, reason: (err && err.message) || 'The surveyor could not be hired.' }))
        .then((res) => {
          r.busy = false;
          if (ctx.report(res) && res.hint) follow(res.hint);
          paint(r);
        });
    });
    row.addEventListener('click', () => {
      if (r.leaving) return;
      if (r.t.hint) { follow(r.t.hint); return; }
      if (!state.stations.has(r.t.from)) return;
      ctx.select(r.t.from, { focus: true });
    });
    return r;
  }

  /** Show the player what the surveyor found: select the station to build from and price the build. */
  function follow(hint) {
    if (!hint || !state.stations.has(hint.from)) return;
    if (state.stations.has(hint.to)) { ctx.select(hint.to, { focus: true }); return; }
    ctx.select(hint.from);
    ctx.openBuild(hint.to, hint.from);
  }

  function paint(r) {
    const v = ticketView(r.t, (title) => state.stations.has(title));
    setText(r.refs.route, v.route);
    setText(r.refs.how, v.how);
    if (!r.leaving) setText(r.refs.reward, v.reward);
    setWidth(r.refs.fill, v.fraction);
    if (r.refs.fill._tone !== v.tone) {
      r.refs.fill.className = 'tot-bar-fill ' + v.tone;
      r.refs.fill._tone = v.tone;
    }
    const h2 = r.t.hint;
    r.refs.hint.hidden = !h2;
    if (h2) setText(r.refs.hint, `Surveyor: build ${h2.to} next, from ${h2.from}`);
    r.refs.survey.hidden = !!h2 || r.leaving;
    const cost = Math.round(r.t.surveyCost || 0);
    setText(r.refs.survey, r.busy ? 'Surveying\u2026' : `Surveyor \u00b7 ${cost.toLocaleString('en-US')} gold`);
    setClass(r.refs.survey, 'poor', !r.busy && state.money < cost);
    r.refs.survey.title = 'Pay a surveyor to show the next article to build towards this ticket';
    setClass(r.el, 'go', (v.fromBuilt || !!h2) && !r.leaving);
    if (r.el.title !== (r.t.toDescription || '')) r.el.title = r.t.toDescription || '';
  }

  function drop(id) {
    const r = rows.get(id);
    if (!r) return;
    clearTimeout(r.timer);
    r.el.remove();
    rows.delete(id);
  }

  /** Reconcile rows with state.tickets: add new ones, drop the gone (except those finishing). */
  function sync() {
    const list = (state.tickets || []).slice(0, ECON.maxTickets);
    const keep = new Set(list.map((t) => t.id));
    for (const [id, r] of rows) if (!keep.has(id) && !r.leaving) drop(id);
    for (const t of list) {
      let r = rows.get(t.id);
      if (!r) {
        r = make(t);
        rows.set(t.id, r);
        el.append(r.el);
      }
      r.t = t;
      paint(r);
    }
  }

  /** A ticket was met: flash its row green, show what it paid, then let it go. */
  function done(e) {
    const r = e && e.ticket && rows.get(e.ticket.id);
    if (!r) return;
    r.leaving = true;
    r.el.classList.add('done');
    setText(r.refs.reward, '+' + Math.round(e.reward || 0).toLocaleString('en-US') + ' gold');
    setClass(r.el, 'go', false);
    r.timer = setTimeout(() => drop(e.ticket.id), LEAVE_MS);
  }

  function update() {
    for (const r of rows.values()) if (!r.leaving) paint(r);
  }

  return { el, sync, update, done };
}
