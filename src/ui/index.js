// Train of Thought: DOM interface over the three.js view. See src/types.js for the contract.
import './styles.css';
import { h } from './dom.js';
import { createCtx } from './ctx.js';
import { createHud } from './hud.js';
import { createGoal } from './goal.js';
import { createTickets } from './tickets.js';
import { createArticle } from './article.js';
import { createBuildCard } from './buildcard.js';
import { createToasts, createRideLabel } from './notes.js';
import { createScreens } from './screens.js';
import { createSound } from './sound.js';
import { createTour } from './tour.js';

const TICK = 0.1; // seconds between live-number refreshes
const SPEED_KEYS = { 1: 1, 2: 2, 3: 4 };

/** @param {{root: HTMLElement, game: import('../types.js').Game, renderer: import('../types.js').Renderer}} deps */
export function createUI({ root, game, renderer, wiki }) {
  const state = game.state;

  const toasts = createToasts();
  const ctx = createCtx({ game, renderer, toast: toasts.show });

  const hud = createHud(ctx);
  const goal = createGoal(ctx);
  const tickets = createTickets(ctx);
  const article = createArticle(ctx, wiki);
  const buildCard = createBuildCard(ctx);
  const rideLabel = createRideLabel(ctx);
  const screens = createScreens(ctx);
  const sound = createSound({ game });
  const tour = createTour(ctx);

  // Layout: gold readout top left with the tickets under it, speed top right, the goal line top
  // centre (its own row when narrow). The stage holds the notes (riding label, toasts). The
  // station's real Wikipedia article is a translucent panel down the right edge that opens only
  // when the player clicks a station; its links are how the player picks where to build. No build button: the 3D view
  // floats it over the place being built towards.
  const notes = h('div', { class: 'tot-notes' }, rideLabel.el, toasts.el);
  const stage = h('div', { class: 'tot-stage' }, notes);
  // A small credit in the corner of the main page.
  const credit = h('a', { class: 'tot-credit', href: 'https://simonsoliloquy.com', target: '_blank', rel: 'noopener', text: 'simonsoliloquy.com' });
  const app = h('div', { class: 'tot tot-root' }, hud.el, hud.speed, tour.link, goal.el, tickets.el, stage, credit, article.el, tour.card, tour.splash, screens.el);
  app.dataset.phase = state.phase === 'gameOver' ? 'over' : state.phase;
  root.append(app);

  // ------------------------------------------------------------ dirty flags
  // Events only mark work; it is done at most once per frame in update().
  const dirty = { tickets: false, builder: false, search: false, hud: false, goal: false };
  const on = (name, fn) => game.on(name, fn);

  on('toast', (e) => toasts.show(e.text, e.tone));
  on('started', (e) => {
    dirty.tickets = dirty.hud = dirty.goal = true;
    screens.render();
    // Select the first station so its signposts show. Nothing opens.
    if (e && e.station) ctx.select(e.station.title, { kind: 'station' });
    // First visit: offer the tour once the first ticket has had a moment to arrive.
    setTimeout(() => tour.maybeSplash(), 2500);
  });
  for (const name of ['stationBuilt', 'trackBuilt', 'ghostsAdded', 'trackUpgraded']) {
    on(name, () => {
      dirty.builder = dirty.search = dirty.goal = true;
    });
  }
  for (const name of ['thoughtDelivered', 'thoughtLost']) on(name, () => { dirty.goal = true; });
  for (const name of ['ticketAdded', 'ticketExpired', 'ticketHint']) on(name, () => { dirty.tickets = dirty.search = true; });
  on('ticketDone', (e) => {
    tickets.done(e);
    hud.pulse();
    dirty.hud = dirty.goal = dirty.search = true;
  });
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
    tour.stop();
    ctx.stopRide();
    ctx.deselect();
    screens.onGameOver(e);
  });

  function flush() {
    if (dirty.tickets) { dirty.tickets = false; tickets.sync(); }
    if (dirty.builder) { dirty.builder = false; buildCard.refresh(); }
    if (dirty.search) { dirty.search = false; article.refresh(); }
    if (dirty.hud) { dirty.hud = false; hud.update(); }
    if (dirty.goal) { dirty.goal = false; goal.update(); }
  }

  // ------------------------------------------------------------ map picks
  const offPick = renderer.onPick((pick) => {
    if (state.phase !== 'running') return;
    switch (pick.kind) {
      case 'station':
        // A click on a station selects it (signposts) and opens its article.
        ctx.select(pick.title);
        article.open(pick.title);
        break;
      case 'ghost':
        // A signpost: price building towards it from the station being viewed.
        ctx.openBuild(pick.title, ctx.sel ? ctx.sel.title : null);
        break;
      case 'build':
        buildCard.build(pick.title);
        break;
      case 'article':
        // The picture over a station: the same as clicking the station.
        ctx.select(pick.title);
        article.open(pick.title);
        break;
      case 'thought':
        break; // ordinary passengers are no longer listed or opened anywhere
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
      if (tour.escape()) { e.preventDefault(); return; }
      if (article.close()) { e.preventDefault(); return; } // the article first; the station stays selected
      if (typing) return;
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
    if (p === 'running' || p === 'over') dirty.tickets = dirty.hud = dirty.goal = true;
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
      tickets.update();
      buildCard.update();
      rideLabel.update();
      sound.update();
    },
  };
}
