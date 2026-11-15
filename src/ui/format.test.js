import test from 'node:test';
import assert from 'node:assert/strict';
import * as f from './format.js';

test('money and rates', () => {
  assert.equal(f.fmtMoney(1234567.4), '$1,234,567');
  assert.equal(f.fmtMoney(-56.6), '-$57');
  assert.equal(f.fmtMoney(-0.2), '$0');
  assert.equal(f.fmtMoney(NaN), '$0');
  assert.equal(f.fmtRate(12.4, true), '+$12/min');
  assert.equal(f.fmtRate(-3000, true), '-$3,000/min');
  assert.equal(f.fmtRate(0, true), '$0/min');
  assert.equal(f.fmtRate(5), '$5/min');
});

test('clock, multiplier, countdown', () => {
  assert.equal(f.fmtClock(0), '00:00');
  assert.equal(f.fmtClock(75.9), '01:15');
  assert.equal(f.fmtClock(3725), '62:05');
  assert.equal(f.fmtMult(1), '×1.00');
  assert.equal(f.fmtMult(1.234), '×1.23');
  assert.equal(f.fmtSeconds(11.2), '12s');
  assert.equal(f.fmtSeconds(-1), '0s');
});

test('net per minute and milestone progress', () => {
  assert.equal(f.netPerMin({ incomePerMin: 10, faresPerMin: 30, upkeepPerMin: 50 }), -10);
  assert.equal(f.milestoneProgress(100, { uniqueLinks: 400 }), 0.25);
  assert.equal(f.milestoneProgress(900, { uniqueLinks: 400 }), 1);
  assert.equal(f.milestoneProgress(5, null), null);
});

test('train price inflates', () => {
  assert.equal(f.trainPrice(120, 1), 120);
  assert.equal(f.trainPrice(120, 1.5), 180);
  assert.equal(f.trainPrice(120, 0.5), 120);
});

test('thumbnail and wiki urls are restricted', () => {
  assert.equal(f.safeThumb('https://upload.wikimedia.org/a/b.jpg'), 'https://upload.wikimedia.org/a/b.jpg');
  assert.equal(f.safeThumb('https://thumb.wikimedia.org/a/b.jpg?x=1'), 'https://thumb.wikimedia.org/a/b.jpg?x=1');
  assert.equal(f.safeThumb('http://upload.wikimedia.org/a/b.jpg'), null);
  assert.equal(f.safeThumb('https://evil.example/upload.wikimedia.org/x.jpg'), null);
  assert.equal(f.safeThumb('https://upload.wikimedia.org.evil.example/x.jpg'), null);
  assert.equal(f.safeThumb('javascript:alert(1)'), null);
  assert.equal(f.safeThumb(null), null);
  assert.equal(f.safeWikiUrl('https://en.wikipedia.org/wiki/Rail_transport', 'Rail transport'), 'https://en.wikipedia.org/wiki/Rail_transport');
  assert.equal(f.safeWikiUrl('javascript:alert(1)', 'A b'), 'https://en.wikipedia.org/wiki/A_b');
  assert.equal(f.safeWikiUrl('https://evilwikipedia.org/x', 'A'), 'https://en.wikipedia.org/wiki/A');
});

const state = () => ({
  stations: new Map([['A', { article: { links: ['B', 'C', 'A2'] } }], ['B', { article: { links: ['A'] } }], ['D', { article: { links: [] } }]]),
  stubs: new Map([['A', {}], ['B', {}], ['D', {}], ['C', {}]]),
});

test('map status', () => {
  const s = state();
  assert.equal(f.mapStatus('A', s), 'built');
  assert.equal(f.mapStatus('C', s), 'ghost');
  assert.equal(f.mapStatus('Z', s), 'absent');
  assert.equal(f.STATUS_LABEL.absent, 'Not on map');
});

test('kind info flags premium pages', () => {
  assert.equal(f.kindInfo('list').premium, true);
  assert.equal(f.kindInfo('disambiguation').premium, true);
  assert.equal(f.kindInfo('article').premium, false);
});

