import test from 'node:test';
import assert from 'node:assert/strict';
import * as f from './format.js';

test('money, signed amounts and costs', () => {
  assert.equal(f.fmtMoney(1234567.4), '1,234,567 gold');
  assert.equal(f.fmtMoney(1000), '1,000 gold');
  assert.equal(f.fmtMoney(-56.6), '-57 gold');
  assert.equal(f.fmtMoney(NaN), '0 gold');
  assert.equal(f.fmtSigned(87.2), '+87 gold');
  assert.equal(f.fmtSigned(-12), '-12 gold');
  assert.equal(f.fmtSigned(0), '0 gold');
  assert.equal(f.fmtCost(11), '\u221211 gold');
  assert.equal(f.fmtCost(0), '0 gold');
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
  assert.equal(v.text, '+87 gold in 6s');
  assert.ok(Math.abs(v.fraction - 0.4) < 1e-9);
  assert.equal(v.negative, false);
  const n = f.paydayView({ period: 10, in: 0.2, forecast: -15 });
  assert.equal(n.text, '-15 gold in 1s');
  assert.equal(n.negative, true);
  assert.equal(f.paydayView(undefined).text, '0 gold in 10s');
  assert.equal(f.paydayView({ period: 10, in: 25, forecast: 0 }).fraction, 0);
});

test('paydayBreakdown: the amount and where it came from', () => {
  const b = f.paydayBreakdown({ amount: 87, income: 3, fares: 95, upkeep: 11 });
  assert.equal(b.headline, '+87 gold');
  assert.equal(b.negative, false);
  assert.equal(b.detail, 'stations +3 gold \u00b7 fares +95 gold \u00b7 costs \u221211 gold');
  const n = f.paydayBreakdown({ amount: -20, income: 0, fares: 0, upkeep: 20 });
  assert.equal(n.negative, true);
  assert.equal(n.headline, '-20 gold');
  assert.equal(f.paydayBreakdown(undefined).headline, '0 gold');
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
  assert.deepEqual(g, { text: 'Deliver 5 passengers', progress: '3/5', reward: '+100 gold', how: 'Click the price tag on a track' });
  assert.equal(f.goalView({ text: 'Build a station', progress: 0, target: 1, reward: 100 }).progress, '');
  assert.equal(f.goalView({ text: 'x', progress: 9, target: 5, reward: 0 }).progress, '5/5');
  assert.equal(f.goalView({ text: 'x', progress: 9, target: 5, reward: 0 }).reward, '');
  assert.equal(f.goalView(null), null);
  assert.equal(f.goalDoneText(100), 'Done! +100 gold');
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
  assert.equal(f.quoteLine(s), 'track 204 \u00b7 station 131 \u00b7 2 bridges, 1 tunnel, 1 ledge');
  assert.equal(f.quoteLine({ trackCost: 50, stationCost: 0, bridges: 0, tunnels: 0, ledges: 0 }), 'track 50');
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

test('passenger helpers are gone, gold wording everywhere', () => {
  assert.equal(f.needMoreText(335, 215), '120 more gold needed');
  assert.equal(f.needMoreText(335, 214.5), '121 more gold needed');
  assert.equal(f.needMoreText(10, 50), '0 more gold needed');
  assert.equal(f.queueStatus, undefined);
});

test('buildOffer: label, one short sub line, affordability', () => {
  const kinds = ['ground', 'ground', 'bridge', 'ground'];
  const q = { style: 'cheap', trackCost: 204, stationCost: 122, total: 326, route: { hexes: kinds.map((kind, i) => ({ q: i, r: 0, kind })) } };
  const base = { title: 'Maglev', quote: q, money: 1000, inflight: false, ticket: null };
  assert.deepEqual(f.buildOffer(base), { title: 'Maglev', label: 'Build \u00b7 326 gold', sub: 'track 204 \u00b7 station 122 \u00b7 1 bridge', affordable: true });
  assert.equal(f.buildOffer({ ...base, ticket: { reward: 650.4 } }).sub, 'Ticket \u00b7 +650 gold');
  const poor = f.buildOffer({ ...base, money: 206, ticket: { reward: 650 } });
  assert.equal(poor.sub, '120 more gold needed');
  assert.equal(poor.affordable, false);
  const busy = f.buildOffer({ ...base, money: 0, inflight: true });
  assert.equal(busy.label, 'Building\u2026');
  assert.equal(busy.affordable, false);
  assert.ok(!busy.sub.includes('more gold'));
  for (const o of [f.buildOffer(base), poor, busy]) assert.ok(!/\$/.test(o.label + o.sub));
});

test('ticket rows: route, distance, both ends, reward, time', () => {
  const t = { from: 'Boiler', to: 'Maglev', links: 3, reward: 650.2, time: 60, timeMax: 240 };
  const built = (title) => title === 'Boiler';
  const v = f.ticketView(t, built);
  assert.equal(v.route, 'Boiler \u2192 Maglev');
  assert.equal(v.how, 'about 3 links away');
  assert.equal(v.reward, '+650 gold');
  assert.equal(v.fromBuilt, true);
  assert.equal(v.fraction, 0.25);
  assert.equal(v.tone, 'bad');
  assert.equal(f.ticketView(t, () => false).how, 'about 3 links away \u00b7 build both ends');
  assert.equal(f.ticketDistance(1), 'about 1 link away');
  assert.equal(f.ticketDistance(undefined), 'about 1 link away');
  assert.equal(f.ticketTimeFraction({ time: -4, timeMax: 10 }), 0);
  assert.equal(f.ticketTimeFraction({ time: 4, timeMax: 0 }), 0);
  assert.equal(f.ticketTone(0.9), 'ok');
  assert.equal(f.ticketTone(0.4), 'warn');
});

test('article links are https wikipedia only', () => {
  assert.equal(f.safeArticleUrl('https://en.wikipedia.org/wiki/Rail_transport'), 'https://en.wikipedia.org/wiki/Rail_transport');
  assert.equal(f.safeArticleUrl('http://en.wikipedia.org/wiki/X'), null);
  assert.equal(f.safeArticleUrl('https://evilwikipedia.org/x'), null);
  assert.equal(f.safeArticleUrl('https://en.wikipedia.org.evil.example/x'), null);
  assert.equal(f.safeArticleUrl('javascript:alert(1)'), null);
  assert.equal(f.safeArticleUrl(undefined), null);
});
