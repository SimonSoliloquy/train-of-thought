import { TRAIN_TYPES, ECON } from '../config.js';
import { h, setText, setClass, setWidth } from './dom.js';
import { fmtMoney, fmtRate, fmtClock, fmtMult, fmtSeconds, fmtInt, netPerMin, milestoneProgress, reputationInfo } from './format.js';

const SPEEDS = [
  { speed: 0, label: '❚❚', title: 'Pause (Space)' },
  { speed: 1, label: '1×', title: 'Normal speed (1)' },
  { speed: 2, label: '2×', title: 'Double speed (2)' },
  { speed: 4, label: '4×', title: 'Fast (3)' },
];

function cell(label, extra) {
  const value = h('div', { class: 'tot-v' });
  const sub = h('div', { class: 'tot-sub' });
  const el = h('div', { class: 'tot-cell' + (extra ? ' ' + extra : '') }, h('div', { class: 'tot-k', text: label }), value, sub);
  return { el, value, sub };
}

export function createHud(ctx) {
  const { game, state } = ctx;

  const money = cell('Cash', 'tot-cell-money');
  const net = cell('Net', 'tot-cell-net');
  const infl = cell('Inflation');
  const rep = cell('Reputation', 'tot-cell-rep');
  const clock = cell('Time');
  const score = cell('Score');

  const linksVal = h('div', { class: 'tot-v' });
  const linksFill = h('div', { class: 'tot-bar-fill' });
  const linksSub = h('div', { class: 'tot-sub' });
  const links = h(
    'div',
    { class: 'tot-cell tot-cell-links' },
    h('div', { class: 'tot-k', text: 'Unique links' }),
    linksVal,
    h('div', { class: 'tot-bar' }, linksFill),
    linksSub,
  );

  const speedBtns = SPEEDS.map((s) =>
    h('button', { class: 'tot-speed', type: 'button', title: s.title, text: s.label, onClick: (e) => { game.setSpeed(s.speed); e.currentTarget.blur(); } }),
  );

  const el = h(
    'header',
    { class: 'tot-panel tot-hud' },
    h('div', { class: 'tot-brand' }, h('span', { class: 'tot-brand-mark' }), h('span', { class: 'tot-brand-name', text: 'Train of Thought' })),
    money.el, net.el, rep.el, infl.el, clock.el, score.el, links,
    h('div', { class: 'tot-speeds', role: 'group', 'aria-label': 'Game speed' }, speedBtns),
  );

  function update() {
    // money
    const neg = state.money < 0;
    setText(money.value, fmtMoney(state.money));
    setClass(money.el, 'neg', neg);
    setText(money.sub, neg && state.bankruptIn != null ? 'Bankrupt in ' + fmtSeconds(state.bankruptIn) : '');

    // net per minute, parts on the second line and in the tooltip
    const n = netPerMin(state);
    setText(net.value, fmtRate(n, true));
    setClass(net.el, 'neg', n < 0);
    setText(net.sub, `links ${fmtInt(state.incomePerMin)} · fares ${fmtInt(state.faresPerMin)} · upkeep ${fmtInt(state.upkeepPerMin)}`);
    const tip = `Link income ${fmtRate(state.incomePerMin, true)}\nFares ${fmtRate(state.faresPerMin, true)}\nUpkeep -${fmtRate(state.upkeepPerMin)}`;
    if (net.el.title !== tip) net.el.title = tip;

    setText(infl.value, fmtMult(state.inflation));

    // reputation: what passengers think of the network, and what that does
    const r = reputationInfo(state.reputation, ECON);
    setText(rep.value, r.percent + '%');
    setText(rep.sub, `${r.word} · fares ${fmtMult(r.fare)}`);
    setClass(rep.el, 'neg', r.tone === 'bad');
    const repTip = `Reputation ${r.percent}% (${r.word})\nFares ${fmtMult(r.fare)}\nPassengers turning up ${fmtMult(r.crowd)}\nFast deliveries raise it; passengers who give up lower it.`;
    if (rep.el.title !== repTip) rep.el.title = repTip;
    setText(clock.value, fmtClock(state.time));
    setText(score.value, fmtInt(state.score));

    // unique links toward the next milestone
    const next = state.nextMilestone;
    const frac = milestoneProgress(state.uniqueLinks, next);
    if (next && frac != null) {
      const t = TRAIN_TYPES[next.unlock];
      setText(linksVal, `${fmtInt(state.uniqueLinks)} / ${fmtInt(next.uniqueLinks)}`);
      setText(linksSub, `unlocks ${t ? t.name : next.unlock}`);
      setWidth(linksFill, frac);
    } else {
      setText(linksVal, fmtInt(state.uniqueLinks));
      setText(linksSub, 'all trains unlocked');
      setWidth(linksFill, 1);
    }

    SPEEDS.forEach((s, i) => setClass(speedBtns[i], 'on', state.speed === s.speed));
  }

  return { el, update };
}