test('thoughts sort by urgency', () => {
  const t = [
    { id: 1, patience: 50 }, { id: 2, patience: 10 }, { id: 3, patience: 10 }, { id: 4, patience: 90 },
  ];
  assert.deepEqual(f.sortThoughts(t).map((x) => x.id), [2, 3, 1, 4]);
  assert.deepEqual(t.map((x) => x.id), [1, 2, 3, 4]);
  assert.equal(f.patienceFraction({ patience: 30, patienceMax: 60 }), 0.5);
  assert.equal(f.patienceFraction({ patience: -5, patienceMax: 60 }), 0);
  assert.equal(f.patienceTone(0.8), 'ok');
  assert.equal(f.patienceTone(0.3), 'warn');
  assert.equal(f.patienceTone(0.1), 'bad');
});

test('filterLinks: lead first, filter, limit, no duplicates', () => {
  const art = { title: 'Self', leadLinks: ['Zebra', 'Apple'], links: ['Apple', 'Banana', 'Zebra', 'Self', 'Apricot', 'Cherry'] };
  const all = f.filterLinks(art, '');
  assert.deepEqual(all.rows.map((r) => r.title), ['Zebra', 'Apple', 'Banana', 'Apricot', 'Cherry']);
  assert.deepEqual(all.rows.map((r) => r.lead), [true, true, false, false, false]);
  assert.equal(all.total, 5);
  const ap = f.filterLinks(art, '  AP ');
  assert.deepEqual(ap.rows.map((r) => r.title), ['Apple', 'Apricot']);
  const lim = f.filterLinks(art, '', 3);
  assert.equal(lim.rows.length, 3);
  assert.equal(lim.total, 5);
  const big = { title: 'X', leadLinks: [], links: Array.from({ length: 1500 }, (_, i) => 'T' + i) };
  const r = f.filterLinks(big, '');
  assert.equal(r.rows.length, f.LINK_ROW_LIMIT);
  assert.equal(r.total, 1500);
  assert.equal(f.filterLinks(big, 't14').total, 111);
  assert.equal(f.filterLinks({ title: 'X' }, '').total, 0);
});

test('buildSources and default', () => {
  const s = state();
  // ghost C is linked from A only
  assert.deepEqual(f.buildSources('C', s, () => false), ['A']);
  // built B: A links to B, B links to A; D links nothing
  assert.deepEqual(f.buildSources('B', s, () => false), ['A']);
  assert.deepEqual(f.buildSources('B', s, (a, b) => a === 'A'), []);
  assert.equal(f.pickDefaultSource(['X', 'Y'], 'Y'), 'Y');
  assert.equal(f.pickDefaultSource(['X', 'Y'], 'Q'), 'X');
  assert.equal(f.pickDefaultSource([], 'Q'), null);
});

test('summarizeQuote counts interior hex kinds', () => {
  const kinds = ['ground', 'ground', 'bridge', 'tunnel', 'ledge', 'bridge', 'ground'];
  const q = {
    style: 'direct', trackCost: 100, stationCost: 50, total: 150, affordable: true,
    route: { hexes: kinds.map((kind, i) => ({ q: i, r: 0, kind })) },
  };
  const s = f.summarizeQuote(q);
  assert.equal(s.trackHexes, 5);
  assert.equal(s.bridges, 2);
  assert.equal(s.tunnels, 1);
  assert.equal(s.ledges, 1);
  assert.equal(s.ground, 1);
  assert.equal(s.total, 150);
  assert.equal(f.quoteAffordable(q, 149), false);
  assert.equal(f.quoteAffordable(q, 150), true);
  assert.equal(f.summarizeQuote({ style: 'cheap', route: { hexes: [] }, total: 0 }).trackHexes, 0);
});

test('needsRequote', () => {
  assert.equal(f.needsRequote(1, 1.01), false);
  assert.equal(f.needsRequote(1, 1.02), true);
  assert.equal(f.needsRequote(0, 1), true);
});

test('canAppendStop', () => {
  const s = state();
  const tb = (a, b) => (a === 'A' && b === 'B') || (a === 'B' && b === 'A');
  assert.equal(f.canAppendStop([], 'A', s, tb).ok, true);
  assert.equal(f.canAppendStop([], 'C', s, tb).ok, false);
  assert.equal(f.canAppendStop(['A'], 'B', s, tb).ok, true);
  assert.equal(f.canAppendStop(['A'], 'A', s, tb).ok, false);
  const r = f.canAppendStop(['A'], 'D', s, tb);
  assert.equal(r.ok, false);
  assert.match(r.reason, /No track joins A and D/);
  assert.equal(f.chainText(['A', 'B']), 'A → B');
});

