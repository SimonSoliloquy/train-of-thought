// The shared boards: every player's finished runs, kept by a small public Cloudflare Worker
// (shared with other games; this game only ever calls its /train-of-thought/ routes). No keys,
// no account: a run carries a random player id kept in this browser and an optional name.
// Every call times out and resolves to null on any failure, so the game never waits on it.
// Free-tier budget: at most one GET of the list per page load (kept in memory, shared by every
// caller) and one POST per saved run, whose answer carries the updated list, so nothing re-reads it.
// The POST goes as text/plain (no Content-Type header) so the browser sends no CORS preflight.

export const LEADERBOARD_URL = 'https://leaderboards.ai-wizards.workers.dev';
const GAME_PATH = '/train-of-thought';
export const PLAYER_KEY = 'tot.player';
export const NAME_KEY = 'tot.name';
export const NAME_MAX = 20;
export const TOP_N = 10;
export const TIMEOUT_MS = 5000;
export const ANONYMOUS = 'Anonymous';

/** False while the address is still the placeholder (or not https): then nothing is ever fetched. */
export function sharedBoardOn(base = LEADERBOARD_URL) {
  return typeof base === 'string' && base.startsWith('https://') && !base.includes('WORKER_SUBDOMAIN');
}

/** This machine, where runs are tested, never submits: localhost, 127.x, [::1], *.localhost, or no host. */
export function isLocalHost(hostname) {
  const hn = String(hostname || '').toLowerCase();
  return !hn || hn === 'localhost' || hn.endsWith('.localhost') || hn.startsWith('127.') ||
    hn === '[::1]' || hn === '::1' || hn === '0.0.0.0';
}

// control characters, zero-width and direction marks, line separators, byte-order mark
const INVISIBLE = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
  .map(([a, b]) => `\\u${a.toString(16).padStart(4, '0')}-\\u${b.toString(16).padStart(4, '0')}`).join('') + ']', 'g');

/** A name as typed, made plain: no control characters, single spaces, at most NAME_MAX characters. */
export function cleanName(s) {
  if (typeof s !== 'string') return '';
  const plain = s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return [...plain].slice(0, NAME_MAX).join('').trim();
}

export function loadName(storage) {
  try {
    return cleanName(storage && storage.getItem(NAME_KEY));
  } catch {
    return '';
  }
}

export function saveName(storage, name) {
  const n = cleanName(name);
  try {
    if (storage) {
      if (n) storage.setItem(NAME_KEY, n);
      else if (storage.removeItem) storage.removeItem(NAME_KEY);
    }
  } catch {
    // blocked storage: the name is just not remembered
  }
  return n;
}

function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** This browser's random player id, made once and kept (key tot.player). */
export function playerId(storage, make = randomId) {
  try {
    const have = storage && storage.getItem(PLAYER_KEY);
    if (typeof have === 'string' && /^[\w-]{8,64}$/.test(have)) return have;
  } catch {
    // fall through to a fresh id
  }
  const id = make();
  try {
    if (storage) storage.setItem(PLAYER_KEY, id);
  } catch {
    // not kept: this run still gets an id
  }
  return id;
}

const int = (x) => (Number.isFinite(x) ? Math.round(x) : 0);
const title = (x) => (typeof x === 'string' && x ? x.slice(0, 120) : null);

/** The POST body for one finished run (the gameOver payload). */
export function submitBody(run, player, name) {
  const r = run || {};
  return {
    player,
    name: cleanName(name),
    score: int(r.score),
    time: int(r.time),
    stations: int(r.stations),
    tickets: int(r.tickets),
    delivered: int(r.delivered),
    start: title(r.start) || '',
    lineFrom: title(r.lineFrom),
    lineTo: title(r.lineTo),
  };
}

