// Pure helpers for the UI: formatting, sorting, filtering, quote summarising.
// No DOM, no imports from the game, so `node --test src/ui/*.test.js` can exercise them.

export const LINK_ROW_LIMIT = 30;

export function fmtInt(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const sgn = v < 0 ? '-' : '';
  return sgn + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Whole dollars with thousands separators: $1,234 or -$56. */
export function fmtMoney(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  return (v < 0 ? '-$' : '$') + fmtInt(Math.abs(v));
}

/** Signed whole dollars: +$87, -$12, $0. */
export function fmtSigned(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  return (v > 0 ? '+' : '') + fmtMoney(v);
}

/** A cost shown as money leaving: \u2212$11, or $0. */
export function fmtCost(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  return v > 0 ? '\u2212$' + fmtInt(v) : '$0';
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

/** The goal line's words: { text, progress ("3/5" only when target > 1), reward ("+$100"), how }. */
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

// ---------------------------------------------------------------- map status

const linkedCache = new WeakMap();
/** Every title that any built station links to (cached until a station is added). */
function linkedTitles(state) {
  const c = linkedCache.get(state);
  if (c && c.size === state.stations.size) return c.set;
  const set = new Set();
  for (const st of state.stations.values()) for (const t of (st.article && st.article.links) || []) set.add(t);
  linkedCache.set(state, { size: state.stations.size, set });
  return set;
}

/** 'built' | 'ghost' (one link from a built station) | 'absent' for any article title. */
export function mapStatus(title, state) {
  if (state.stations.has(title)) return 'built';
  if ((state.stubs && state.stubs.has(title)) || linkedTitles(state).has(title)) return 'ghost';
  return 'absent';
}

export function kindInfo(kind) {
  if (kind === 'list') return { label: 'List', premium: true };
  if (kind === 'disambiguation') return { label: 'Page of pointers', premium: true };
  return { label: 'Article', premium: false };
}

/** Why a page costs more, in plain words. '' for an ordinary article. */
export function premiumNote(kind, mult = 5) {
  const k = kindInfo(kind);
  if (!k.premium) return '';
  const x = `${mult}\u00d7`;
  return kind === 'list'
    ? `This page costs ${x} because it is a list`
    : `This page costs ${x} because it only points to other pages`;
}

// ---------------------------------------------------------------- thoughts

export function patienceFraction(t) {
  if (!(t.patienceMax > 0)) return 0;
  return Math.max(0, Math.min(1, t.patience / t.patienceMax));
}

export function patienceTone(frac) {
  return frac > 0.5 ? 'ok' : frac > 0.25 ? 'warn' : 'bad';
}

/** Most urgent first: least patience left, then oldest id. Returns a new array. */
export function sortThoughts(thoughts) {
  return thoughts.slice().sort((a, b) => (a.patience - b.patience) || (a.id - b.id));
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

/** The quiet line under a build price: "track $204 · station $131 · 2 bridges". */
export function quoteLine(s) {
  const parts = [`track ${fmtMoney(s.trackCost)}`];
  if (s.stationCost > 0) parts.push(`station ${fmtMoney(s.stationCost)}`);
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

// ---------------------------------------------------------------- passengers and reputation

/** 0 calm, 1 restless, 2 frantic; the same thresholds the 3D passengers use. */
export function passengerMood(frac) {
  return frac > 0.5 ? 0 : frac > 0.22 ? 1 : 2;
}

/** Whether the track network (level 1+, so a train runs) can carry a passenger between two stations. */
export function networkReachable(tracks, from, to) {
  if (from === to) return true;
  const next = new Map();
  for (const t of tracks || []) {
    if (!(t.level >= 1)) continue;
    if (!next.has(t.from)) next.set(t.from, new Set());
    if (!next.has(t.to)) next.set(t.to, new Set());
    next.get(t.from).add(t.to);
    next.get(t.to).add(t.from);
  }
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const n of next.get(queue.shift()) || []) {
      if (n === to) return true;
      if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  return false;
}

/**
 * What a passenger is thinking, in its own words. It names the real obstacle, so reading a
 * few passengers tells the player what the network is missing.
 * where: 'unknown' (no station links to the destination), 'ghost' (a station links to it, not built),
 *        'unlinked' (built, no running track gets there), 'served' (a running track gets there).
 */
export function thoughtLine({ to, state, mood, where, variant = 0 }) {
  const v = Math.abs(variant) % 2;
  if (state === 'riding') {
    return [
      [`On my way to ${to} at last.`, `${to}, here I come.`],
      [`Finally moving. ${to} had better be worth it.`, `Took a while, but we're rolling towards ${to}.`],
      [`About time! I nearly gave up on ${to}.`, `I'll get to ${to}, but I won't forget the wait.`],
    ][mood][v];
  }
  if (where === 'unknown') {
    return [
      [`I'd like to get to ${to}. It must be a link or two from here.`, `Does anything around here lead to ${to}?`],
      [`Nobody seems to know the way to ${to}.`, `Which of these links goes towards ${to}? Anyone?`],
      [`There isn't even a sign for ${to}! I'm giving up soon.`, `Nothing here even links to ${to}. This is hopeless.`],
    ][mood][v];
  }
  if (where === 'ghost') {
    return [
      [`One of our stations links to ${to}. Is the track coming?`, `${to} is one link away. It just needs a station.`],
      [`${to} is one link from here and nobody has built the track.`, `How long does it take to lay track to ${to}?`],
      [`Build the track to ${to} already! I can't wait much longer.`, `${to} is one link away and I'm still stuck here!`],
    ][mood][v];
  }
  if (where === 'unlinked') {
    return [
      [`There's a station at ${to}, but no train runs there from here.`, `${to} exists. I just can't get a train to it.`],
      [`Why does no train from here reach ${to}?`, `A station at ${to} and no service to it. Typical.`],
      [`Put a train on the track to ${to}! The station is sitting right there!`, `No train to ${to} at all? I'm about to walk.`],
    ][mood][v];
  }
  return [
    [`Waiting for my train to ${to}.`, `The train to ${to} should be along soon.`],
    [`Where is that train to ${to}?`, `This track to ${to} could use a faster train.`],
    [`I've been waiting ages for a train to ${to}!`, `One more minute and I'm forgetting ${to} entirely.`],
  ][mood][v];
}

/** Where a thought's destination stands for its passenger; see thoughtLine. */
export function destinationStatus(thought, state) {
  const status = mapStatus(thought.to, state);
  if (status === 'absent') return 'unknown';
  if (status !== 'built') return 'ghost';
  const here = thought.at || thought.from;
  return networkReachable(state.tracks, here, thought.to) ? 'served' : 'unlinked';
}

/** Reputation as the player sees it: a percentage, a word, and what it does to fares and crowds. */
export function reputationInfo(rep, econ) {
  const r = Math.max(0, Math.min(1, Number.isFinite(rep) ? rep : 0.5));
  const lerp = (a, b) => a + (b - a) * r;
  return {
    percent: Math.round(r * 100),
    word: r >= 0.8 ? 'Beloved' : r >= 0.6 ? 'Well liked' : r >= 0.4 ? 'Fair' : r >= 0.2 ? 'Poor' : 'Dreadful',
    tone: r >= 0.6 ? 'ok' : r >= 0.35 ? 'warn' : 'bad',
    fare: lerp(econ.reputationFareMin, econ.reputationFareMax),
    crowd: lerp(econ.reputationCrowdMin, econ.reputationCrowdMax),
  };
}

/** Passengers waiting at the platforms (riding ones are already on the way). */
export function waitingCount(thoughts) {
  let n = 0;
  for (const t of thoughts || []) if (t.state === 'waiting') n++;
  return n;
}

/** "12 passengers waiting". */
export function passengersLabel(n) {
  if (!(n > 0)) return 'No passengers waiting';
  return n === 1 ? '1 passenger waiting' : `${fmtInt(n)} passengers waiting`;
}

/**
 * The bonus the game pays the moment a station is built at `title`: `fraction` of the sum of the
 * current fares of the passengers waiting to go there. { count, amount }.
 */
export function waitingBonus(thoughts, title, fraction) {
  let count = 0;
  let sum = 0;
  for (const t of thoughts || []) {
    if (t.state !== 'waiting' || t.to !== title) continue;
    count++;
    sum += t.fare || 0;
  }
  return { count, amount: Math.round(sum * (fraction || 0)) };
}

/** "3 passengers waiting \u00b7 pays +$105 now", or '' when nobody is waiting. */
export function bonusLine(b) {
  if (!b || b.count <= 0) return '';
  return `${b.count === 1 ? '1 passenger' : `${fmtInt(b.count)} passengers`} waiting \u00b7 pays ${fmtSigned(b.amount)} now`;
}

/** What is missing when the player cannot yet afford a price: "$120 more gold needed". */
export function needMoreText(total, money) {
  return `${fmtMoney(Math.max(0, Math.ceil(total - money)))} more gold needed`;
}

// A passenger's one status, in words a new player understands.
export const QUEUE_STATUS = {
  riding: 'On the way',
  coming: 'Train coming',
  train: 'Needs a train',
  link: 'Build it: one link away',
  far: 'Not linked yet',
};

/** 'riding' | 'coming' | 'train' | 'link' | 'far' for a passenger (see QUEUE_STATUS). */
export function queueStatus(thought, state) {
  if (thought.state === 'riding') return 'riding';
  const d = destinationStatus(thought, state);
  return d === 'served' ? 'coming' : d === 'unlinked' ? 'train' : d === 'ghost' ? 'link' : 'far';
}
