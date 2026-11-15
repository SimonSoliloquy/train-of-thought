// The shared boards: every player's finished runs, kept by a small public Cloudflare Worker
// (shared with other games; this game only ever calls its /train-of-thought/ routes). No keys,
// no account: a run carries a random player id kept in this browser and an optional name.
// Every call times out and resolves to null on any failure, so the game never waits on it.

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

/**
 * Sends a finished run, once, in the background.
 * @param {object} run  the gameOver payload
 * @param {{base?: string, fetch?: Function, hostname?: string, storage?: Storage|null, name?: string,
 *   timeout?: number, keepalive?: boolean}} [opts]
 * @returns {Promise<{rankAllTime: number|null, rankDaily: number|null, totalPlayers: number|null}|null>}
 *   null when the shared board is off, on this machine (localhost), or on any failure.
 */
export async function submitRun(run, opts = {}) {
  const base = opts.base === undefined ? LEADERBOARD_URL : opts.base;
  const hostname = opts.hostname === undefined ? globalThis.location && globalThis.location.hostname : opts.hostname;
  if (!sharedBoardOn(base) || isLocalHost(hostname)) return null;
  const body = submitBody(run, playerId(opts.storage), opts.name);
  const out = await request(`${base}${GAME_PATH}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: !!opts.keepalive,
  }, opts);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
  return { rankAllTime: rank(out.rankAllTime), rankDaily: rank(out.rankDaily), totalPlayers: rank(out.totalPlayers) };
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
 * The best runs everywhere, today (UTC, as the server counts days) or of all time.
 * @param {'daily'|'alltime'} scope
 * @param {{base?: string, fetch?: Function, n?: number, timeout?: number}} [opts]
 * @returns {Promise<object[]|null>} rows best first, or null when the board is off or cannot be read
 */
export async function fetchTop(scope, opts = {}) {
  const base = opts.base === undefined ? LEADERBOARD_URL : opts.base;
  if (!sharedBoardOn(base) || (scope !== 'daily' && scope !== 'alltime')) return null;
  const n = Math.max(1, Math.min(50, int(opts.n || TOP_N)));
  const out = await request(`${base}${GAME_PATH}/top?scope=${scope}&n=${n}`, { method: 'GET' }, opts);
  if (!Array.isArray(out)) return null;
  return out.map(cleanTopRow).filter(Boolean).slice(0, n);
}
