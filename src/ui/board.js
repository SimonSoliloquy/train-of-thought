// Thought board: a departure-board list of what passengers are thinking of.
import { h, setText, setClass, setWidth } from './dom.js';
import { fmtMoney, mapStatus, STATUS_LABEL, sortThoughts, patienceFraction, patienceTone } from './format.js';

const MAX_ROWS = 60;

export function createBoard(ctx) {
  const { state } = ctx;
  const rows = new Map(); // thought id -> { el, refs }
  let collapsed = false;

  const count = h('span', { class: 'tot-count' });
  const toggle = h('button', { class: 'tot-iconbtn', type: 'button', title: 'Collapse', text: '–', onClick: () => {
    collapsed = !collapsed;
    el.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? '+' : '–';
    toggle.title = collapsed ? 'Expand' : 'Collapse';
  } });
  const empty = h('div', { class: 'tot-empty', text: 'No thoughts yet. Passengers appear at your stations wanting to reach an article a few links away.' });
  const list = h('div', { class: 'tot-tlist' });
  const more = h('div', { class: 'tot-more', hidden: true });
  const el = h(
    'section',
    { class: 'tot-panel tot-board' },
    h('div', { class: 'tot-panel-head' }, h('h2', { text: 'Thoughts' }), count, toggle),
    h('div', { class: 'tot-board-body' }, empty, list, more),
  );

  function makeRow(t) {
    const mark = h('span', { class: 'tot-mark' });
    const to = h('button', { class: 'tot-to', type: 'button', text: t.to });
    const desc = h('div', { class: 'tot-trow-desc', text: t.toDescription || '' });
    const fare = h('span', { class: 'tot-fare' });
    const fill = h('div', { class: 'tot-bar-fill' });
    const chip = h('span', { class: 'tot-chip' });
    const row = h(
      'div',
      { class: 'tot-trow', tabindex: '0', role: 'button' },
      h('div', { class: 'tot-trow-top' }, mark, h('span', { class: 'tot-from', text: t.from, title: t.from }), h('span', { class: 'tot-arrow', text: '→' }), to),
      desc,
      h('div', { class: 'tot-trow-foot' }, fare, h('div', { class: 'tot-bar tot-bar-patience' }, fill), chip),
    );
    const r = { el: row, refs: { mark, to, fare, fill, chip }, id: t.id, from: t.from, dest: t.to };
    row.addEventListener('click', () => ctx.select(r.from, { focus: true }));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === row) ctx.select(r.from, { focus: true });
    });
    to.addEventListener('click', (e) => {
      e.stopPropagation();
      if (mapStatus(r.dest, state) !== 'absent') ctx.select(r.dest, { focus: true });
    });
    return r;
  }

  function paint(r, t) {
    const { mark, to, fare, fill, chip } = r.refs;
    const riding = t.state === 'riding';
    setText(mark, riding ? 'RIDE' : 'WAIT');
    setClass(mark, 'riding', riding);
    setText(fare, fmtMoney(t.fare));
    const frac = patienceFraction(t);
    setWidth(fill, frac);
    const tone = patienceTone(frac);
    if (fill._tone !== tone) {
      fill.className = 'tot-bar-fill ' + tone;
      fill._tone = tone;
    }
    const st = mapStatus(t.to, state);
    setText(chip, STATUS_LABEL[st]);
    if (chip._st !== st) {
      chip.className = 'tot-chip tot-chip-' + st;
      chip._st = st;
      to.title = st === 'absent' ? 'Not on the map yet. Find a chain of links that leads here.' : 'Show on map';
      setClass(to, 'off', st === 'absent');
    }
    const d = t.toDescription || '';
    if (r.desc !== d) {
      r.desc = d;
      r.el.querySelector('.tot-trow-desc').textContent = d;
    }
  }

  /** Reconcile rows with state.thoughts: add, remove, reorder, repaint. */
  function refresh() {
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
    setText(count, String(sorted.length));
    const extra = sorted.length - shown.length;
    more.hidden = extra <= 0;
    if (extra > 0) setText(more, `+${extra} more, least urgent`);
  }

  return { el, refresh, update: refresh };
}
