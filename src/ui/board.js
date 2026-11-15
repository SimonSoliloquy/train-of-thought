// The best-runs board. It lives in this browser only (localStorage): no server, no account,
// nothing to pay for. A run records its score and a few facts; it changes nothing about the next run.

export const BOARD_KEY = 'tot.runs';
export const BOARD_SIZE = 10;

const num = (x) => (Number.isFinite(x) ? x : 0);

const title = (x) => (typeof x === 'string' && x ? x.slice(0, 120) : null);

/** A run as stored: only plain numbers, the start article's title and the longest line's two ends. */
export function cleanRun(run, now = Date.now()) {
  return {
    score: Math.round(num(run && run.score)),
    time: Math.round(num(run && run.time)),
    stations: Math.round(num(run && run.stations)),
    tickets: Math.round(num(run && run.tickets)),
    delivered: Math.round(num(run && run.delivered)),
    start: typeof (run && run.start) === 'string' ? run.start.slice(0, 120) : '',
    lineFrom: title(run && run.lineFrom),
    lineTo: title(run && run.lineTo),
    at: Math.round(num(run && run.at) || now),
  };
}

/** Best score first; of equal scores, the earlier run keeps its place. */
export function sortRuns(runs) {
  return runs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.score - a.r.score || a.r.at - b.r.at || a.i - b.i)
    .map((x) => x.r);
}

/** Reads the board. Anything unreadable is an empty board, never an error. */
export function loadRuns(storage) {
  try {
    const raw = storage && storage.getItem(BOARD_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return sortRuns(list.filter((r) => r && typeof r === 'object').map((r) => cleanRun(r, 0))).slice(0, BOARD_SIZE);
  } catch {
    return [];
  }
}

/**
 * Adds a finished run and saves the board.
 * @returns {{runs: object[], rank: number|null, best: boolean}} the board after the run; `rank` is the
 *   run's place (1 = best) or null if it did not make the board; `best` is true for a new top score.
 */
export function saveRun(storage, run, now = Date.now()) {
  const mine = cleanRun(run, now);
  const before = loadRuns(storage);
  const all = sortRuns([...before, mine]);
  const runs = all.slice(0, BOARD_SIZE);
  const at = runs.indexOf(mine);
  const rank = at >= 0 ? at + 1 : null;
  try {
    if (storage) storage.setItem(BOARD_KEY, JSON.stringify(runs));
  } catch {
    // a full or blocked store just means the board is not kept
  }
  return { runs, rank, best: rank === 1 && (before.length === 0 || mine.score > before[0].score) };
}
