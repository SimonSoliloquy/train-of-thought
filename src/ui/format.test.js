import test from 'node:test';
import assert from 'node:assert/strict';
import * as f from './format.js';

test('money, signed amounts and costs', () => {
  assert.equal(f.fmtMoney(1234567.4), '$1,234,567');
  assert.equal(f.fmtMoney(-56.6), '-$57');
  assert.equal(f.fmtMoney(-0.2), '$0');
  assert.equal(f.fmtMoney(NaN), '$0');
  assert.equal(f.fmtSigned(87.2), '+$87');
  assert.equal(f.fmtSigned(-12), '-$12');
  assert.equal(f.fmtSigned(0), '$0');
  assert.equal(f.fmtCost(11), '\u2212$11');
  assert.equal(f.fmtCost(0), '$0');
  assert.equal(f.fmtInt(-1234), '-1,234');
});

test('durations and countdowns', () => {
  assert.equal(f.fmtDuration(0), '0s');
  assert.equal(f.fmtDuration(45.9), '45s');
  assert.equal(f.fmtDuration(192), '3m 12s');
  assert.equal(f.fmtSeconds(11.2), '12s');
  assert.equal(f.fmtSeconds(-1), '0s');
});

test('paydayView: forecast text and bar fraction', () => {
  const v = f.paydayView({ period: 10, in: 6, forecast: 87.4 });
  assert.equal(v.text, '+$87 in 6s');
  assert.ok(Math.abs(v.fraction - 0.4) < 1e-9);
  assert.equal(v.negative, false);
  const n = f.paydayView({ period: 10, in: 0.2, forecast: -15 });
  assert.equal(n.text, '-$15 in 1s');
  assert.equal(n.negative, true);
  assert.equal(f.paydayView(undefined).text, '$0 in 10s');
  assert.equal(f.paydayView({ period: 10, in: 25, forecast: 0 }).fraction, 0);
});

test('paydayBreakdown: the amount and where it came from', () => {
  const b = f.paydayBreakdown({ amount: 87, income: 3, fares: 95, upkeep: 11 });
  assert.equal(b.headline, '+$87');
  assert.equal(b.negative, false);
  assert.equal(b.detail, 'stations +$3 \u00b7 fares +$95 \u00b7 costs \u2212$11');
  const n = f.paydayBreakdown({ amount: -20, income: 0, fares: 0, upkeep: 20 });
  assert.equal(n.negative, true);
  assert.equal(n.headline, '-$20');
  assert.equal(f.paydayBreakdown(undefined).headline, '$0');
});

test('bankruptcy countdown replaces the payday text', () => {
  const v = f.bankruptView(22.2, 30);
  assert.equal(v.text, 'Bankrupt in 23s');
  assert.ok(Math.abs(v.fraction - (1 - 22.2 / 30)) < 1e-9);
  assert.equal(f.bankruptView(0, 30).fraction, 1);
  assert.equal(f.bankruptView(99, 30).fraction, 0);
});

test('nextSpeed cycles 1x 2x 4x and resumes from pause', () => {
  assert.equal(f.nextSpeed(1), 2);
  assert.equal(f.nextSpeed(2), 4);
  assert.equal(f.nextSpeed(4), 1);
  assert.equal(f.nextSpeed(0, 2), 2);
  assert.equal(f.nextSpeed(0, 0), 1);
});

test('speed label says Paused plainly', () => {
  assert.equal(f.speedLabel(2), '2\u00d7');
  assert.equal(f.speedLabel(0), 'Paused');
});

test('goalView: text, progress only when target > 1, reward, how', () => {
  const g = f.goalView({ text: 'Deliver 5 passengers', how: 'Click the price tag on a track', progress: 3, target: 5, reward: 100 });
  assert.deepEqual(g, { text: 'Deliver 5 passengers', progress: '3/5', reward: '+$100', how: 'Click the price tag on a track' });
  assert.equal(f.goalView({ text: 'Build a station', progress: 0, target: 1, reward: 100 }).progress, '');
  assert.equal(f.goalView({ text: 'x', progress: 9, target: 5, reward: 0 }).progress, '5/5');
  assert.equal(f.goalView({ text: 'x', progress: 9, target: 5, reward: 0 }).reward, '');
  assert.equal(f.goalView(null), null);
  assert.equal(f.goalDoneText(100), 'Done! +$100');
  assert.equal(f.goalDoneText(0), 'Done!');
});

