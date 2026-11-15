// Train of Thought: DOM interface over the three.js view. See src/types.js for the contract.
import './styles.css';
import { h } from './dom.js';
import { createCtx } from './ctx.js';
import { createHud } from './hud.js';
import { createGoal } from './goal.js';
import { createBoard } from './board.js';
import { createCard } from './card.js';
import { createBuildCard } from './buildcard.js';
import { createToasts, createRideLabel } from './notes.js';
import { createScreens } from './screens.js';
import { createSound } from './sound.js';

const TICK = 0.1; // seconds between live-number refreshes
const SPEED_KEYS = { 1: 1, 2: 2, 3: 4 };

/** @param {{root: HTMLElement, game: import('../types.js').Game, renderer: import('../types.js').Renderer}} deps */
export function createUI({ root, game, renderer }) {
  const state = game.state;

  const toasts = createToasts();
  const ctx = createCtx({ game, renderer, toast: toasts.show });

  const hud = createHud(ctx);
  const goal = createGoal(ctx);
  const board = createBoard(ctx);
  const card = createCard(ctx);
  const buildCard = createBuildCard(ctx);
  const rideLabel = createRideLabel(ctx);
  const screens = createScreens(ctx);
  const sound = createSound({ game });

  // Layout: gold readout top left, speed top right, the goal line top centre (its own row when
  // narrow), then the stage under them. The stage holds the passenger queue (left), the side
  // column (build card above station card, right; a bottom sheet when narrow) and the notes
  // (riding label, toasts) floating top centre.
  const side = h('div', { class: 'tot-side' }, buildCard.el, card.el);
  const notes = h('div', { class: 'tot-notes' }, rideLabel.el, toasts.el);
  const stage = h('div', { class: 'tot-stage' }, board.el, side, notes);
  const app = h('div', { class: 'tot tot-root' }, hud.el, hud.speed, goal.el, stage, screens.el);
  app.dataset.phase = state.phase === 'gameOver' ? 'over' : state.phase;
  root.append(app);

  // ------------------------------------------------------------ dirty flags
  // Events only mark work; it is done at most once per frame in update().
  const dirty = { board: false, card: false, hud: false, goal: false };
  const on = (name, fn) => game.on(name, fn);

  on('toast', (e) => toasts.show(e.text, e.tone));
  on('started', (e) => {
    dirty.board = dirty.card = dirty.hud = dirty.goal = true;
    screens.render();
    // Open the first station's card straight away: photo, title and intro text.
    if (e && e.station) ctx.select(e.station.title, { kind: 'station' });
  });
  for (const name of ['stationBuilt', 'trackBuilt', 'ghostsAdded', 'trackUpgraded']) {
    on(name, () => {
      dirty.board = dirty.card = dirty.goal = true;
    });
  }
  for (const name of ['thoughtSpawned', 'thoughtBoarded', 'thoughtDelivered', 'thoughtLost']) {
    on(name, () => {
      dirty.board = dirty.goal = true;
    });
  }
  on('payday', (e) => {
    hud.payday(e);
    dirty.hud = true;
  });
  on('goalDone', (e) => {
    goal.done(e);
    hud.pulse();
    dirty.hud = true;
  });
  on('routeBonus', () => {
    hud.pulse();
    dirty.hud = true;
  });
  on('gameOver', (e) => {
    ctx.stopRide();
    ctx.deselect();
    screens.onGameOver(e);
  });

  function flush() {
    if (dirty.board) { dirty.board = false; board.refresh(); }
    if (dirty.card) { dirty.card = false; card.refresh(); buildCard.refresh(); }
    if (dirty.hud) { dirty.hud = false; hud.update(); }
    if (dirty.goal) { dirty.goal = false; goal.update(); }
  }

  const sync = () => {
    app.classList.toggle('has-card', !!ctx.sel);
    app.classList.toggle('has-build', !!ctx.build);
  };
  ctx.bus.on('selection', sync);
  ctx.bus.on('build', sync);

  // ------------------------------------------------------------ map picks
  const offPick = renderer.onPick((pick) => {
    if (state.phase !== 'running') return;
    switch (pick.kind) {
      case 'station':
        ctx.select(pick.title);
        break;
      case 'ghost':
        // A signpost: price building towards it from the station being viewed.
        ctx.openBuild(pick.title, ctx.sel && ctx.sel.kind === 'station' ? ctx.sel.title : null);
        break;
      case 'thought':
        ctx.selectThought(pick.thoughtId);
        break;
      case 'upgrade':
        ctx.report(game.upgradeTrack(pick.trackId, pick.typeId));
        dirty.goal = true;
        break;
      case 'train':
        if (ctx.riding === pick.trainId) ctx.stopRide();
        else ctx.startRide(pick.trainId);
        break;
      default:
        ctx.stopRide();
        ctx.deselect();
    }
  });
  void offPick;

  // ------------------------------------------------------------ keyboard
  let lastSpeed = 1;

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (state.phase !== 'running') return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (e.key === 'Escape') {
      if (typing) return; // the search box handles its own Escape
      if (ctx.back()) e.preventDefault();
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
    } else if (e.key === 'm' || e.key === 'M') {
      toasts.show(sound.toggleMute() ? 'Sound off' : 'Sound on', 'info', 1400);
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
    if (p === 'running' || p === 'over') dirty.board = dirty.card = dirty.hud = dirty.goal = true;
  }

  // No start button: the game starts as soon as the interface is up.
  if (state.phase === 'idle') screens.begin();

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
      goal.update();
      board.update();
      card.update();
      buildCard.update();
      rideLabel.update();
      sound.update();
    },
  };
}
