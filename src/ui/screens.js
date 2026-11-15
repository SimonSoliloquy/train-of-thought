// Full-window states: the automatic start (loading / error) and the game-over screen.
import { h, clear } from './dom.js';
import { fmtInt, fmtDuration, fmtOrdinal } from './format.js';
import { saveRun } from './board.js';
import { sharedBoardOn, submitRun, fetchTop, loadName, saveName, NAME_MAX, ANONYMOUS } from './remote-board.js';

/** A run never touched on the game-over screen goes to the shared board after this long. */
const SUBMIT_AFTER_MS = 30000;

/** "A \u2192 B", the run's longest train line, or '' when it had none. */
function lineText(r) {
  return r && r.lineFrom && r.lineTo ? `${r.lineFrom} \u2192 ${r.lineTo}` : '';
}

/** "4:07": a run's length on the board. */
function clock(sec) {
  const t = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked: the board is not kept
  }
}

export function createScreens(ctx) {
  const { game, state } = ctx;
  const el = h('div', { class: 'tot-screens' });
  let starting = false;
  let error = '';
  let over = null; // payload of the gameOver event, if it arrived
  let shownKey = '';
  let board = null; // { runs, rank, best } once this run is on the board
  const sharedOn = sharedBoardOn();
  let shared = null; // { daily, alltime, ranks } once a shared board has been read
  let sharedAsked = 0, sharedDrawn = 0; // so a slow first read never covers the read made after sending
  let submitted = false; // this run has gone to the shared board (or was meant to: once only)
  let submitTimer = 0;
  let boardsEl = null;
  let nameInput = null;

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
    boardsEl = h('div', { class: 'tot-boards' });
    drawBoards();
    return h('div', { class: 'tot-overlay' },
      h('div', { class: 'tot-panel tot-start tot-over' },
        h('h1', { text: 'Game over' }),
        h('p', { class: 'tot-note', text: 'You ran out of gold.' }),
        h('div', { class: 'tot-over-stats' },
          stat('Time survived', fmtDuration(d.time)),
          stat('Passengers delivered', fmtInt(d.delivered)),
          stat('Stations', fmtInt(d.stations)),
          stat('Score', fmtInt(d.score))),
        lineView(d),
        nameView(),
        boardsEl,
        h('button', { class: 'tot-btn tot-btn-primary tot-btn-big', type: 'button', text: 'New run', onClick: newRun }),
        h('p', { class: 'tot-over-credit' }, 'Built by ',
          h('a', { href: 'https://simonsoliloquy.com', target: '_blank', rel: 'noopener', text: 'simonsoliloquy.com' }))));
  }

  /** "Longest line: A → B" under the numbers, when the run joined two stations. */
  function lineView(d) {
    const text = lineText(d);
    if (!text) return null;
    return h('p', { class: 'tot-over-line' }, h('span', { class: 'tot-k', text: 'Longest line' }), ' ', h('b', { text }));
  }

  /**
   * The one optional field: the name this run goes on the shared boards under. It sends the run
   * when the player presses Enter or leaves the field, or soon after game over if they never
   * touch it; no button. Remembered for the next run.
   */
  function nameView() {
    if (!sharedOn) return null;
    nameInput = h('input', {
      class: 'tot-name-input', type: 'text', maxlength: String(NAME_MAX), placeholder: ANONYMOUS,
      autocomplete: 'nickname', spellcheck: 'false', enterkeyhint: 'done', 'aria-label': 'Your name on the shared board (optional)',
    });
    nameInput.value = loadName(storage());
    nameInput.disabled = submitted;
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); submitNow(); }
    });
    nameInput.addEventListener('blur', () => submitNow());
    return h('label', { class: 'tot-name' }, h('span', { class: 'tot-k', text: 'Your name on the board' }), nameInput);
  }

  // ---------------------------------------------------------------- the shared boards

  /** Fetch both shared boards; draw them when they come, keep the local board when they do not. */
  async function loadShared(ranks) {
    const mine = ++sharedAsked;
    const [daily, alltime] = await Promise.all([fetchTop('daily'), fetchTop('alltime')]);
    if (mine < sharedDrawn) return; // a later read (after this run was sent) already answered
    if (daily === null && alltime === null && shared) return; // a failed refresh keeps what is shown
    sharedDrawn = mine;
    shared = { daily, alltime, ranks: ranks || (shared && shared.ranks) || null };
    drawBoards();
  }

  /** Send this run, once. Later calls do nothing. */
  function submitNow(keepalive = false) {
    if (!sharedOn || submitted || !over) return;
    submitted = true;
    clearTimeout(submitTimer);
    const name = nameInput ? saveName(storage(), nameInput.value) : loadName(storage());
    if (nameInput) {
      nameInput.value = name;
      nameInput.disabled = true;
    }
    submitRun(over, { storage: storage(), name, keepalive }).then((ranks) => {
      if (ranks) loadShared(ranks);
    });
  }

  /** Never touched: send it after a short read of the screen, but not while the name is being typed. */
  function submitSoon() {
    clearTimeout(submitTimer);
    submitTimer = setTimeout(() => {
      if (nameInput && document.activeElement === nameInput) return; // its blur sends it
      submitNow();
    }, SUBMIT_AFTER_MS);
  }

  function newRun() {
    submitNow(true);
    location.reload();
  }

  function drawBoards() {
    if (!boardsEl) return;
    clear(boardsEl);
    const s = shared;
    // the shared boards take the local board's place once they have a run to show
    const any = s && ((s.daily && s.daily.length) || (s.alltime && s.alltime.length));
    if (!any) {
      boardsEl.append(...[localBoard()].filter(Boolean));
      return;
    }
    const r = s.ranks;
    if (s.daily) boardsEl.append(table('Best runs today', s.daily, r && r.rankDaily, true, 'No runs yet today.'));
    if (s.alltime) boardsEl.append(table('Best runs of all time', s.alltime, r && r.rankAllTime, true, 'No runs yet.'));
    const bits = [];
    if (r && r.rankDaily) bits.push(`${fmtOrdinal(r.rankDaily)} today`);
    if (r && r.rankAllTime) bits.push(`${fmtOrdinal(r.rankAllTime)} of all time`);
    if (r && r.totalPlayers) bits.push(`${fmtInt(r.totalPlayers)} ${r.totalPlayers === 1 ? 'player' : 'players'}`);
    if (board && board.best) bits.push('a new best on this machine');
    if (bits.length) boardsEl.append(h('p', { class: 'tot-note tot-board-ranks', text: `This run: ${bits.join(' \u00b7 ')}.` }));
  }

  /** The best runs on this machine, this run's row picked out. */
  function localBoard() {
    if (!board || !board.runs.length) return null;
    const el = table('Best runs on this machine', board.runs, board.rank, false, '');
    if (board.best) el.firstChild.append(h('span', { class: 'tot-board-best', text: 'New best' }));
    if (!board.rank) el.append(h('p', { class: 'tot-note', text: 'This run did not make the board.' }));
    return el;
  }

  /** One board. `named`: shared rows lead with the player's name, local ones with the start article. */
  function table(heading, runs, mineRank, named, emptyText) {
    const head = h('tr', {}, ...['#', 'Score', 'Stations', 'Tickets', 'Time', named ? 'Player \u00b7 line' : 'Start \u00b7 line']
      .map((t) => h('th', { scope: 'col', text: t })));
    const rows = runs.map((r, i) => {
      const first = named ? r.name || ANONYMOUS : r.start || '';
      const line = lineText(r);
      const tip = [named ? `${first}, started at ${r.start || '?'}` : `Started at ${first}`, line ? `longest line ${line}` : '']
        .filter(Boolean).join('; ');
      return h('tr', { class: i + 1 === mineRank ? 'mine' : null },
        h('td', { text: String(i + 1) }),
        h('td', { class: 'num', text: fmtInt(r.score) }),
        h('td', { class: 'num', text: fmtInt(r.stations) }),
        h('td', { class: 'num', text: fmtInt(r.tickets) }),
        h('td', { class: 'num', text: clock(r.time) }),
        h('td', { class: 'start', title: tip },
          h('span', { class: named ? 'tot-board-name' : null, text: first }),
          h('span', { class: 'tot-board-line', text: line || '\u2014' })));
    });
    return h('div', { class: 'tot-board' },
      h('div', { class: 'tot-board-head' }, h('h2', { text: heading })),
      runs.length
        ? h('table', {}, h('thead', {}, head), h('tbody', {}, rows))
        : h('p', { class: 'tot-note', text: emptyText }));
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
    const first = over && !board;
    if (first) board = saveRun(storage(), over); // once per run, and drawn at once
    render(true);
    if (first && sharedOn) {
      loadShared(null); // in the background: the screen above never waits for it
      submitSoon();
      window.addEventListener('pagehide', () => submitNow(true)); // closing the tab still sends it
    }
  }

  return { el, render, begin, onGameOver };
}