test('hints walk the first run', () => {
  assert.match(f.pickHint({ stations: 1, lines: 0, trains: 0, selKind: null }).text, /Click your station/);
  assert.equal(f.pickHint({ stations: 1, lines: 0, trains: 0, selKind: 'station' }).stage, 'build');
  assert.equal(f.pickHint({ stations: 1, lines: 0, trains: 0, selKind: 'ghost' }).stage, 'build');
  assert.equal(f.pickHint({ stations: 2, lines: 0, trains: 0 }).stage, 'line');
  assert.equal(f.pickHint({ stations: 2, lines: 1, trains: 0 }).stage, 'train');
  assert.equal(f.pickHint({ stations: 2, lines: 1, trains: 1 }), null);
});

test('terrainText', () => {
  assert.equal(f.terrainText({ bridges: 0, tunnels: 0, ledges: 0 }), 'all ground');
  assert.equal(f.terrainText({ bridges: 1, tunnels: 2, ledges: 0 }), '1 bridge, 2 tunnels');
  assert.equal(f.terrainText({ bridges: 0, tunnels: 0, ledges: 3 }), '3 ledges');
});

test('passenger thoughts name the real obstacle and get angrier', () => {
  assert.equal(f.passengerMood(0.9), 0);
  assert.equal(f.passengerMood(0.4), 1);
  assert.equal(f.passengerMood(0.1), 2);
  const seen = new Set();
  for (const state of ['waiting', 'riding']) {
    for (const where of ['unknown', 'ghost', 'unlinked', 'served']) {
      for (const mood of [0, 1, 2]) {
        for (const variant of [0, 1, 7]) {
          const line = f.thoughtLine({ to: 'Theatre', state, mood, where, variant });
          assert.equal(typeof line, 'string');
          assert.ok(line.includes('Theatre'), line);
          seen.add(line);
        }
      }
    }
  }
  assert.ok(seen.size >= 24 + 6, 'each situation and mood has its own wording');
  assert.match(f.thoughtLine({ to: 'X', state: 'waiting', mood: 2, where: 'ghost' }), /track/i);
  assert.match(f.thoughtLine({ to: 'X', state: 'waiting', mood: 1, where: 'unlinked' }), /line|service/i);
});

test('networkReachable follows lines in both directions and across transfers', () => {
  const lines = [{ stations: ['A', 'B', 'C'] }, { stations: ['C', 'D'] }, { stations: ['X', 'Y'] }];
  assert.equal(f.networkReachable(lines, 'A', 'A'), true);
  assert.equal(f.networkReachable(lines, 'A', 'C'), true);
  assert.equal(f.networkReachable(lines, 'D', 'A'), true);
  assert.equal(f.networkReachable(lines, 'A', 'Y'), false);
  assert.equal(f.networkReachable([], 'A', 'B'), false);
});

test('destinationStatus tells unknown, ghost, unlinked and served apart', () => {
  const state = {
    stations: new Map([['A', {}], ['B', {}], ['C', {}]]),
    stubs: new Map([['A', {}], ['B', {}], ['C', {}], ['G', {}]]),
    lines: [{ stations: ['A', 'B'] }],
  };
  const th = (to) => ({ from: 'A', at: 'A', to });
  assert.equal(f.destinationStatus(th('Nowhere'), state), 'unknown');
  assert.equal(f.destinationStatus(th('G'), state), 'ghost');
  assert.equal(f.destinationStatus(th('C'), state), 'unlinked');
  assert.equal(f.destinationStatus(th('B'), state), 'served');
});

test('reputationInfo reports a percentage, a word and its effects', () => {
  const econ = { reputationFareMin: 0.7, reputationFareMax: 1.3, reputationCrowdMin: 0.7, reputationCrowdMax: 1.3 };
  const mid = f.reputationInfo(0.5, econ);
  assert.equal(mid.percent, 50);
  assert.ok(Math.abs(mid.fare - 1) < 1e-9 && Math.abs(mid.crowd - 1) < 1e-9);
  assert.equal(f.reputationInfo(0, econ).fare, 0.7);
  assert.equal(f.reputationInfo(1, econ).crowd, 1.3);
  assert.equal(f.reputationInfo(0.1, econ).tone, 'bad');
  assert.equal(f.reputationInfo(0.9, econ).tone, 'ok');
  assert.equal(f.reputationInfo(undefined, econ).percent, 50);
  assert.equal(f.reputationInfo(7, econ).percent, 100);
});