test('thumbnail urls are restricted to Wikimedia https hosts', () => {
  assert.equal(f.safeThumb('https://upload.wikimedia.org/a/b.jpg'), 'https://upload.wikimedia.org/a/b.jpg');
  assert.equal(f.safeThumb('https://thumb.wikimedia.org/a/b.jpg'), 'https://thumb.wikimedia.org/a/b.jpg');
  assert.equal(f.safeThumb('http://upload.wikimedia.org/a/b.jpg'), null);
  assert.equal(f.safeThumb('https://evil.example/upload.wikimedia.org/x.jpg'), null);
  assert.equal(f.safeThumb('https://upload.wikimedia.org.evil.example/x.jpg'), null);
  assert.equal(f.safeThumb('javascript:alert(1)'), null);
  assert.equal(f.safeThumb(null), null);
});

const state = () => ({
  stations: new Map([['A', { article: { links: ['B', 'C', 'A2'] } }], ['B', { article: { links: ['A'] } }], ['D', { article: { links: [] } }]]),
  stubs: new Map([['A', {}], ['B', {}], ['D', {}], ['C', {}]]),
});

test('map status: built, one link away, not linked', () => {
  const s = state();
  assert.equal(f.mapStatus('A', s), 'built');
  assert.equal(f.mapStatus('C', s), 'ghost');
  assert.equal(f.mapStatus('A2', s), 'ghost'); // linked by A though never surveyed
  assert.equal(f.mapStatus('Z', s), 'absent');
  s.stations.set('E', { article: { links: ['Z'] } });
  assert.equal(f.mapStatus('Z', s), 'ghost'); // cache follows new stations
});

test('premium pages say why they cost more, in plain words', () => {
  assert.equal(f.kindInfo('list').premium, true);
  assert.equal(f.kindInfo('disambiguation').premium, true);
  assert.equal(f.kindInfo('article').premium, false);
  assert.equal(f.premiumNote('list', 5), 'This page costs 5\u00d7 because it is a list');
  assert.equal(f.premiumNote('disambiguation', 5), 'This page costs 5\u00d7 because it only points to other pages');
  assert.equal(f.premiumNote('article', 5), '');
  assert.ok(!/disambiguation/i.test(f.premiumNote('disambiguation', 5)));
});

test('thoughts sort by urgency', () => {
  const t = [{ id: 1, patience: 50 }, { id: 2, patience: 10 }, { id: 3, patience: 10 }, { id: 4, patience: 90 }];
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
  assert.deepEqual(f.filterLinks(art, '  AP ').rows.map((r) => r.title), ['Apple', 'Apricot']);
  const lim = f.filterLinks(art, '', 3);
  assert.equal(lim.rows.length, 3);
  assert.equal(lim.total, 5);
  const big = { title: 'X', leadLinks: [], links: Array.from({ length: 1500 }, (_, i) => 'T' + i) };
  assert.equal(f.filterLinks(big, '').rows.length, f.LINK_ROW_LIMIT);
  assert.equal(f.filterLinks(big, '').total, 1500);
  assert.equal(f.filterLinks(big, 't14').total, 111);
  assert.equal(f.filterLinks({ title: 'X' }, '').total, 0);
});

test('buildSources', () => {
  const s = state();
  assert.deepEqual(f.buildSources('C', s, () => false), ['A']);
  assert.deepEqual(f.buildSources('B', s, () => false), ['A']);
  assert.deepEqual(f.buildSources('B', s, (a) => a === 'A'), []);
});

test('chooseSource: came from, else just viewed, else cheapest', () => {
  const total = { X: 300, Y: 120, Z: null };
  const of = (t) => total[t];
  assert.equal(f.chooseSource(['X', 'Y'], 'X', 'Y', of), 'X');
  assert.equal(f.chooseSource(['X', 'Y'], 'Q', 'X', of), 'X');
  assert.equal(f.chooseSource(['X', 'Y', 'Z'], null, null, of), 'Y');
  assert.equal(f.chooseSource(['Z'], null, null, of), 'Z');
  assert.equal(f.chooseSource([], 'X', 'Y', of), null);
});

