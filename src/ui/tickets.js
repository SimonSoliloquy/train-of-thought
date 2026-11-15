// The tickets: at most three small rows, always visible under the gold readout. Rows are rebuilt on
// ticket events; the reward and the time bar are refreshed from update() a few times a second.
import { ECON } from '../config.js';
import { h, setText, setClass, setWidth } from './dom.js';
import { ticketView } from './format.js';

const LEAVE_MS = 1300;

export function createTickets(ctx) {
  const { state } = ctx;
  const el = h('div', { class: 'tot-tickets', 'aria-label': 'Tickets' });
  const rows = new Map(); // ticket id -> { el, refs, t, leaving, timer }

  function make(t) {
    const route = h('span', { class: 'tot-tk-route' });
    const reward = h('b', { class: 'tot-tk-reward' });
    const how = h('div', { class: 'tot-tk-how' });
    const fill = h('div', { class: 'tot-bar-fill' });
    const row = h('div', { class: 'tot-panel tot-ticket' },
      h('div', { class: 'tot-tk-top' }, route, reward), how, h('div', { class: 'tot-bar tot-tk-bar' }, fill));
    const r = { el: row, refs: { route, reward, how, fill }, t, leaving: false, timer: 0 };
    row.addEventListener('click', () => {
      if (r.leaving || !state.stations.has(r.t.from)) return;
      ctx.select(r.t.from, { focus: true });
    });
    return r;
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
    setClass(r.el, 'go', v.fromBuilt && !r.leaving);
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
