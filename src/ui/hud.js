// The only readout: gold, and what the next payday will bring. Plus one small speed dial.
// Gold is a mechanical counter (digit wheels in dark windows inside a brass bezel); the payday is a
// round pressure gauge whose needle sweeps once round the payday period, with the coming amount on a
// small plate beside it. Nothing here is rebuilt per frame: the wheels are rebuilt only when the
// number of digits changes, and every per-tick write is skipped when the value is the same.
import { ECON } from '../config.js';
import { h, setText, setClass } from './dom.js';
import { fmtInt, fmtMoney, paydayView, paydayBreakdown, bankruptView, nextSpeed, speedLabel } from './format.js';

const BREAKDOWN_MS = 3000;
const SVGNS = 'http://www.w3.org/2000/svg';
const SWEEP = 270; // degrees the needle travels over one payday period
const START = -SWEEP / 2;

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  for (const k of kids) el.append(k);
  return el;
}

/** A point on the gauge face: `deg` clockwise from twelve o'clock, radius `r`, centre (24, 24). */
function pt(deg, r) {
  const a = (deg * Math.PI) / 180;
  return [(24 + r * Math.sin(a)).toFixed(2), (24 - r * Math.cos(a)).toFixed(2)];
}

/** Gold as a mechanical counter: one rolling wheel per digit. */
function createCounter() {
  const gear = h('span', { class: 'tot-ctr-gear', 'aria-hidden': 'true' });
  const digits = h('span', { class: 'tot-ctr-digits', 'aria-hidden': 'true' });
  const sr = h('span', { class: 'tot-sr' });
  const el = h('div', { class: 'tot-counter tot-gold-v', title: 'Your gold' },
    gear, digits, h('span', { class: 'tot-ctr-unit', 'aria-hidden': 'true', text: 'gold' }), sr);
  let shape = null;
  let wheels = [];
  let last = null;
  let turn = 0;

  function set(n) {
    const str = fmtInt(n);
    if (str === last) return;
    const moved = last !== null;
    last = str;
    sr.textContent = fmtMoney(n);
    const sh = str.replace(/\d/g, '0');
    if (sh !== shape) {
      shape = sh;
      digits.textContent = '';
      wheels = [];
      for (const ch of str) {
        if (ch >= '0' && ch <= '9') {
          const strip = h('span', { class: 'tot-ctr-strip' });
          for (let d = 0; d <= 9; d++) strip.append(h('span', { text: String(d) }));
          digits.append(h('span', { class: 'tot-ctr-win' }, strip));
          wheels.push(strip);
        } else if (ch === '-') {
          digits.append(h('span', { class: 'tot-ctr-win minus', text: '−' }));
        } else {
          digits.append(h('span', { class: 'tot-ctr-sep', text: ch }));
        }
      }
    }
    let i = 0;
    for (const ch of str) {
      if (ch < '0' || ch > '9') continue;
      const tf = `translateY(${-Number(ch) * 10}%)`;
      const w = wheels[i++];
      if (w._tf !== tf) { w.style.transform = tf; w._tf = tf; }
    }
    if (moved) { turn += 30; gear.style.transform = `rotate(${turn}deg)`; } // the gear clicks on a notch
  }
  return { el, set };
}

/** The payday pressure gauge. */
function createGauge() {
  const ticks = svg('g', { class: 'tot-g-ticks' });
  for (let i = 0; i <= 8; i++) {
    const d = START + (SWEEP / 8) * i;
    const [x1, y1] = pt(d, i % 2 ? 15.6 : 14.4);
    const [x2, y2] = pt(d, 18.2);
    ticks.append(svg('line', { x1, y1, x2, y2 }));
  }
  const [rx1, ry1] = pt(START + SWEEP * 0.75, 16.6);
  const [rx2, ry2] = pt(START + SWEEP, 16.6);
  const red = svg('path', { class: 'tot-g-red', d: `M${rx1} ${ry1} A16.6 16.6 0 0 1 ${rx2} ${ry2}` });
  const needle = svg('g', { class: 'tot-g-needle' },
    svg('path', { d: 'M24 28.5 L22.9 24 L24 8.2 L25.1 24 Z' }));
  const grad = svg('linearGradient', { id: 'tot-g-brass', x1: 0, y1: 0, x2: 1, y2: 1 },
    svg('stop', { offset: '0', 'stop-color': '#f6e3a6' }),
    svg('stop', { offset: '0.45', 'stop-color': '#c49b4c' }),
    svg('stop', { offset: '0.7', 'stop-color': '#7d5a22' }),
    svg('stop', { offset: '1', 'stop-color': '#d9b867' }));
  const face = svg('svg', { class: 'tot-gauge', viewBox: '0 0 48 48', 'aria-hidden': 'true' },
    svg('defs', {}, grad),
    svg('circle', { class: 'tot-g-bezel', cx: 24, cy: 24, r: 23.4, fill: 'url(#tot-g-brass)' }),
    svg('circle', { class: 'tot-g-rim', cx: 24, cy: 24, r: 20.2 }),
    svg('circle', { class: 'tot-g-face', cx: 24, cy: 24, r: 19.4 }),
    red, ticks, needle,
    svg('circle', { class: 'tot-g-hub', cx: 24, cy: 24, r: 2.6, fill: 'url(#tot-g-brass)' }));
  const lamp = h('span', { class: 'tot-lamp', 'aria-hidden': 'true' });
  const el = h('div', { class: 'tot-gauge-wrap' }, face, lamp);
  let lastDeg = null;

  function set(frac) {
    const deg = Math.round((START + SWEEP * Math.max(0, Math.min(1, frac))) * 10) / 10;
    if (deg === lastDeg) return;
    // forward: a steady creep; backward (a payday landed, or the countdown reset): a springy jump
    setClass(needle, 'jump', lastDeg !== null && deg < lastDeg - 15);
    needle.style.transform = `rotate(${deg}deg)`;
    lastDeg = deg;
  }

  function flash() {
    lamp.classList.remove('flash');
    void lamp.offsetWidth;
    lamp.classList.add('flash');
  }
  return { el, set, flash };
}

