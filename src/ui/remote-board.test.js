import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEADERBOARD_URL, PLAYER_KEY, NAME_KEY, ANONYMOUS, sharedBoardOn, isLocalHost, cleanName, loadName, saveName,
  playerId, submitBody, submitRun, fetchTop, cleanTopRow, forgetTop,
} from './remote-board.js';

const BASE = 'https://leaderboards.example.workers.dev';
const PLACEHOLDER = 'https://leaderboards.WORKER_SUBDOMAIN.workers.dev';
const HOST = 'simonsoliloquy.com';
const RUN = { score: 1234, time: 301.6, stations: 7, tickets: 2, delivered: 40, start: 'Steam engine', lineFrom: 'Steam engine', lineTo: 'James Watt' };

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    raw: (k) => m.get(k),
  };
}

/** A fetch that records its calls and answers with `answer(url, init)`. */
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined });
    return answer(url, init);
  };
  f.calls = calls;
  return f;
}
const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('the address in the bundle is the live Worker, and the placeholder means no shared board', () => {
  assert.ok(sharedBoardOn(LEADERBOARD_URL));
  assert.equal(sharedBoardOn(PLACEHOLDER), false);
  assert.equal(sharedBoardOn('http://leaderboards.example.workers.dev'), false);
  assert.equal(sharedBoardOn(''), false);
});

test('the placeholder address makes no network call at all', async () => {
  const f = fakeFetch(() => json([]));
  forgetTop();
  assert.equal(await fetchTop({ base: PLACEHOLDER, fetch: f }), null);
  assert.equal(await submitRun(RUN, { base: PLACEHOLDER, fetch: f, hostname: HOST, storage: fakeStorage() }), null);
  assert.equal(f.calls.length, 0);
});

test('this machine never submits: localhost, 127.x, [::1], *.localhost, no host', async () => {
  for (const hn of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', 'app.localhost', '', undefined]) {
    assert.ok(isLocalHost(hn), String(hn));
    const f = fakeFetch(() => json({ rankAllTime: 1 }));
    assert.equal(await submitRun(RUN, { base: BASE, fetch: f, hostname: hn, storage: fakeStorage() }), null);
    assert.equal(f.calls.length, 0, String(hn));
  }
  assert.equal(isLocalHost(HOST), false);
  assert.equal(isLocalHost('wiki-train-of-thought.vercel.app'), false);
});

test('submit: one POST to /train-of-thought/submit with exactly the run, the player id and the name', async () => {
  const s = fakeStorage();
  const f = fakeFetch(() => json({ rankAllTime: 37, rankDaily: null, totalPlayers: 120, top: [], daily: null }));
  const out = await submitRun(RUN, { base: BASE, fetch: f, hostname: HOST, storage: s, name: '  Simon  ' });
  assert.deepEqual(out, { rankAllTime: 37, totalPlayers: 120, top: [] });
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, `${BASE}/train-of-thought/submit?n=10`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers, undefined, 'no Content-Type: sent as text/plain, so no CORS preflight');
  assert.equal(typeof c.init.body, 'string');
  assert.ok(!c.url.includes('linkshot'));
  const player = s.raw(PLAYER_KEY);
  assert.ok(player && player.length >= 8);
  assert.deepEqual(c.body, {
    player, name: 'Simon', score: 1234, time: 302, stations: 7, tickets: 2, delivered: 40,
    start: 'Steam engine', lineFrom: 'Steam engine', lineTo: 'James Watt',
  });
  assert.deepEqual(Object.keys(c.body).sort(), ['delivered', 'lineFrom', 'lineTo', 'name', 'player', 'score', 'start', 'stations', 'tickets', 'time']);
  // the same browser keeps the same id
  await submitRun(RUN, { base: BASE, fetch: f, hostname: 'example.org', storage: s });
  assert.equal(f.calls[1].body.player, player);
  assert.equal(f.calls[1].body.name, '', 'no name: blank, the board shows Anonymous');
});

