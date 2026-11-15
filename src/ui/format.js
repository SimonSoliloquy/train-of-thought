// Pure helpers for the UI: formatting, sorting, filtering, quote summarising.
// No DOM, no imports from the game, so `node --test src/ui/*.test.js` can exercise them.

export const LINK_ROW_LIMIT = 30;

export function fmtInt(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const sgn = v < 0 ? '-' : '';
  return sgn + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Whole gold with thousands separators: "1,234 gold" or "-56 gold". */
export function fmtMoney(n) {
  return fmtInt(n) + ' gold';
}

/** Signed whole gold: "+87 gold", "-12 gold", "0 gold". */
export function fmtSigned(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  return (v > 0 ? '+' : '') + fmtMoney(v);
}

/** A cost shown as gold leaving: "\u221211 gold", or "0 gold". */
export function fmtCost(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  return v > 0 ? '\u2212' + fmtInt(v) + ' gold' : '0 gold';
}

/** "3m 12s" or "45s": time survived, for the game-over screen. */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const mm = Math.floor(s / 60);
  return mm > 0 ? `${mm}m ${s % 60}s` : `${s}s`;
}

export function fmtSeconds(sec) {
  return Math.max(0, Math.ceil(sec)) + 's';
}

// ---------------------------------------------------------------- payday and speed

/**
 * What the readout says about the next payday. `payday` is state.payday.
 * Returns { fraction (0..1 of the period elapsed), forecast, negative, text }.
 */
export function paydayView(payday) {
  const p = payday || {};
  const period = p.period > 0 ? p.period : 10;
  const inSec = Math.max(0, Math.min(period, Number.isFinite(p.in) ? p.in : period));
  const forecast = Math.round(Number.isFinite(p.forecast) ? p.forecast : 0);
  return {
    fraction: 1 - inSec / period,
    forecast,
    negative: forecast < 0,
    text: `${fmtSigned(forecast)} in ${Math.ceil(inSec)}s`,
  };
}

/** The payday that just landed (the 'payday' event): { amount, negative, headline, detail }. */
export function paydayBreakdown(e) {
  const p = e || {};
  const amount = Math.round(Number.isFinite(p.amount) ? p.amount : 0);
  return {
    amount,
    negative: amount < 0,
    headline: fmtSigned(amount),
    detail: `stations ${fmtSigned(p.income)} \u00b7 fares ${fmtSigned(p.fares)} \u00b7 costs ${fmtCost(p.upkeep)}`,
  };
}

/** While gold is negative the countdown replaces the payday text: { text, fraction (0..1 of the grace used) }. */
export function bankruptView(bankruptIn, grace = 30) {
  const left = Math.max(0, Number.isFinite(bankruptIn) ? bankruptIn : grace);
  return { text: `Bankrupt in ${fmtSeconds(left)}`, fraction: grace > 0 ? Math.max(0, Math.min(1, 1 - left / grace)) : 1 };
}

/** One button cycles 1x, 2x, 4x. From pause it resumes at the last running speed. */
export function nextSpeed(speed, lastRunning = 1) {
  if (!(speed > 0)) return lastRunning > 0 ? lastRunning : 1;
  return speed >= 4 ? 1 : speed >= 2 ? 4 : 2;
}

/** The speed button's label: "2\u00d7", or "Paused" plainly. */
export function speedLabel(speed) {
  return speed > 0 ? `${speed}\u00d7` : 'Paused';
}

// ---------------------------------------------------------------- the goal line

/** The goal line's words: { text, progress ("3/5" only when target > 1), reward ("+100 gold"), how }. */
export function goalView(goal) {
  if (!goal) return null;
  const target = Math.round(goal.target) || 0;
  const done = Math.max(0, Math.min(target, Math.round(goal.progress) || 0));
  return {
    text: String(goal.text || ''),
    progress: target > 1 ? `${fmtInt(done)}/${fmtInt(target)}` : '',
    reward: goal.reward > 0 ? fmtSigned(goal.reward) : '',
    how: String(goal.how || ''),
  };
}

/** Shown for a moment when a goal is met. */
export function goalDoneText(reward) {
  return reward > 0 ? `Done! ${fmtSigned(reward)}` : 'Done!';
}

// ---------------------------------------------------------------- urls

/** Only https images served from Wikimedia's own hosts (upload. and thumb.wikimedia.org) are allowed. */
export function safeThumb(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && (u.hostname === 'upload.wikimedia.org' || u.hostname === 'thumb.wikimedia.org')) return u.href;
  } catch { /* fall through */ }
  return null;
}

/** Only https links to Wikipedia itself are offered as "Read on Wikipedia". */
export function safeArticleUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && (u.hostname === 'wikipedia.org' || u.hostname.endsWith('.wikipedia.org'))) return u.href;
  } catch { /* fall through */ }
  return null;
}

// ---------------------------------------------------------------- station links

/**
 * Lead links first (marked lead: true), then the remaining links, filtered by a
 * case-insensitive substring. Returns at most `limit` rows plus the full match count.
 */
export function filterLinks(article, query, limit = LINK_ROW_LIMIT) {
  const lead = (article && article.leadLinks) || [];
  const all = (article && article.links) || [];
  const self = article && article.title;
  const leadSet = new Set(lead);
  const q = String(query || '').trim().toLowerCase();
  const match = (t) => t !== self && (!q || t.toLowerCase().includes(q));
  const rows = [];
  let total = 0;
  for (const t of lead) {
    if (!match(t)) continue;
    total++;
    if (rows.length < limit) rows.push({ title: t, lead: true });
  }
  for (const t of all) {
    if (leadSet.has(t) || !match(t)) continue;
    total++;
    if (rows.length < limit) rows.push({ title: t, lead: false });
  }
  return { rows, total };
}

