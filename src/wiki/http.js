// Polite Action API client: concurrency limit, retry with backoff, timeouts, shared cool-down on 429.
// Works in browsers (anonymous CORS via origin=*) and in Node 24 (global fetch).

export const USER_AGENT = 'TrainOfThoughtGame/0.1 (browser game prototype)';

const RETRY_ERROR_CODES = new Set(['ratelimited', 'maxlag', 'readonly', 'internal_api_error_DBQueryError']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isNode() {
  return typeof process !== 'undefined' && !!process.versions && !!process.versions.node && typeof window === 'undefined';
}

/**
 * @param {{
 *   apiUrl: string, fetch?: typeof fetch, concurrency?: number, retries?: number,
 *   timeoutMs?: number, backoffMs?: number, maxRetryAfterMs?: number,
 *   sleep?: (ms:number)=>Promise<void>, userAgent?: string
 * }} options
 */
export function createClient(options) {
  const apiUrl = options.apiUrl;
  const fetchFn = options.fetch || globalThis.fetch.bind(globalThis);
  const concurrency = options.concurrency ?? 4;
  const retries = options.retries ?? 4;
  const timeoutMs = options.timeoutMs ?? 20000;
  const backoffMs = options.backoffMs ?? 600;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 90000;
  const sleep = options.sleep || defaultSleep;
  // A User-Agent header is only set in Node. In a browser it is forbidden, and any custom header would
  // trigger a CORS preflight.
  const headers = isNode() ? { 'User-Agent': options.userAgent || USER_AGENT, Accept: 'application/json' } : undefined;

  const stats = { requests: 0, attempts: 0, retries: 0 };
  let active = 0;
  const waiting = [];
  let cooldownUntil = 0; // set when the server tells us to slow down; everyone waits

  function acquire() {
    if (active < concurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  }
  function release() {
    const next = waiting.shift();
    if (next) next(); // slot passes straight to the next waiter
    else active--;
  }

  function buildUrl(params) {
    const q = new URLSearchParams();
    q.set('format', 'json');
    q.set('formatversion', '2');
    q.set('origin', '*');
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === false) continue;
      q.set(k, Array.isArray(v) ? v.join('|') : v === true ? '1' : String(v));
    }
    return `${apiUrl}?${q.toString()}`;
  }

  async function attempt(url) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) await sleep(wait);
    await acquire();
    stats.attempts++;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(url, { headers, signal: controller ? controller.signal : undefined });
      const retryAfter = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : 0) || 0;
      if (res.status === 429 || res.status >= 500) {
        const err = new Error(`HTTP ${res.status}`);
        err.retry = true;
        err.retryAfterMs = Math.min(maxRetryAfterMs, retryAfter * 1000);
        if (res.status === 429) cooldownUntil = Math.max(cooldownUntil, Date.now() + (err.retryAfterMs || 2000));
        throw err;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.retry = false;
        throw err;
      }
      let data;
      try {
        data = await res.json();
      } catch {
        const err = new Error('Invalid JSON from Wikipedia API');
        err.retry = true;
        throw err;
      }
      if (data && data.error) {
        const err = new Error(`Wikipedia API error: ${data.error.code}: ${data.error.info}`);
        err.code = data.error.code;
        err.retry = RETRY_ERROR_CODES.has(data.error.code);
        throw err;
      }
      return data;
    } catch (e) {
      if (e && e.retry === undefined) e.retry = true; // network error, abort/timeout
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  }

  /** GET an Action API query; resolves to the parsed JSON body. */
  async function get(params) {
    const url = buildUrl(params);
    stats.requests++;
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        return await attempt(url);
      } catch (e) {
        lastErr = e;
        if (!e.retry || i === retries) break;
        stats.retries++;
        const backoff = backoffMs * 2 ** i * (0.75 + Math.random() * 0.5);
        await sleep(Math.max(backoff, e.retryAfterMs || 0));
      }
    }
    throw lastErr;
  }

  /** Follow `continue` until exhausted (or maxPages). Calls onPage(body) for each response. */
  async function getAll(params, onPage, maxPages = 12) {
    let cont = {};
    for (let i = 0; i < maxPages; i++) {
      const body = await get({ ...params, ...cont });
      const stop = onPage(body) === false;
      if (stop || !body.continue) return;
      cont = body.continue;
    }
  }

  return { get, getAll, stats };
}
