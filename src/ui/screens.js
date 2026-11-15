// Full-window screens: the start screen and the game-over screen.
import { h, clear } from './dom.js';
import { fmtInt, fmtClock } from './format.js';

export function createScreens(ctx) {
  const { game, state } = ctx;
  const el = h('div', { class: 'tot-screens' });
  let starting = false;
  let error = '';
  let over = null; // payload of the gameOver event, if it arrived
  let shownKey = '';

  const isOver = () => state.phase === 'over' || state.phase === 'gameOver';

  function begin() {
    if (starting) return;
    starting = true;
    error = '';
    render(true);
    let p;
    try {
      p = Promise.resolve(game.start());
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      () => {
        starting = false;
        render();
      },
      (err) => {
        starting = false;
        error = (err && err.message) || String(err) || 'Could not start.';
        render(true);
      },
    );
  }

  function startScreen(loading) {
    const body = [
      h('div', { class: 'tot-start-sign' },
        h('span', { class: 'tot-start-dot' }),
        h('h1', { text: 'Train of Thought' })),
      h('p', { class: 'tot-pitch', text: 'Every station is a Wikipedia article, and track can only follow a real link. Work out the path between ideas, build the line, and keep the trains paid before inflation catches up.' }),
    ];
    if (error) {
      body.push(h('p', { class: 'tot-note bad', role: 'alert', text: error }));
      body.push(h('button', { class: 'tot-btn tot-btn-primary tot-btn-big', type: 'button', text: 'Try again', onClick: begin }));
    } else if (loading) {
      body.push(h('div', { class: 'tot-loading' }, h('span', { class: 'tot-spinner' }), h('span', { text: 'Choosing a random article…' })));
    } else {
      body.push(h('button', { class: 'tot-btn tot-btn-primary tot-btn-big', type: 'button', text: 'Depart', onClick: begin }));
    }
    return h('div', { class: 'tot-overlay' }, h('div', { class: 'tot-panel tot-start' }, body));
  }

  function overScreen() {
    const d = over || {
      score: state.score, time: state.time, delivered: state.delivered, stations: state.stations.size,
    };
    const stat = (k, v) => h('div', { class: 'tot-over-stat' }, h('span', { class: 'tot-k', text: k }), h('b', { text: v }));
    return h('div', { class: 'tot-overlay' },
      h('div', { class: 'tot-panel tot-start tot-over' },
        h('div', { class: 'tot-eyebrow', text: 'Service terminated' }),
        h('h1', { text: 'Bankrupt' }),
        h('div', { class: 'tot-over-score' }, h('span', { class: 'tot-k', text: 'Score' }), h('b', { text: fmtInt(d.score) })),
        h('div', { class: 'tot-over-stats' },
          stat('Time survived', fmtClock(d.time)),
          stat('Thoughts delivered', fmtInt(d.delivered)),
          stat('Stations', fmtInt(d.stations))),
        h('button', { class: 'tot-btn tot-btn-primary tot-btn-big', type: 'button', text: 'New run', onClick: () => location.reload() })));
  }

  /** Redraw only when what is on screen would change. */
  function render(force) {
    const loading = starting || state.phase === 'loading';
    const key = isOver() ? 'over' + (over ? 'e' : 's') : state.phase === 'idle' || loading ? `start:${loading}:${error}` : '';
    if (!force && key === shownKey) return;
    shownKey = key;
    clear(el);
    if (key.startsWith('over')) el.append(overScreen());
    else if (key.startsWith('start')) el.append(startScreen(loading));
  }

  function onGameOver(payload) {
    over = payload || null;
    render(true);
  }

  return { el, render, onGameOver };
}
