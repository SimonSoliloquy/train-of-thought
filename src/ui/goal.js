// The goal line: one goal at a time, always visible. It doubles as the tutorial.
import { h, setText, setClass, setWidth } from './dom.js';
import { goalView, goalDoneText } from './format.js';

const CELEBRATE_MS = 2600;

export function createGoal(ctx) {
  const { state } = ctx;
  let celebrateUntil = 0;
  let celebrateText = '';

  const text = h('span', { class: 'tot-goal-text' });
  const progress = h('b', { class: 'tot-goal-progress' });
  const reward = h('b', { class: 'tot-goal-reward' });
  const how = h('div', { class: 'tot-goal-how' });
  const fill = h('div', { class: 'tot-bar-fill' });
  const bar = h('div', { class: 'tot-bar tot-goal-bar' }, fill);
  const el = h('div', { class: 'tot-panel tot-goal', role: 'status', hidden: true },
    h('div', { class: 'tot-goal-main' }, text, progress, reward),
    how,
    bar);

  /** A goal was met: say so for a moment, then the next one appears. */
  function done(e) {
    celebrateText = goalDoneText(e && e.reward);
    celebrateUntil = performance.now() + CELEBRATE_MS;
    el.classList.remove('celebrate');
    void el.offsetWidth;
    el.classList.add('celebrate');
    update();
  }

  function update() {
    const celebrating = celebrateUntil > performance.now();
    if (!celebrating && celebrateUntil) {
      celebrateUntil = 0;
      el.classList.remove('celebrate');
    }
    if (celebrating) {
      el.hidden = false;
      setText(text, celebrateText);
      setText(progress, '');
      setText(reward, '');
      setText(how, '');
      setWidth(fill, 1);
      setClass(bar, 'multi', false);
      return;
    }
    const v = goalView(state.goal);
    el.hidden = !v;
    if (!v) return;
    setText(text, v.text);
    setText(progress, v.progress);
    setText(reward, v.reward);
    setText(how, v.how);
    const g = state.goal;
    setWidth(fill, g.target > 0 ? g.progress / g.target : 0);
    setClass(bar, 'multi', g.target > 1);
  }

  return { el, update, done };
}