test('submit: a run with no line sends nulls; odd ranks come back as null', async () => {
  const f = fakeFetch(() => json({ rankAllTime: 'x', rankDaily: 0, top: { rows: [] } }));
  const out = await submitRun({ ...RUN, lineFrom: null, lineTo: undefined }, { base: BASE, fetch: f, hostname: 'example.org', storage: null });
  assert.deepEqual(out, { rankAllTime: null, totalPlayers: null, top: null });
  assert.equal(f.calls[0].body.lineFrom, null);
  assert.equal(f.calls[0].body.lineTo, null);
  assert.ok(f.calls[0].body.player, 'blocked storage still gets an id for this run');
});

test('submit and top resolve to null on 400, 404, 429, 500, bad JSON, a thrown fetch, or a wrong shape', async () => {
  const answers = [
    () => json({ error: 'bad' }, 400), () => json(null, 404), () => json({}, 429), () => json({}, 500),
    () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }),
    () => { throw new TypeError('Failed to fetch'); },
  ];
  for (const a of answers) {
    assert.equal(await submitRun(RUN, { base: BASE, fetch: fakeFetch(a), hostname: 'example.org', storage: fakeStorage() }), null);
    forgetTop();
    assert.equal(await fetchTop({ base: BASE, fetch: fakeFetch(a) }), null);
  }
  assert.equal(await submitRun(RUN, { base: BASE, fetch: fakeFetch(() => json([1, 2])), hostname: 'example.org' }), null);
  forgetTop();
  assert.equal(await fetchTop({ base: BASE, fetch: fakeFetch(() => json({ rows: [] })) }), null);
});

test('a call that hangs gives up after the time limit and is aborted', async () => {
  let signal = null;
  const hang = async (url, init) => { signal = init.signal; return new Promise(() => {}); };
  const t0 = Date.now();
  forgetTop();
  assert.equal(await fetchTop({ base: BASE, fetch: hang, timeout: 60 }), null);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(signal && signal.aborted);
  assert.equal(await submitRun(RUN, { base: BASE, fetch: hang, timeout: 60, hostname: 'example.org', storage: fakeStorage() }), null);
});

const ROWS = [
  { name: 'Ada', score: 900.4, stations: 9, tickets: 3, delivered: 50, time: 400.2, start: 'Engine', lineFrom: 'Engine', lineTo: 'Boiler', at: '2026-11-15T10:00:00Z' },
  { name: null, score: 800, stations: 8, tickets: 1, delivered: 40, time: 300, start: 'Kettle', lineFrom: null, lineTo: null, at: 1763200000000 },
  { name: '   ', score: '70', start: 7 },
  null,
];

test('top: GET /train-of-thought/top with n (all time, no scope), rows made safe to draw', async () => {
  forgetTop();
  const f = fakeFetch(() => json(ROWS));
  const rows = await fetchTop({ base: BASE, fetch: f });
  assert.equal(f.calls[0].url, `${BASE}/train-of-thought/top?n=10`);
  assert.ok(!f.calls[0].url.includes('scope'), 'the daily board is gone: no scope is asked for');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { name: 'Ada', score: 900, stations: 9, tickets: 3, delivered: 50, time: 400, start: 'Engine', lineFrom: 'Engine', lineTo: 'Boiler', at: Date.parse('2026-11-15T10:00:00Z') });
  assert.equal(rows[1].name, ANONYMOUS, 'unnamed or filtered runs come back as null');
  assert.equal(rows[1].lineFrom, null);
  assert.equal(rows[1].at, 1763200000000);
  assert.deepEqual([rows[2].name, rows[2].score, rows[2].start, rows[2].at], [ANONYMOUS, 0, '', null]);
  forgetTop();
  await fetchTop({ base: BASE, fetch: f, n: 5 });
  assert.equal(f.calls[1].url, `${BASE}/train-of-thought/top?n=5`);
});

