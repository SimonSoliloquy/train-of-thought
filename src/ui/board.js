// The passenger queue: a small chip ("12 passengers waiting") that opens into a list.
import { ECON } from '../config.js';
import { h, setText, setWidth } from './dom.js';
import {
  fmtMoney, sortThoughts, patienceFraction, patienceTone, queueStatus, QUEUE_STATUS,
  waitingCount, passengersLabel, reputationInfo,
} from './format.js';

const MAX_ROWS = 60;

export function createBoard(ctx) {
  const { state } = ctx;
  const rows = new Map(); // thought id -> { el, refs }
  let open = false;

  const label = h('span', { class: 'tot-queue-label' });
  const caret = h('span', { class: 'tot-caret' });
  const head = h('button', { class: 'tot-queue-head', type: 'button', 'aria-expanded': 'false', onClick: () => {
    open = !open;
    paintOpen();
    head.blur();
  } }, label, caret);

  const mood = h('div', { class: 'tot-mood', title: 'Happy passengers pay more, and more of them turn up. Passengers who give up make them less happy.' });
  const moodWord = h('b');
  const empty = h('div', { class: 'tot-empty', text: 'Passengers will appear at your stations.' });
  const list = h('div', { class: 'tot-tlist' });
  const more = h('div', { class: 'tot-more', hidden: true });
  const body = h('div', { class: 'tot-queue-body' }, mood, empty, list, more);
  mood.append('Passenger happiness ', moodWord);
  const el = h('section', { class: 'tot-panel tot-queue' }, head, body);

  function paintOpen() {
    el.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    caret.textContent = open ? '▾' : '▸';
  }
  paintOpen();

  function makeRow(t) {
    const to = h('span', { class: 'tot-to', text: t.to });
    const fare = h('span', { class: 'tot-fare' });
    const where = h('div', { class: 'tot-where' });
    const fill = h('div', { class: 'tot-bar-fill' });
    const status = h('span', { class: 'tot-status' });
    const row = h(
      'div',
      { class: 'tot-trow', tabindex: '0', role: 'button', title: t.toDescription || '' },
      h('div', { class: 'tot-trow-top' }, to, fare),
      where,
      h('div', { class: 'tot-trow-foot' }, h('div', { class: 'tot-bar tot-bar-patience' }, fill), status),
    );
    const r = { el: row, refs: { fare, where, fill, status }, id: t.id, from: t.from };
    row.addEventListener('click', () => ctx.select(r.from, { focus: true }));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === row) ctx.select(r.from, { focus: true });
    });
    return r;
  }

  function paint(r, t) {
    const { fare, where, fill, status } = r.refs;
    setText(fare, 'pays ' + fmtMoney(t.fare));
    setText(where, t.state === 'riding' ? 'on a train from ' + t.from : 'waiting at ' + (t.at || t.from));
    const frac = patienceFraction(t);
    setWidth(fill, frac);
    const tone = patienceTone(frac);
    if (fill._tone !== tone) {
      fill.className = 'tot-bar-fill ' + tone;
      fill._tone = tone;
    }
    const st = queueStatus(t, state);
    setText(status, QUEUE_STATUS[st]);
    if (status._st !== st) {
      status.className = 'tot-status tot-status-' + st;
      status._st = st;
    }
  }

  /** Reconcile rows with state.thoughts: add, remove, reorder, repaint. */
  function refresh() {
    setText(label, passengersLabel(waitingCount(state.thoughts)));
    const rep = reputationInfo(state.reputation, ECON);
    setText(moodWord, `${rep.percent}% · ${rep.word}`);
    if (moodWord._tone !== rep.tone) {
      moodWord.className = rep.tone;
      moodWord._tone = rep.tone;
    }
    if (!open) return; // the list is only kept up to date while it can be seen
    const sorted = sortThoughts(state.thoughts);
    const shown = sorted.slice(0, MAX_ROWS);
    const keep = new Set(shown.map((t) => t.id));
    for (const [id, r] of rows) {
      if (!keep.has(id)) {
        r.el.remove();
        rows.delete(id);
      }
    }
    shown.forEach((t, i) => {
      let r = rows.get(t.id);
      if (!r) {
        r = makeRow(t);
        rows.set(t.id, r);
      }
      const at = list.children[i];
      if (at !== r.el) list.insertBefore(r.el, at || null);
      paint(r, t);
    });
    empty.hidden = shown.length > 0;
    const extra = sorted.length - shown.length;
    more.hidden = extra <= 0;
    if (extra > 0) setText(more, `+${extra} more, least urgent`);
  }

  head.addEventListener('click', refresh);
  return { el, refresh, update: refresh };
}