/** fetch with a hard time limit; parsed JSON on a 2xx answer, else null. Never throws. */
async function request(url, init, { fetch: f = globalThis.fetch, timeout = TIMEOUT_MS } = {}) {
  if (typeof f !== 'function') return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (ctl) ctl.abort();
      resolve(null);
    }, timeout);
  });
  const call = (async () => {
    try {
      const res = await f(url, { ...init, signal: ctl ? ctl.signal : undefined });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([call, late]);
  } finally {
    clearTimeout(timer);
  }
}

const rank = (x) => (Number.isFinite(x) && x >= 1 ? Math.round(x) : null);
const listLength = (n) => Math.max(1, Math.min(50, int(n || TOP_N)));

/** The all-time list as the server last gave it to this page; filled once, by GET or by a submit. */
let topCache = null; // { key, rows: Promise<object[]|null> }

/** Forget the list kept in memory (tests only: a page load starts with nothing kept). */
export function forgetTop() {
  topCache = null;
}

/** A shared list as sent, made safe to draw; null when it is not a list. */
function cleanTop(out, n) {
  if (!Array.isArray(out)) return null;
  return out.map(cleanTopRow).filter(Boolean).slice(0, n);
}

/**
 * Sends a finished run, once, in the background. The answer carries the updated all-time list,
 * which replaces the one kept in memory.
 * @param {object} run  the gameOver payload
 * @param {{base?: string, fetch?: Function, hostname?: string, storage?: Storage|null, name?: string,
 *   n?: number, timeout?: number, keepalive?: boolean}} [opts]
 * @returns {Promise<{rankAllTime: number|null, totalPlayers: number|null, top: object[]|null}|null>}
 *   null when the shared board is off, on this machine (localhost), or on any failure.
 */
export async function submitRun(run, opts = {}) {
  const base = opts.base === undefined ? LEADERBOARD_URL : opts.base;
  const hostname = opts.hostname === undefined ? globalThis.location && globalThis.location.hostname : opts.hostname;
  if (!sharedBoardOn(base) || isLocalHost(hostname)) return null;
  const n = listLength(opts.n);
  const body = submitBody(run, playerId(opts.storage), opts.name);
  // no headers: a text/plain body is a "simple" request, so no preflight; the Worker parses it as JSON
  const out = await request(`${base}${GAME_PATH}/submit?n=${n}`, {
    method: 'POST',
    body: JSON.stringify(body),
    keepalive: !!opts.keepalive,
  }, opts);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
  const top = cleanTop(out.top, n);
  if (top) topCache = { key: `${base}|${n}`, rows: Promise.resolve(top) };
  return { rankAllTime: rank(out.rankAllTime), totalPlayers: rank(out.totalPlayers), top };
}

/** One row of a shared board, made safe to draw. */
export function cleanTopRow(r) {
  if (!r || typeof r !== 'object') return null;
  const at = typeof r.at === 'number' ? r.at : typeof r.at === 'string' ? Date.parse(r.at) : NaN;
  return {
    name: cleanName(r.name) || ANONYMOUS,
    score: int(r.score),
    stations: int(r.stations),
    tickets: int(r.tickets),
    delivered: int(r.delivered),
    time: int(r.time),
    start: title(r.start) || '',
    lineFrom: title(r.lineFrom),
    lineTo: title(r.lineTo),
    at: Number.isFinite(at) ? at : null,
  };
}

/**
 * The best runs of all time, from everyone. Asked for at most once per page load: later calls
 * (and calls while the first is on its way) get the same answer, or the list a submit brought back.
 * A failed read is kept too, so it is not retried; the local board stays on screen instead.
 * @param {{base?: string, fetch?: Function, n?: number, timeout?: number}} [opts]
 * @returns {Promise<object[]|null>} rows best first, or null when the board is off or cannot be read
 */
export async function fetchTop(opts = {}) {
  const base = opts.base === undefined ? LEADERBOARD_URL : opts.base;
  if (!sharedBoardOn(base)) return null;
  const n = listLength(opts.n);
  const key = `${base}|${n}`;
  if (!topCache || topCache.key !== key) {
    topCache = { key, rows: request(`${base}${GAME_PATH}/top?n=${n}`, { method: 'GET' }, opts).then((out) => cleanTop(out, n)) };
  }
  return topCache.rows;
}