test('top: read at most once per page load, even when asked again or twice at once', async () => {
  forgetTop();
  const f = fakeFetch(() => json(ROWS));
  const [a, b] = await Promise.all([fetchTop({ base: BASE, fetch: f }), fetchTop({ base: BASE, fetch: f })]);
  const c = await fetchTop({ base: BASE, fetch: f });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  // a failed read is not retried either
  forgetTop();
  const bad = fakeFetch(() => json({}, 500));
  assert.equal(await fetchTop({ base: BASE, fetch: bad }), null);
  assert.equal(await fetchTop({ base: BASE, fetch: bad }), null);
  assert.equal(bad.calls.length, 1);
});

test('submit: the answer\'s list is used and kept, so the board is not read again', async () => {
  forgetTop();
  const f = fakeFetch((url) => (url.includes('/submit')
    ? json({ rankAllTime: 2, rankDaily: null, totalPlayers: 9, top: ROWS, daily: null })
    : json([])));
  const out = await submitRun(RUN, { base: BASE, fetch: f, hostname: HOST, storage: fakeStorage() });
  assert.equal(out.rankAllTime, 2);
  assert.equal(out.totalPlayers, 9);
  assert.equal(out.top.length, 3);
  assert.equal(out.top[0].name, 'Ada');
  assert.equal(out.top[1].name, ANONYMOUS);
  assert.ok(!('rankDaily' in out) && !('daily' in out), 'nothing about a today board');
  const rows = await fetchTop({ base: BASE, fetch: f });
  assert.deepEqual(rows, out.top);
  assert.equal(f.calls.length, 1, 'one POST, no GET');
  // n chooses the list length of the answer too
  await submitRun(RUN, { base: BASE, fetch: f, hostname: HOST, storage: fakeStorage(), n: 2 });
  assert.equal(f.calls[1].url, `${BASE}/train-of-thought/submit?n=2`);
});

test('names: trimmed, plain, at most 20 characters, remembered; blank forgets', () => {
  assert.equal(cleanName('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.equal(cleanName(['a', 0, 'b', 0x200b, 'c', 0x202e, 'd'].map((x) => (typeof x === 'number' ? String.fromCharCode(x) : x)).join('')), 'abcd');
  assert.equal(cleanName('x'.repeat(30)).length, 20);
  assert.equal([...cleanName('\u{1F682}'.repeat(25))].length, 20, 'counted in characters, not halves of emoji');
  assert.equal(cleanName(42), '');
  const s = fakeStorage();
  assert.equal(loadName(s), '');
  assert.equal(saveName(s, '  Ada  '), 'Ada');
  assert.equal(s.raw(NAME_KEY), 'Ada');
  assert.equal(loadName(s), 'Ada');
  assert.equal(saveName(s, '   '), '');
  assert.equal(s.raw(NAME_KEY), undefined);
  assert.equal(loadName(null), '');
});

test('player id: made once, kept, and replaced if what is stored is not an id', () => {
  const s = fakeStorage();
  const a = playerId(s, () => 'abcdef1234567890');
  assert.equal(a, 'abcdef1234567890');
  assert.equal(playerId(s, () => 'other-id-000000'), a);
  const bad = fakeStorage({ [PLAYER_KEY]: '<script>' });
  assert.equal(playerId(bad, () => 'fresh-id-123456'), 'fresh-id-123456');
  assert.match(playerId(fakeStorage()), /^[\w-]{8,64}$/);
});

test('submitBody and cleanTopRow cope with junk', () => {
  const b = submitBody({ score: NaN, start: 5 }, 'p1234567', null);
  assert.deepEqual(b, { player: 'p1234567', name: '', score: 0, time: 0, stations: 0, tickets: 0, delivered: 0, start: '', lineFrom: null, lineTo: null });
  assert.equal(cleanTopRow('x'), null);
  assert.equal(cleanTopRow({ start: 'y'.repeat(200) }).start.length, 120);
});