test('summarizeQuote, terrainText and the quiet price line', () => {
  const kinds = ['ground', 'ground', 'bridge', 'tunnel', 'ledge', 'bridge', 'ground'];
  const q = { style: 'cheap', trackCost: 204, stationCost: 131, total: 335, route: { hexes: kinds.map((kind, i) => ({ q: i, r: 0, kind })) } };
  const s = f.summarizeQuote(q);
  assert.equal(s.trackHexes, 5);
  assert.equal(s.bridges, 2);
  assert.equal(s.tunnels, 1);
  assert.equal(s.ledges, 1);
  assert.equal(f.quoteLine(s), 'track $204 \u00b7 station $131 \u00b7 2 bridges, 1 tunnel, 1 ledge');
  assert.equal(f.quoteLine({ trackCost: 50, stationCost: 0, bridges: 0, tunnels: 0, ledges: 0 }), 'track $50');
  assert.equal(f.terrainText({ bridges: 0, tunnels: 0, ledges: 0 }), 'all ground');
  assert.equal(f.quoteAffordable(q, 334), false);
  assert.equal(f.quoteAffordable(q, 335), true);
  assert.equal(f.summarizeQuote({ style: 'cheap', route: { hexes: [] }, total: 0 }).trackHexes, 0);
});

test('needsRequote', () => {
  assert.equal(f.needsRequote(1, 1.01), false);
  assert.equal(f.needsRequote(1, 1.02), true);
  assert.equal(f.needsRequote(0, 1), true);
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
  assert.match(f.thoughtLine({ to: 'X', state: 'waiting', mood: 1, where: 'unlinked' }), /train|service/i);
});

test('networkReachable follows running tracks (level 1+) in both directions and across transfers', () => {
  const tracks = [
    { from: 'A', to: 'B', level: 1 }, { from: 'B', to: 'C', level: 2 }, { from: 'C', to: 'D', level: 3 },
    { from: 'D', to: 'E', level: 0 }, { from: 'X', to: 'Y', level: 1 },
  ];
  assert.equal(f.networkReachable(tracks, 'A', 'A'), true);
  assert.equal(f.networkReachable(tracks, 'A', 'D'), true);
  assert.equal(f.networkReachable(tracks, 'D', 'A'), true);
  assert.equal(f.networkReachable(tracks, 'A', 'E'), false); // bare track has no train
  assert.equal(f.networkReachable(tracks, 'A', 'Y'), false);
  assert.equal(f.networkReachable([], 'A', 'B'), false);
});

test('destinationStatus tells unknown, ghost, unlinked and served apart', () => {
  const state = {
    stations: new Map([['A', { article: { links: ['G'] } }], ['B', { article: { links: [] } }], ['C', { article: { links: [] } }]]),
    stubs: new Map(),
    tracks: [{ from: 'A', to: 'B', level: 1 }],
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

test('passengers label and the route bonus', () => {
  assert.equal(f.passengersLabel(0), 'No passengers waiting');
  assert.equal(f.passengersLabel(1), '1 passenger waiting');
  assert.equal(f.passengersLabel(12), '12 passengers waiting');
  const ts = [
    { state: 'waiting', to: 'X', fare: 100 }, { state: 'waiting', to: 'X', fare: 110 },
    { state: 'waiting', to: 'Y', fare: 500 }, { state: 'riding', to: 'X', fare: 999 }, { state: 'waiting', to: 'X', fare: 0.4 },
  ];
  assert.equal(f.waitingCount(ts), 4);
  const b = f.waitingBonus(ts, 'X', 0.5);
  assert.deepEqual(b, { count: 3, amount: 105 });
  assert.equal(f.bonusLine(b), '3 passengers waiting \u00b7 pays +$105 now');
  assert.equal(f.bonusLine(f.waitingBonus(ts, 'Y', 0.5)), '1 passenger waiting \u00b7 pays +$250 now');
  assert.equal(f.bonusLine(f.waitingBonus(ts, 'Z', 0.5)), '');
  assert.equal(f.needMoreText(335, 215), '$120 more gold needed');
  assert.equal(f.needMoreText(335, 214.5), '$121 more gold needed');
});

test('queue status words', () => {
  const state = {
    stations: new Map([['A', { article: { links: ['G'] } }], ['B', { article: { links: [] } }], ['C', { article: { links: [] } }]]),
    stubs: new Map(),
    tracks: [{ from: 'A', to: 'B', level: 1 }],
  };
  const th = (to, extra) => ({ from: 'A', at: 'A', to, state: 'waiting', ...extra });
  assert.equal(f.queueStatus(th('B', { state: 'riding', at: null }), state), 'riding');
  assert.equal(f.queueStatus(th('B'), state), 'coming');
  assert.equal(f.queueStatus(th('C'), state), 'train');
  assert.equal(f.queueStatus(th('G'), state), 'link');
  assert.equal(f.queueStatus(th('Nowhere'), state), 'far');
  assert.deepEqual(Object.values(f.QUEUE_STATUS), ['On the way', 'Train coming', 'Needs a train', 'Build it: one link away', 'Not linked yet']);
});
