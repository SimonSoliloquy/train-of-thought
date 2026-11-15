// Pure helpers for the UI: formatting, sorting, filtering, quote summarising.
// No DOM, no imports from the game, so `node --test src/ui/` can exercise them.

export const LINK_ROW_LIMIT = 150;

export function fmtInt(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return v < 0 ? '-' + s : s;
}

/** Whole dollars with thousands separators: $1,234 or -$56. */
export function fmtMoney(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  return (v < 0 ? '-$' : '$') + fmtInt(Math.abs(v));
}

/** Rate per minute. signed adds a leading + for positive values. */
export function fmtRate(n, signed = false) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const plus = signed && v > 0 ? '+' : '';
  return plus + fmtMoney(v) + '/min';
}

export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

export function fmtMult(x) {
  return '×' + (Number.isFinite(x) ? x : 1).toFixed(2);
}

export function fmtSeconds(sec) {
  return Math.max(0, Math.ceil(sec)) + 's';
}

export function netPerMin(s) {
  return (s.incomePerMin || 0) + (s.faresPerMin || 0) - (s.upkeepPerMin || 0);
}

/** 0..1 progress toward the next milestone, or null when there is none. */
export function milestoneProgress(uniqueLinks, next) {
  if (!next || !(next.uniqueLinks > 0)) return null;
  return Math.max(0, Math.min(1, (uniqueLinks || 0) / next.uniqueLinks));
}

export function trainPrice(cost, inflation) {
  return Math.round(cost * (inflation >= 1 ? inflation : 1));
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

/** The article URL if it is https on *.wikipedia.org, else a link built from the title. */
export function safeWikiUrl(url, title) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && (u.hostname === 'wikipedia.org' || u.hostname.endsWith('.wikipedia.org'))) {
      return u.href;
    }
  } catch { /* fall through */ }
  return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(title).replace(/ /g, '_'));
}

// ---------------------------------------------------------------- map status

/** 'built' | 'ghost' | 'absent' for any article title. */
export function mapStatus(title, state) {
  if (state.stations.has(title)) return 'built';
  if (state.stubs && state.stubs.has(title)) return 'ghost';
  return 'absent';
}

export const STATUS_LABEL = { built: 'Built', ghost: 'On map', absent: 'Not on map' };

export function kindInfo(kind) {
  if (kind === 'list') return { label: 'List', premium: true };
  if (kind === 'disambiguation') return { label: 'Disambiguation page', premium: true };
  return { label: 'Article', premium: false };
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

export function pickDefaultSource(sources, preferred) {
  return sources.includes(preferred) ? preferred : sources.length ? sources[0] : null;
}

// ---------------------------------------------------------------- quotes

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

// ---------------------------------------------------------------- lines

/** Can `title` be appended to a line being drawn? */
export function canAppendStop(stops, title, state, trackBetween) {
  if (!state.stations.has(title)) return { ok: false, reason: 'Only built stations can be on a line.' };
  if (!stops.length) return { ok: true };
  const prev = stops[stops.length - 1];
  if (prev === title) return { ok: false, reason: `${title} is already the last stop.` };
  if (!trackBetween(prev, title)) {
    return { ok: false, reason: `No track joins ${prev} and ${title}. Build it first, or pick a station next to ${prev}.` };
  }
  return { ok: true };
}

export function chainText(stations, sep = ' → ') {
  return stations.join(sep);
}

// ---------------------------------------------------------------- first-run hints

/**
 * One short hint at a time until the player has built a station, made a line and bought a train.
 * Returns { stage, text } or null. `stage` is what a dismissal is remembered by.
 */
export function pickHint({ stations, lines, trains, selKind }) {
  if (stations <= 1) {
    if (selKind === 'station') {
      return { stage: 'build', text: 'Pick a link below. Lead links come first. Choose one to put it on the map, then build track to it.' };
    }
    if (selKind === 'ghost') {
      return { stage: 'build', text: 'Compare the cheap and direct routes, then press Build.' };
    }
    return { stage: 'build', text: 'Click your station to see where its links lead.' };
  }
  if (lines <= 0) {
    return { stage: 'line', text: 'Draw a line: press New line, click two joined stations in order, then Done.' };
  }
  if (trains <= 0) {
    return { stage: 'train', text: 'Buy a train for your line with the + buttons so thoughts can ride.' };
  }
  return null;
}

// ---------------------------------------------------------------- passengers and reputation

/** 0 calm, 1 restless, 2 frantic; the same thresholds the 3D passengers use. */
export function passengerMood(frac) {
  return frac > 0.5 ? 0 : frac > 0.22 ? 1 : 2;
}

/** Whether the line network can carry a passenger from one built station to another. */
export function networkReachable(lines, from, to) {
  if (from === to) return true;
  const next = new Map();
  for (const line of lines || []) {
    const st = line.stations || [];
    for (let i = 1; i < st.length; i++) {
      const a = st[i - 1], b = st[i];
      if (!next.has(a)) next.set(a, new Set());
      if (!next.has(b)) next.set(b, new Set());
      next.get(a).add(b);
      next.get(b).add(a);
    }
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
 * where: 'unknown' (destination not on the map), 'ghost' (on the map, not built),
 *        'unlinked' (built, no line gets there), 'served' (a line gets there).
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
      [`There isn't even a sign for ${to}! I'm giving up soon.`, `${to} isn't on any map here. This is hopeless.`],
    ][mood][v];
  }
  if (where === 'ghost') {
    return [
      [`${to} is right there on the map. Is the track coming?`, `I can see where ${to} will be. Just needs a station.`],
      [`They've surveyed ${to} but nobody has built the track.`, `How long does it take to lay track to ${to}?`],
      [`Build the track to ${to} already! I can't wait much longer.`, `${to} is on the map and I'm still stuck here!`],
    ][mood][v];
  }
  if (where === 'unlinked') {
    return [
      [`There's a station at ${to}, but no line runs there from here.`, `${to} exists. I just can't get a train to it.`],
      [`Why does no line from here reach ${to}?`, `A station at ${to} and no service to it. Typical.`],
      [`Draw a line to ${to}! The station is sitting right there!`, `No train to ${to} at all? I'm about to walk.`],
    ][mood][v];
  }
  return [
    [`Waiting for my train to ${to}.`, `The train to ${to} should be along soon.`],
    [`Where is that train to ${to}?`, `This line to ${to} could use another train.`],
    [`I've been waiting ages for a train to ${to}!`, `One more minute and I'm forgetting ${to} entirely.`],
  ][mood][v];
}

/** Where a thought's destination stands for its passenger; see thoughtLine. */
export function destinationStatus(thought, state) {
  const status = mapStatus(thought.to, state);
  if (status === 'absent') return 'unknown';
  if (status !== 'built') return 'ghost';
  const here = thought.at || thought.from;
  return networkReachable(state.lines, here, thought.to) ? 'served' : 'unlinked';
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