export function createHud(ctx) {
  const { game, state } = ctx;
  let lastRunning = 1;
  let breakdownUntil = 0;

  const counter = createCounter();
  const gauge = createGauge();
  const next = h('div', { class: 'tot-next' });
  const detailAmt = h('b', { class: 'tot-last-amt' });
  const detailText = h('span', { class: 'tot-last-detail' });
  const detail = h('div', { class: 'tot-last' }, detailAmt, detailText);
  const el = h('div', { class: 'tot-panel tot-hud', title: 'Gold arrives in a payday every ' + ECON.paydaySeconds + ' seconds' },
    counter.el, gauge.el, next, detail);

  // One small mechanical dial: each press turns it a notch (1x, 2x, 4x); Space pauses.
  const knob = h('span', { class: 'tot-knob', 'aria-hidden': 'true' });
  const speedText = h('span', { class: 'tot-speed-label' });
  const speed = h('button', { class: 'tot-speed', type: 'button', title: 'Game speed. Space pauses.', onClick: (e) => {
    game.setSpeed(nextSpeed(state.speed, lastRunning));
    e.currentTarget.blur();
  } }, knob, speedText);

  function flash(node, cls = 'flash') {
    node.classList.remove(cls);
    void node.offsetWidth; // restart the animation
    node.classList.add(cls);
  }

  const signed = (n) => { const v = Math.round(Number.isFinite(n) ? n : 0); return (v > 0 ? '+' : '') + fmtInt(v); };
  const cost = (n) => { const v = Math.round(Number.isFinite(n) ? n : 0); return v > 0 ? '−' + fmtInt(v) : '0'; };

  /** A payday landed: the lamp flashes, the amount shows with where it came from for a few seconds. */
  function payday(e) {
    const b = paydayBreakdown(e);
    const p = e || {};
    setText(detailAmt, b.headline);
    // the headline says "gold"; the parts stay short so the line fits on one row
    setText(detailText, `stations ${signed(p.income)} · fares ${signed(p.fares)} · costs ${cost(p.upkeep)}`);
    detail.title = b.detail;
    setClass(detailAmt, 'neg', b.negative);
    breakdownUntil = performance.now() + BREAKDOWN_MS;
    detail.classList.add('show');
    flash(detail);
    flash(counter.el);
    gauge.flash();
  }

  /** Gold jumped for another reason (a reward): pulse it. */
  function pulse() {
    flash(counter.el);
  }

  /** Something was built or upgraded: a short puff of steam from the counter. */
  function puff() {
    flash(counter.el, 'puff');
  }

  function update() {
    if (state.speed > 0) lastRunning = state.speed;

    counter.set(state.money);
    const neg = state.money < 0;
    setClass(el, 'neg', neg);

    // Negative gold: the bankruptcy countdown takes the payday text's place.
    if (neg && state.bankruptIn != null) {
      const v = bankruptView(state.bankruptIn, ECON.bankruptcyGraceSeconds);
      setText(next, v.text);
      setClass(next, 'neg', true);
      setClass(next, 'idle', false);
      gauge.set(v.fraction);
      setClass(el, 'danger', true);
    } else {
      const v = paydayView(state.payday);
      const idle = state.clockRunning === false;
      // Nothing is paid or charged until the first track is built.
      setText(next, idle ? 'Clock starts when you build' : v.text);
      setClass(next, 'neg', !idle && v.negative);
      setClass(next, 'idle', idle);
      gauge.set(idle ? 0 : v.fraction);
      setClass(el, 'danger', neg || (!idle && v.negative));
    }

    if (breakdownUntil && performance.now() > breakdownUntil) {
      breakdownUntil = 0;
      detail.classList.remove('show');
    }

    const label = speedLabel(state.speed);
    setText(speedText, label);
    const sp = String(state.speed);
    if (speed.dataset.speed !== sp) {
      speed.dataset.speed = sp;
      speed.setAttribute('aria-label', 'Game speed: ' + label);
    }
    setClass(speed, 'paused', state.speed === 0);
  }

  return { el, speed, update, payday, pulse, puff };
}