/**
 * Built stations that could lay track to `target`: their article links to it, or (when
 * target is built too) target's article links to them. Stations already joined to a built
 * target are left out.
 */
export function buildSources(target, state, joined) {
  const out = [];
  const tStation = state.stations.get(target);
  const tLinks = tStation && tStation.article ? tStation.article.links || [] : [];
  for (const [title, st] of state.stations) {
    if (title === target) continue;
    const links = (st.article && st.article.links) || [];
    if (!(links.includes(target) || (tStation && tLinks.includes(title)))) continue;
    if (tStation && joined && joined(title, target)) continue;
    out.push(title);
  }
  return out;
}

/** Flatten a Quote into the numbers the build panel prints. */
export function summarizeQuote(q) {
  const hexes = (q.route && q.route.hexes) || [];
  const inner = hexes.length > 2 ? hexes.slice(1, -1) : [];
  const count = (k) => inner.filter((h) => h.kind === k).length;
  return {
    style: q.style,
    trackHexes: inner.length,
    ground: count('ground'),
    bridges: count('bridge'),
    tunnels: count('tunnel'),
    ledges: count('ledge'),
    trackCost: q.trackCost,
    stationCost: q.stationCost,
    total: q.total,
  };
}

/** "2 bridges, 1 tunnel" or "all ground": only the non-ground hexes worth mentioning. */
export function terrainText(s) {
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts = [];
  if (s.bridges) parts.push(plural(s.bridges, 'bridge'));
  if (s.tunnels) parts.push(plural(s.tunnels, 'tunnel'));
  if (s.ledges) parts.push(plural(s.ledges, 'ledge'));
  return parts.length ? parts.join(', ') : 'all ground';
}

export function quoteAffordable(q, money) {
  return q.total <= money;
}

/** Prices inflate continuously; requote once the multiplier has moved by `tol` (relative). */
export function needsRequote(lastInflation, inflation, tol = 0.02) {
  if (!(lastInflation > 0)) return true;
  return Math.abs(inflation - lastInflation) / lastInflation >= tol;
}

/** The quiet line under a build price: "track 204 \u00b7 station 131 \u00b7 2 bridges". */
export function quoteLine(s) {
  const parts = [`track ${fmtInt(s.trackCost)}`];
  if (s.stationCost > 0) parts.push(`station ${fmtInt(s.stationCost)}`);
  const terrain = terrainText(s);
  if (terrain !== 'all ground') parts.push(terrain);
  return parts.join(' \u00b7 ');
}

/**
 * Which of the player's stations to build from. The one they came from if it can reach the
 * target, else the one they were just looking at, else whichever quotes cheapest.
 * `totalOf(title)` returns that source's cheap total, or null when it cannot be quoted.
 */
export function chooseSource(sources, preferred, recent, totalOf) {
  if (!sources.length) return null;
  if (preferred && sources.includes(preferred)) return preferred;
  if (recent && sources.includes(recent)) return recent;
  let best = null, bestTotal = Infinity;
  for (const s of sources) {
    const t = totalOf(s);
    if (t != null && t < bestTotal) { best = s; bestTotal = t; }
  }
  return best || sources[0];
}

/** What is missing when the player cannot yet afford a price: "120 more gold needed". */
export function needMoreText(total, money) {
  return `${fmtInt(Math.max(0, Math.ceil(total - money)))} more gold needed`;
}

/**
 * The offer floated over the place being built towards (renderer.setBuildOffer).
 */
export function buildOffer({ title, quote, money, inflight, ticket }) {
  const short = !inflight && quote.total > money;
  let sub;
  // The offer never says whether this place is a ticket's destination: pricing every signpost
  // would otherwise find it without reading a word.
  void ticket;
  if (short) sub = needMoreText(quote.total, money);
  else sub = quoteLine(summarizeQuote(quote));
  return {
    title,
    label: inflight ? 'Building\u2026' : `Build \u00b7 ${fmtMoney(quote.total)}`,
    sub,
    affordable: !inflight && !short,
  };
}

// ---------------------------------------------------------------- tickets

/** "about 3 links away". */
export function ticketDistance(links) {
  const n = Math.max(1, Math.round(Number.isFinite(links) ? links : 1));
  return `about ${n} ${n === 1 ? 'link' : 'links'} away`;
}

/** Fraction of a ticket's time left (0..1), and its bar colour. */
export function ticketTimeFraction(t) {
  if (!(t.timeMax > 0)) return 0;
  return Math.max(0, Math.min(1, t.time / t.timeMax));
}

export function ticketTone(frac) {
  return frac > 0.5 ? 'ok' : frac > 0.25 ? 'warn' : 'bad';
}

/** The words of one ticket row. isBuilt(title) says whether the player has that station. */
export function ticketView(t, isBuilt) {
  const fromBuilt = !!isBuilt(t.from);
  const far = ticketDistance(t.links);
  const frac = ticketTimeFraction(t);
  return {
    route: `${t.from} \u2192 ${t.to}`,
    how: fromBuilt ? far : `${far} \u00b7 build both ends`,
    reward: fmtSigned(t.reward),
    fromBuilt,
    fraction: frac,
    tone: ticketTone(frac),
  };
}
