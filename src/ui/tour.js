// The first-visit question and the tour, in the manner of Money Minions: ask once ("is it your
// first time?"), remember the answer in the browser, then walk through short steps that each
// point at a real part of the screen. The tour never trusts that a part is there: a step whose
// parts are all missing is skipped, and Escape or Skip closes it. It can be replayed any time.
import { h, setText } from './dom.js';

const KEY = 'tot.tour';

/** The steps. `sel` lists parts of the screen to point at, first match wins (all its matches are ringed). */
export const TOUR = [
  { title: 'Your first station', sel: ['.tot-label.selected', '.tot-label.built'],
    text: 'Every station is a Wikipedia article. This one is where you start.' },
  { title: 'Tickets', sel: ['.tot-tickets'],
    text: 'A ticket asks for a place you have not built yet. Join both ends by track and it pays gold. You never hold more than three.' },
  { title: 'The passenger', sel: ['.tot-label.holder'],
    text: 'The passenger holding the ticket waits at the station the ticket starts from.' },
  { title: 'Signposts', sel: ['.tot-label.sign'],
    text: 'Signposts are a few of the links from your station’s article, each with its price. They do not say which one leads to your ticket.' },
  { title: 'Build', sel: ['.tot-label.tag', '.tot-label.sign'],
    text: 'Click a signpost, then the Build button that appears on the map. A train starts on the new track by itself.' },
  { title: 'Gold and payday', sel: ['.tot-hud'],
    text: 'Gold arrives every 10 seconds. Stations earn for the links on their pages; track and trains cost upkeep. The clock only starts when you first build.' },
  { title: 'Read the article', sel: ['.tot-label.selected', '.tot-label.built'],
    text: 'Click a station to open its real Wikipedia article. Read it to find the link that leads towards your ticket, and click that link to build there. Finding the chain is the game.' },
  { title: 'The surveyor', sel: ['.tot-tk-survey'],
    text: 'Stuck? Pay a surveyor on a ticket. After a short while they turn one signpost gold: the next article to build.' },
  { title: 'The goal', sel: ['.tot-goal'],
    text: 'This line always says what to do next, and pays gold when you do it.' },
  { title: 'Speed', sel: ['.tot-speed'],
    text: 'Change speed here. Space pauses and M turns the sound off. Tracks can be upgraded later by clicking the tag that floats over them.' },
];

function store(value) {
  try {
    if (value === undefined) return window.localStorage.getItem(KEY);
    window.localStorage.setItem(KEY, value);
  } catch {
    /* storage blocked: ask every time, remember nothing */
  }
  return null;
}

/** Every element of the first selector in `sels` that has something on screen. */
export function tourTargets(sels, root = document) {
  for (const q of sels) {
    const found = [...root.querySelectorAll(q)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).opacity !== '0';
    });
    if (found.length) return found;
  }
  return [];
}

export function createTour(ctx) {
  const { game, state } = ctx;
  const count = h('p', { class: 'tot-tour-count' });
  const title = h('h3', { class: 'tot-tour-title' });
  const text = h('p', { class: 'tot-tour-text', 'aria-live': 'polite' });
  const back = h('button', { class: 'tot-btn tot-tour-back', type: 'button', text: 'Back', onClick: () => move(-1) });
  const next = h('button', { class: 'tot-btn tot-btn-primary tot-tour-next', type: 'button', text: 'Next', onClick: () => move(1) });
  const skip = h('button', { class: 'tot-tour-skip', type: 'button', text: 'Skip', onClick: () => stop() });
  const card = h('div', { class: 'tot-panel tot-tour', hidden: true, role: 'dialog', 'aria-label': 'Tour' },
    count, title, text, h('div', { class: 'tot-tour-row' }, back, next, h('span', { class: 'tot-tour-sp' }), skip));

  const yes = h('button', { class: 'tot-btn tot-btn-primary tot-btn-big', type: 'button', text: 'Yes, show me around', onClick: () => { store('yes'); hideSplash(); start(); } });
  const no = h('button', { class: 'tot-btn tot-tour-no', type: 'button', text: 'No, I know my way', onClick: () => { store('no'); hideSplash(); } });
  const splash = h('div', { class: 'tot-splash', hidden: true, role: 'dialog', 'aria-label': 'First time?' },
    h('div', { class: 'tot-panel tot-splash-card' },
      h('h2', { text: 'Is it your first time on the line?' }),
      h('p', { text: 'Train of Thought is a game of building railways between Wikipedia articles. A short tour shows you around.' }),
      yes, no));

  // A small way back in: replay the tour any time.
  const link = h('button', { class: 'tot-tour-link', type: 'button', title: 'Show me around', 'aria-label': 'Show me around', text: '?', onClick: () => start() });

  let steps = [];
  let i = 0;
  let speedBefore = null;

  function clear() {
    for (const el of document.querySelectorAll('.tot-tour-hl')) el.classList.remove('tot-tour-hl');
  }

  function show() {
    const st = steps[i];
    if (!st) return stop();
    clear();
    const targets = tourTargets(st.sel);
    if (!targets.length) { // that part is not on screen: skip the step
      steps.splice(i, 1);
      if (i >= steps.length) return stop();
      return show();
    }
    for (const el of targets) el.classList.add('tot-tour-hl');
    setText(count, `Step ${i + 1} of ${steps.length}`);
    setText(title, st.title);
    setText(text, st.text);
    back.disabled = i === 0;
    setText(next, i === steps.length - 1 ? 'Done' : 'Next');
    card.hidden = false;
    next.focus({ preventScroll: true });
  }

  function start() {
    if (state.phase !== 'running') return;
    hideSplash();
    steps = TOUR.slice();
    i = 0;
    // the game waits while the player reads
    if (speedBefore === null) { speedBefore = state.speed; game.setSpeed(0); }
    show();
  }

  function stop() {
    clear();
    card.hidden = true;
    steps = [];
    if (speedBefore !== null) { game.setSpeed(speedBefore || 1); speedBefore = null; }
    return true;
  }

  function move(d) {
    if (!steps.length) return;
    if (d > 0 && i >= steps.length - 1) return stop();
    i = Math.max(0, i + d);
    show();
  }

  function hideSplash() { splash.hidden = true; }

  /** Ask a first-time visitor once. Called when the game has started. */
  function maybeSplash() {
    if (store()) return;
    splash.hidden = false;
    yes.focus({ preventScroll: true });
  }

  /** Escape: the splash counts as "no", an open tour closes. Returns whether anything closed. */
  function escape() {
    if (!splash.hidden) { store('no'); hideSplash(); return true; }
    if (!card.hidden) return stop();
    return false;
  }

  return { card, splash, link, maybeSplash, start, stop, escape, get isOpen() { return !card.hidden || !splash.hidden; } };
}
