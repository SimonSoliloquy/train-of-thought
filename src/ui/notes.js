// Transient messages that stack at the top centre: short toasts, and the riding label.
import { h } from './dom.js';

const MAX_TOASTS = 3;

export function createToasts() {
  const el = h('div', { class: 'tot-toasts', 'aria-live': 'polite' });

  function remove(node) {
    if (node.parentNode) node.remove();
  }

  /** `ms` overrides how long it stays (default 3.5 s, 6 s for a problem). */
  function show(text, tone, ms) {
    const t = tone === 'good' || tone === 'bad' ? tone : 'info';
    const node = h('div', { class: 'tot-toast ' + t, role: t === 'bad' ? 'alert' : 'status', text: String(text) });
    el.append(node);
    while (el.children.length > MAX_TOASTS) remove(el.firstChild);
    setTimeout(() => remove(node), ms || (t === 'bad' ? 6000 : 3500));
  }

  return { el, show };
}

/** A plain label while the camera rides a train. Not a button: click the train or the map, or press Esc, to stop. */
export function createRideLabel(ctx) {
  const el = h('div', { class: 'tot-panel tot-ridechip', hidden: true, text: 'Riding a train. Click the map or press Esc to stop.' });

  function update() {
    // The train may have been replaced by an upgrade: release the camera.
    if (ctx.riding != null && !ctx.state.trains.some((t) => t.id === ctx.riding)) ctx.stopRide();
    el.hidden = ctx.riding == null;
  }
  ctx.bus.on('riding', update);
  return { el, update };
}
