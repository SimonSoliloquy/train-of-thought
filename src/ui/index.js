// Train of Thought: DOM interface over the three.js view. See src/types.js for the contract.
import './styles.css';
import { h } from './dom.js';
import { createCtx } from './ctx.js';
import { createHud } from './hud.js';
import { createBoard } from './board.js';
import { createCard } from './card.js';
import { createLines } from './lines.js';
import { createToasts, createHints } from './notes.js';
import { createScreens } from './screens.js';

const TICK = 0.1; // seconds between live-number refreshes
const SPEED_KEYS = { 1: 1, 2: 2, 3: 4 };

/** @param {{root: HTMLElement, game: import('../types.js').Game, renderer: import('../types.js').Renderer}} deps */
export function createUI({ root, game, renderer }) {
  const state = game.state;

  const toasts = createToasts();
  const ctx = createCtx({ game, renderer, toast: toasts.show });

  const hud = createHud(ctx);
  const board = createBoard(ctx);
  const card = createCard(ctx);
  const lines = createLines(ctx);
  const hints = createHints(ctx);
  const screens = createScreens(ctx);

  // Layout: HUD on top, a stack below it. The stack holds a middle area (board left, card
  // right) and the lines panel along the bottom. Notes (banner, hint, toasts) float top centre.
  const mid = h('div', { class: 'tot-mid' }, board.el, card.el);
  const stack = h('div', { class: 'tot-stack' }, mid, lines.el);
  const notes = h('div', { class: 'tot-notes' }, lines.banner, lines.rideBar, hints.el, toasts.el);
  const app = h('div', { class: 'tot' }, hud.el, stack, notes, screens.el);
  app.dataset.phase = state.phase === 'gameOver' ? 'over' : state.phase;
  root.append(app);

  // ------------------------------------------------------------ dirty flags
  // Events only mark work; it is done at most once per frame in update().
  const dirty = { board: false, card: false, lines: false, hints: false };
  const off = [];
  const on = (name, fn) => off.push(game.on(name, fn));

  on('toast', (e) => toasts.show(e.text, e.tone));
  on('milestone', (e) => {
    toasts.milestone(e);
    dirty.lines = true; // new train type may now be on sale
  });
  on('started', (e) => {
    dirty.board = dirty.card = dirty.lines = dirty.hints = true;
    screens.render();
    // Open the first station's card straight away: title, photo and intro text.
    if (e && e.station) ctx.select(e.station.title, { kind: 'station' });
  });
  for (const name of ['stationBuilt', 'trackBuilt', 'ghostsAdded']) {
    on(name, () => {
      dirty.board = dirty.card = dirty.hints = true;
    });
  }
  for (const name of ['thoughtSpawned', 'thoughtBoarded', 'thoughtDelivered', 'thoughtLost']) {
    on(name, () => {
      dirty.board = true;
    });
  }
  on('linesChanged', () => {
    dirty.lines = true;
    dirty.hints = true;
  });
  on('trainsChanged', () => {
    dirty.lines = true;
    dirty.hints = true;
  });
  on('gameOver', (e) => {
    ctx.cancelAll();
    screens.onGameOver(e);
  });

  ctx.cancelAll = () => {
    lines.cancel();
    ctx.stopRide();
    ctx.deselect();
  };

  function flush() {
    if (dirty.board) { dirty.board = false; board.refresh(); }
    if (dirty.card) { dirty.card = false; card.refresh(); }
    if (dirty.lines) { dirty.lines = false; lines.refresh(); }
    if (dirty.hints) { dirty.hints = false; hints.refresh(); }
  }

  ctx.bus.on('selection', () => {
    hints.refresh();
    app.classList.toggle('has-card', !!ctx.sel);
  });
  ctx.bus.on('mode', () => {
    app.classList.toggle('drawing', !!ctx.mode);
    hints.refresh();
  });

  // ------------------------------------------------------------ map picks
  const offPick = renderer.onPick((pick) => {
    if (state.phase !== 'running') return;
    if (ctx.mode) {
      // While drawing a line the map only adds stops; cards stay closed.
      if (pick.kind === 'station') lines.addStop(pick.title);
      else if (pick.kind === 'ghost') lines.note('Only built stations can be on a line.');
      return;
    }
    switch (pick.kind) {
      case 'station':
      case 'ghost':
        ctx.select(pick.title);
        break;
      case 'thought':
        ctx.selectThought(pick.thoughtId);
        break;
      case 'train':
        lines.flashTrain(pick.trainId);
        break;
      default:
        ctx.deselect();
    }
  });
  off.push(offPick);

  // ------------------------------------------------------------ keyboard
  let lastSpeed = 1;

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (state.phase !== 'running') return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (e.key === 'Escape') {
      if (typing) return; // the filter box handles its own Escape
      if (lines.cancel()) e.preventDefault();
      else if (ctx.sel) { ctx.deselect(); e.preventDefault(); }
      else if (ctx.riding != null) { ctx.stopRide(); e.preventDefault(); }
      return;
    }
    if (typing) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (t && t.tagName === 'BUTTON') t.blur();
      if (state.speed > 0) lastSpeed = state.speed;
      game.setSpeed(state.speed > 0 ? 0 : lastSpeed || 1);
    } else if (SPEED_KEYS[e.key]) {
      game.setSpeed(SPEED_KEYS[e.key]);
    }
  }
  window.addEventListener('keydown', onKey);

  // ------------------------------------------------------------ frame tick
  let acc = TICK; // first update paints immediately
  let lastPhase = null;

  function applyPhase() {
    const p = state.phase === 'gameOver' ? 'over' : state.phase;
    app.dataset.phase = p;
    screens.render();
    if (p === 'running' || p === 'over') {
      dirty.board = dirty.card = dirty.lines = dirty.hints = true;
    }
  }

  return {
    update(dt) {
      if (state.phase !== lastPhase) {
        lastPhase = state.phase;
        applyPhase();
      }
      flush();
      acc += dt;
      if (acc < TICK) return;
      acc = 0;
      if (state.speed > 0) lastSpeed = state.speed;
      if (state.phase === 'idle' || state.phase === 'loading') return;
      hud.update();
      board.update();
      card.update();
      lines.update();
      hints.refresh();
    },
  };
}
