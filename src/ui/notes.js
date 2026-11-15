// Transient messages that stack at top centre: toasts, the milestone banner, first-run hints.
import { TRAIN_TYPES } from '../config.js';
import { h, setText } from './dom.js';
import { pickHint, fmtInt } from './format.js';

const MAX_TOASTS = 4;

export function createToasts() {
  const el = h('div', { class: 'tot-toasts', 'aria-live': 'polite' });

  function remove(node) {
    if (node.parentNode) node.remove();
  }

  function push(node, ms) {
    el.append(node);
    while (el.children.length > MAX_TOASTS) remove(el.firstChild);
    setTimeout(() => remove(node), ms);
  }

  function show(text, tone) {
    const t = tone === 'good' || tone === 'bad' ? tone : 'info';
    const node = h('div', { class: 'tot-toast ' + t, role: t === 'bad' ? 'alert' : 'status', text: String(text) });
    node.addEventListener('click', () => remove(node));
    push(node, t === 'bad' ? 7000 : 4500);
  }

  function milestone(e) {
    const type = TRAIN_TYPES[e.unlock];
    const name = type ? type.name : String(e.unlock);
    const node = h('div', { class: 'tot-toast milestone', role: 'status' },
      h('strong', { text: `New train unlocked: ${name}` }),
      h('span', { text: `${fmtInt(e.uniqueLinks)} unique links reached` }));
    node.addEventListener('click', () => remove(node));
    push(node, 7000);
  }

  return { el, show, milestone };
}

export function createHints(ctx) {
  const { state } = ctx;
  const dismissed = new Set();
  const text = h('span');
  const el = h('div', { class: 'tot-panel tot-hint', hidden: true },
    h('span', { class: 'tot-eyebrow', text: 'Hint' }),
    text,
    h('button', { class: 'tot-iconbtn', type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss hint', text: '×', onClick: () => {
      if (current) dismissed.add(current.stage);
      refresh();
    } }),
  );
  let current = null;

  function refresh() {
    let hint = null;
    if (state.phase === 'running' && !ctx.mode) {
      const k = ctx.sel && ctx.sel.kind;
      hint = pickHint({
        stations: state.stations.size,
        lines: state.lines.length,
        trains: state.trains.length,
        selKind: k === 'connect' ? 'ghost' : k,
      });
      if (hint && dismissed.has(hint.stage)) hint = null;
    }
    current = hint;
    el.hidden = !hint;
    if (hint) setText(text, hint.text);
  }

  return { el, refresh };
}
