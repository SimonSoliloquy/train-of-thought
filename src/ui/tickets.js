// The tickets: at most three punched railway tickets, always visible under the gold readout. Rows are rebuilt on
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
    // A punched railway ticket: from and to stamped on the card, the reward on the stub past the
    // perforation, and the time left as a strip along the bottom.
    const from = h('span', { class: 'tot-tk-from' });
    const to = h('span', { class: 'tot-tk-to' });
    const route = h('div', { class: 'tot-tk-route' },
      h('div', { class: 'tot-tk-line' }, h('span', { class: 'tot-tk-k', text: 'From' }), from),
      h('div', { class: 'tot-tk-line' }, h('span', { class: 'tot-tk-k', text: 'To' }), to));
    const amount = h('b', { class: 'tot-tk-amt' });
    const reward = h('div', { class: 'tot-tk-reward' }, amount, h('span', { class: 'tot-tk-unit', text: 'gold' }));
    const how = h('div', { class: 'tot-tk-how' });
    // An express ticket (double reward, shorter clock) carries a stamp on its stub.
    const express = h('span', { class: 'tot-tk-express', hidden: true, text: 'Express', title: 'Express: double reward, less time' });
    const fill = h('div', { class: 'tot-bar-fill' });
    // The surveyor: pay to be shown the next article to build towards this ticket.
    const survey = h('button', { class: 'tot-tk-survey', type: 'button' });
    const hint = h('div', { class: 'tot-tk-hint', hidden: true });
    const row = h('div', { class: 'tot-panel tot-ticket' },
      h('div', { class: 'tot-tk-main' }, route, how, hint, survey, h('div', { class: 'tot-bar tot-tk-bar' }, fill)),
      h('div', { class: 'tot-tk-stub' }, express, reward));
    const r = { el: row, refs: { from, to, amount, how, fill, survey, hint, express }, t, leaving: false, timer: 0, busy: false };
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
          ctx.report(res); // the surveyor now works for a while; the row shows their progress
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
    setText(r.refs.from, r.t.from);
    setText(r.refs.to, r.t.to);
    setText(r.refs.how, v.how);
    const ex = !!r.t.express;
    if (r.refs.express.hidden === ex) r.refs.express.hidden = !ex;
    setClass(r.el, 'express', ex);
    if (!r.leaving) setText(r.refs.amount, v.reward.replace(/ gold$/, ''));
    setWidth(r.refs.fill, v.fraction);
    if (r.refs.fill._tone !== v.tone) {
      r.refs.fill.className = 'tot-bar-fill ' + v.tone;
      r.refs.fill._tone = v.tone;
    }
    const h2 = r.t.hint;
    const sv = r.t.surveying;
    r.refs.hint.hidden = !h2 && !sv;
    if (h2) setText(r.refs.hint, `Surveyor: build ${h2.to} next, from ${h2.from}`);
    else if (sv) setText(r.refs.hint, `Surveyor at work in ${sv.from}\u2026 ${Math.ceil(sv.left)}s`);
    setClass(r.refs.hint, 'working', !h2 && !!sv);
    r.refs.survey.hidden = !!h2 || !!sv || r.leaving;
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
    setText(r.refs.amount, '+' + Math.round(e.reward || 0).toLocaleString('en-US'));
    setClass(r.el, 'go', false);
    r.timer = setTimeout(() => drop(e.ticket.id), LEAVE_MS);
  }

  function update() {
    for (const r of rows.values()) if (!r.leaving) paint(r);
  }

  return { el, sync, update, done };
}
