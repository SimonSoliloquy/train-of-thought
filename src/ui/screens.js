// Full-window states: the automatic start (loading / error) and the game-over screen.
import { h, clear } from './dom.js';
import { fmtInt, fmtDuration } from './format.js';

export function createScreens(ctx) {
  const { game, state } = ctx;
  const el = h('div', { class: 'tot-screens' });
  let starting = false;
  let error = '';
  let over = null; // payload of the gameOver event, if it arrived
  let shownKey = '';

  const isOver = () => state.phase === 'over' || state.phase === 'gameOver';

  /** Start the game. Called once on load, and again by "Try again". */
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

  function startPanel(loading) {
    if (error) {
      return h('div', { class: 'tot-center' }, h('div', { class: 'tot-panel tot-loadpanel' },
        h('p', { class: 'tot-note bad', role: 'alert', text: error }),
        h('button', { class: 'tot-btn tot-btn-primary', type: 'button', text: 'Try again', onClick: begin })));
    }
    return h('div', { class: 'tot-center' }, h('div', { class: 'tot-panel tot-loadpanel' },
      h('div', { class: 'tot-loading' }, h('span', { class: 'tot-spinner' }), h('span', { text: loading ? 'Finding a starting article\u2026' : 'Train of Thought' }))));
  }

  function overScreen() {
    const d = over || { score: state.score, time: state.time, delivered: state.delivered, stations: state.stations.size };
    const stat = (k, v) => h('div', { class: 'tot-over-stat' }, h('span', { class: 'tot-k', text: k }), h('b', { text: v }));
    return h('div', { class: 'tot-overlay' },
      h('div', { class: 'tot-panel tot-start tot-over' },
        h('h1', { text: 'Game over' }),
        h('p', { class: 'tot-note', text: 'You ran out of gold.' }),
        h('div', { class: 'tot-over-stats' },
          stat('Time survived', fmtDuration(d.time)),
          stat('Passengers delivered', fmtInt(d.delivered)),
          stat('Stations', fmtInt(d.stations)),
          stat('Score', fmtInt(d.score))),
        h('button', { class: 'tot-btn tot-btn-primary tot-btn-big', type: 'button', text: 'New run', onClick: () => location.reload() }),
        h('p', { class: 'tot-over-credit' }, 'Built by ',
          h('a', { href: 'https://simonsoliloquy.com', target: '_blank', rel: 'noopener', text: 'simonsoliloquy.com' }))));
  }

  /** Redraw only when what is on screen would change. */
  function render(force) {
    const loading = starting || state.phase === 'loading';
    const key = isOver() ? 'over' + (over ? 'e' : 's') : state.phase === 'idle' || loading ? `start:${loading}:${error}` : '';
    if (!force && key === shownKey) return;
    shownKey = key;
    clear(el);
    if (key.startsWith('over')) el.append(overScreen());
    else if (key.startsWith('start')) el.append(startPanel(loading));
  }

  function onGameOver(payload) {
    over = payload || null;
    render(true);
  }

  return { el, render, begin, onGameOver };
}
