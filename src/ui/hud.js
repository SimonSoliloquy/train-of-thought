// The only readout: gold, and what the next payday will bring. Plus one small quiet speed button.
import { ECON } from '../config.js';
import { h, setText, setClass, setWidth } from './dom.js';
import { fmtMoney, paydayView, paydayBreakdown, bankruptView, nextSpeed, speedLabel } from './format.js';

const BREAKDOWN_MS = 3000;

export function createHud(ctx) {
  const { game, state } = ctx;
  let lastRunning = 1;
  let breakdownUntil = 0;

  const gold = h('div', { class: 'tot-gold-v', title: 'Your gold' });
  const next = h('div', { class: 'tot-next' });
  const fill = h('div', { class: 'tot-bar-fill' });
  const detailAmt = h('b', { class: 'tot-last-amt' });
  const detailText = h('span', { class: 'tot-last-detail' });
  const detail = h('div', { class: 'tot-last' }, detailAmt, detailText);
  const el = h('div', { class: 'tot-panel tot-hud', title: 'Gold arrives in a payday every ' + ECON.paydaySeconds + ' seconds' },
    gold,
    h('div', { class: 'tot-hud-pay' }, next, h('div', { class: 'tot-bar' }, fill), detail));

  const speed = h('button', { class: 'tot-speed', type: 'button', title: 'Game speed. Space pauses.', onClick: (e) => {
    game.setSpeed(nextSpeed(state.speed, lastRunning));
    e.currentTarget.blur();
  } });

  function flash(node) {
    node.classList.remove('flash');
    void node.offsetWidth; // restart the animation
    node.classList.add('flash');
  }

  /** A payday landed: flash the amount and show where it came from for a few seconds. */
  function payday(e) {
    const b = paydayBreakdown(e);
    setText(detailAmt, b.headline);
    setText(detailText, b.detail);
    setClass(detailAmt, 'neg', b.negative);
    breakdownUntil = performance.now() + BREAKDOWN_MS;
    detail.classList.add('show');
    flash(detail);
    flash(gold);
  }

  /** Gold jumped for another reason (a reward): pulse it. */
  function pulse() {
    flash(gold);
  }

  function update() {
    if (state.speed > 0) lastRunning = state.speed;

    setText(gold, fmtMoney(state.money));
    const neg = state.money < 0;
    setClass(el, 'neg', neg);

    // Negative gold: the bankruptcy countdown takes the payday text's place.
    if (neg && state.bankruptIn != null) {
      const v = bankruptView(state.bankruptIn, ECON.bankruptcyGraceSeconds);
      setText(next, v.text);
      setClass(next, 'neg', true);
      setWidth(fill, v.fraction);
      setClass(fill, 'danger', true);
    } else {
      const v = paydayView(state.payday);
      // Nothing is paid or charged until the first track is built.
      setText(next, state.clockRunning === false ? 'Clock starts when you build' : v.text);
      setClass(next, 'neg', v.negative);
      setWidth(fill, v.fraction);
      setClass(fill, 'danger', false);
    }

    if (breakdownUntil && performance.now() > breakdownUntil) {
      breakdownUntil = 0;
      detail.classList.remove('show');
    }

    setText(speed, speedLabel(state.speed));
    setClass(speed, 'paused', state.speed === 0);
  }

  return { el, speed, update, payday, pulse };
}
