import test from 'node:test';
import assert from 'node:assert/strict';
import { WIKI } from '../config.js';
import { createWiki, detectKind, popularityFromViews, scaleViews } from './index.js';
import { extractLeadCandidates, hrefToTitle } from './lead.js';
import { createFakeApi } from './fakeapi.js';

const noSleep = async () => {};
const mk = (world, opts = {}, apiOpts = {}) => {
  const api = createFakeApi(world, apiOpts);
  const wiki = createWiki({ fetch: api.fetch, sleep: noSleep, backoffMs: 1, ...opts });
  return { api, wiki };
};

const LEAD = `
<div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">
<style data-mw-deduplicate="x">.mw-parser-output .a{color:red} a[href="/wiki/Style_Trap"]{}</style>
<div class="shortdescription nomobile noexcerpt noprint searchaux">Country</div>
<div role="note" class="hatnote navigation-not-searchable">For other uses, see <a href="/wiki/Hatnote_Link">x</a>.</div>
<table class="infobox"><tbody><tr><td><a href="/wiki/Infobox_Link">i</a></td></tr></tbody></table>
<figure class="mw-default-size" typeof="mw-File/Thumb"><a href="/wiki/File:Flag.svg" class="mw-file-description"><img src="x"/></a><figcaption>Flag of <a href="/wiki/Caption_Link">c</a></figcaption></figure>
<p><span class="geo-default"><a href="/wiki/Geo_Link">coords</a></span><b>Foo</b> is a <a href="/wiki/USA" class="mw-redirect" title="USA">country</a> in
<a href="/wiki/North_America#History" title="North America">North America</a>, with <a href="/wiki/Nope" class="new" title="Nope (page does not exist)">red</a>,
<a href="/wiki/Category:Stuff">cat</a> and <a href="https://example.org/x">ext</a><sup class="reference"><a href="#cite_note-1">[1]</a></sup>
and <a href="/wiki/2001:_A_Space_Odyssey">odyssey</a>, <a href="/wiki/R%26D">R&amp;D</a>, <a href="/wiki/North_America">again</a>.</p>
<!-- <a href="/wiki/Comment_Link">c</a> -->
<div class="navbox"><a href="/wiki/Navbox_Link">n</a></div>
<ul><li><a href="/wiki/List_Item_Link">li</a></li></ul>
<p>Second <a href="/wiki/Second_Para">para</a>.</p>
</div>`;

test('lead extraction: keeps paragraph links in order, drops infobox/hatnote/caption/geo/navbox/ref/red/external/namespaced, lists last', () => {
  const got = extractLeadCandidates(LEAD);
  assert.deepEqual(got, [
    'USA',
    'North America',
    '2001: A Space Odyssey',
    'R&D',
    'Second Para',
    'List Item Link',
  ]);
});

test('hrefToTitle decodes and rejects non-article links', () => {
  assert.equal(hrefToTitle('/wiki/Foo_(bar)#x'), 'Foo (bar)');
  assert.equal(hrefToTitle('/wiki/%C3%89cole'), 'École');
  assert.equal(hrefToTitle('/wiki/Foo?action=edit'), null);
  assert.equal(hrefToTitle('/wiki/Talk:Foo'), null);
  assert.equal(hrefToTitle('/wiki/File:A.png'), null);
  assert.equal(hrefToTitle('//other/x'), null);
  assert.equal(hrefToTitle('#cite'), null);
});

test('kind detection', () => {
  assert.equal(detectKind('Mercury', { disambiguation: '' }), 'disambiguation');
  assert.equal(detectKind('List of rivers', {}), 'list');
  for (const p of ['Lists of', 'Outline of', 'Index of', 'Timeline of']) assert.equal(detectKind(`${p} stuff`, undefined), 'list');
  assert.equal(detectKind('Listing', undefined), 'article');
  assert.equal(detectKind('The List of Things', undefined), 'article');
});

test('popularity scaling is log: 100k/day = 1, <10/day <= ~0.2, none = 0', () => {
  assert.equal(scaleViews(100000), 1);
  assert.equal(scaleViews(5e6), 1);
  assert.equal(scaleViews(0), 0);
  assert.ok(scaleViews(9) <= 0.201, String(scaleViews(9)));
  assert.ok(scaleViews(1000) > 0.55 && scaleViews(1000) < 0.65);
  assert.ok(scaleViews(10) < scaleViews(100) && scaleViews(100) < scaleViews(10000));
  assert.equal(popularityFromViews({ a: null, b: null }), 0);
  assert.equal(popularityFromViews(undefined), 0);
  assert.equal(popularityFromViews({ a: 99999, b: null, c: 99999 }), scaleViews(99999));
});

const WORLD = () => ({
  redirects: { USA: 'United States', 'U.S.': 'United States' },
  pages: {
    'United States': {
      views: 30000, desc: 'Country', extract: 'The US is a country.\nSecond line.', thumb: 'https://img/us.png',
      length: 300000,
      links: ['Canada', 'USA', 'Mexico', 'United States', 'Alaska', 'Missing Page'],
      leadHtml: '<div><p>The <a href="/wiki/USA">US</a> borders <a href="/wiki/Canada">Canada</a>, <a href="/wiki/Hawaii">Hawaii</a> and itself <a href="/wiki/United_States">x</a>, also <a href="/wiki/Talk:Foo">t</a>, <a href="/wiki/Missing_Page">gone</a>, <a href="/wiki/Wikipedia:Policy">w</a>.</p></div>',
    },
    Canada: { views: 9000, desc: 'Country in North America' },
    Mexico: { views: 8000 },
    Alaska: { views: 300 },
    Hawaii: { views: 700 },
    Mercury: { disambig: true, views: 100, desc: 'Topics referred to by the same term' },
    'List of rivers': { views: 50 },
    'Wikipedia:Policy': { ns: 4 },
    'Talk:Foo': { ns: 1 },
  },
});

test('getStubs: batches 50 per request, keyed as requested, redirects resolved, missing omitted', async () => {
  const world = WORLD();
  const names = [];
  for (let i = 0; i < 120; i++) {
    world.pages[`Page ${i}`] = { views: 10 * i };
    names.push(`Page ${i}`);
  }
  const { api, wiki } = mk(world);
  const req = ['USA', 'canada', 'Mercury', 'List of rivers', 'Does Not Exist', 'U.S.', ...names];
  const stubs = await wiki.getStubs(req);
  assert.equal(stubs.get('USA').title, 'United States');
  assert.equal(stubs.get('U.S.').title, 'United States');
  assert.equal(stubs.get('canada').title, 'Canada'); // first-letter normalisation
  assert.equal(stubs.get('Mercury').kind, 'disambiguation');
  assert.equal(stubs.get('List of rivers').kind, 'list');
  assert.equal(stubs.get('United States'), undefined, 'only requested keys');
  assert.equal(stubs.has('Does Not Exist'), false);
  assert.equal(stubs.get('Page 100').popularity, scaleViews(1000));
  assert.equal(stubs.get('USA').description, 'Country');
  assert.equal(typeof stubs.get('USA').popularity, 'number');
  assert.deepEqual(Object.keys(stubs.get('USA')).sort(), ['description', 'kind', 'popularity', 'title']);
  const base = api.calls.filter((c) => c.params.prop && c.params.prop.includes('pageprops'));
  assert.equal(base.length, 3, 'ceil(126/50) metadata requests');
  for (const c of base) assert.ok(c.params.titles.split('|').length <= 50);
  for (const c of api.calls) assert.equal(c.params.origin, '*');
  const before = api.calls.length;
  await wiki.getStubs(req);
  assert.equal(api.calls.length, before, 'second call fully cached (incl. missing pages)');
});

test('getStubs: pageviews continuation is followed', async () => {
  const world = WORLD();
  for (let i = 0; i < 12; i++) world.pages[`P${i}`] = { views: 100000 };
  const { wiki } = mk(world, {}, { viewsPerCall: 2 });
  const stubs = await wiki.getStubs(Array.from({ length: 12 }, (_, i) => `P${i}`));
  for (const s of stubs.values()) assert.equal(s.popularity, 1);
});

test('getArticle: canonical titles, lead links filtered/resolved, links superset, summary/thumbnail/url', async () => {
  const { api, wiki } = mk(WORLD(), {}, { linksPerPage: 2 });
  const a = await wiki.getArticle('USA');
  assert.equal(a.title, 'United States');
  assert.equal(a.kind, 'article');
  assert.equal(a.description, 'Country');
  assert.equal(a.summary, 'The US is a country.');
  assert.equal(a.thumbnail, 'https://img/us.png');
  assert.equal(a.url, 'https://en.wikipedia.org/wiki/United_States');
  assert.equal(a.popularity, scaleViews(30000));
  // lead: USA -> United States (self, dropped), Canada, Hawaii; Talk/Wikipedia dropped; missing dropped
  assert.deepEqual(a.leadLinks, ['Canada', 'Hawaii']);
  assert.ok(a.leadLinks.every((t) => a.links.includes(t)), 'links is a superset of leadLinks');
  assert.deepEqual(a.links.slice(0, 2), ['Canada', 'Hawaii'], 'lead links come first');
  assert.ok(a.links.includes('Mexico') && a.links.includes('Alaska'));
  assert.ok(!a.links.includes('United States'), 'no self link');
  assert.ok(!a.links.includes('USA'), 'redirect resolved');
  assert.ok(!a.links.includes('Missing Page'));
  assert.equal(new Set(a.links).size, a.links.length);
  // meta, parse, 2 link pages (6 links /2 per page = 3), lead title lookup
  assert.ok(api.calls.length <= 8, `requests: ${api.calls.length}`);
});

test('getArticle: links capped at WIKI.maxLinks, leadLinks capped at WIKI.maxLeadLinks, links still superset', async () => {
  const world = WORLD();
  const many = Array.from({ length: WIKI.maxLinks + 400 }, (_, i) => `Link ${i}`);
  for (const t of many) world.pages[t] = {};
  world.pages['Big'] = {
    links: many,
    leadHtml: `<p>${many.slice(-30).map((t) => `<a href="/wiki/${t.replace(/ /g, '_')}">x</a>`).join(' ')}</p>`,
  };
  const { wiki } = mk(world);
  const a = await wiki.getArticle('Big');
  assert.equal(a.links.length, WIKI.maxLinks);
  assert.equal(a.leadLinks.length, WIKI.maxLeadLinks);
  assert.deepEqual(a.leadLinks, many.slice(-30, -30 + WIKI.maxLeadLinks));
  assert.ok(a.leadLinks.every((t) => a.links.includes(t)));
});

test('getArticle: kind from pageprops and title; missing page rejects', async () => {
  const { wiki } = mk(WORLD());
  assert.equal((await wiki.getArticle('Mercury')).kind, 'disambiguation');
  assert.equal((await wiki.getArticle('List of rivers')).kind, 'list');
  await assert.rejects(wiki.getArticle('No Such Thing'), /no article/i);
});

test('cache and in-flight dedupe: same title concurrently = one set of requests; repeat = none', async () => {
  const { api, wiki } = mk(WORLD());
  const [a, b, c] = await Promise.all([wiki.getArticle('United States'), wiki.getArticle('United_States'), wiki.getArticle('United States')]);
  assert.equal(a, b);
  assert.equal(a, c);
  const n = api.calls.length;
  const d = await wiki.getArticle('United States');
  const e = await wiki.getArticle('USA'); // alias learned from the first load
  assert.equal(d, a);
  assert.equal(e, a);
  assert.equal(api.calls.length, n);
  // stubs fetched by getArticle's lead lookup are reused by getStubs
  const before = api.calls.length;
  const s = await wiki.getStubs(['United States']);
  assert.equal(s.get('United States').title, 'United States');
  assert.equal(api.calls.length, before);
});

test('in-flight stubs dedupe', async () => {
  const { api, wiki } = mk(WORLD());
  await Promise.all([wiki.getStubs(['Canada', 'Mexico']), wiki.getStubs(['Mexico', 'Canada']), wiki.getStubs(['USA'])]);
  const base = api.calls.filter((c) => String(c.params.prop).includes('pageprops'));
  assert.equal(base.length, 2, 'Canada+Mexico once, USA once');
});

test('concurrency never exceeds 4', async () => {
  const world = WORLD();
  for (let i = 0; i < 40; i++) world.pages[`P${i}`] = { views: 5 };
  const api = createFakeApi(world);
  let active = 0;
  let max = 0;
  const slow = async (url, init) => {
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 5));
    try {
      return await api.fetch(url, init);
    } finally {
      active--;
    }
  };
  const wiki = createWiki({ fetch: slow, sleep: noSleep });
  await wiki.getStubs(Array.from({ length: 40 }, (_, i) => `P${i}`));
  assert.ok(max >= 2 && max <= 4, `max concurrent ${max}`);
});

test('retries 429/5xx with backoff then succeeds; gives up after retries', async () => {
  const { api, wiki } = mk(WORLD(), {}, { failures: [429, 503, 500] });
  const s = await wiki.getStubs(['Canada']);
  assert.equal(s.get('Canada').title, 'Canada');
  assert.equal(wiki.stats.retries, 3);
  const bad = mk(WORLD(), { retries: 1 }, { failures: [500, 500, 500, 500] });
  await assert.rejects(bad.wiki.getStubs(['Canada']), /HTTP 500/);
  assert.equal(api.calls.length >= 4, true);
});

test('retries network errors', async () => {
  const api = createFakeApi(WORLD());
  let n = 0;
  const flaky = async (u, i) => {
    if (n++ < 2) throw new TypeError('fetch failed');
    return api.fetch(u, i);
  };
  const wiki = createWiki({ fetch: flaky, sleep: noSleep, backoffMs: 1 });
  assert.equal((await wiki.getStubs(['Canada'])).size, 1);
});

test('no personal data in requests; Node sends the generic user agent', async () => {
  const { api, wiki } = mk(WORLD());
  await wiki.getArticle('Canada');
  for (const c of api.calls) {
    assert.equal(c.init.headers['User-Agent'], 'TrainOfThoughtGame/0.1 (browser game prototype)');
    assert.ok(!/@/.test(c.url));
  }
});

test('randomStart: picks the best-known random page that meets the thresholds', async () => {
  const world = WORLD();
  const rnd = [];
  const lead = (n) => `<p>${Array.from({ length: n }, (_, i) => `<a href="/wiki/Target_${i}">t</a>`).join(' ')}</p>`;
  const links = Array.from({ length: 80 }, (_, i) => `Target ${i}`);
  for (const l of links) world.pages[l] = {};
  const add = (t, views, length, extra = {}) => {
    world.pages[t] = { views, length, links, leadHtml: lead(12), ...extra };
    rnd.push(t);
  };
  add('Obscure Stub', 5, 500); // too short to be sampled
  add('Obscure Long', 20, 20000);
  add('Famous Town', 5000, 40000);
  add('Famous Disambig', 90000, 40000, { disambig: true });
  add('Famous But Linkless', 80000, 90000, { links: ['Target 0'], leadHtml: lead(2) });
  world.random = rnd;
  const { wiki } = mk(world);
  const a = await wiki.randomStart();
  assert.equal(a.title, 'Famous Town');
  assert.ok(a.leadLinks.length >= WIKI.startMinLeadLinks && a.links.length >= WIKI.startMinLinks);
});

test('randomStart: falls back to the hard-coded list when random sampling finds nothing', async () => {
  const world = WORLD();
  world.random = ['Tiny One', 'Tiny Two'];
  world.pages['Tiny One'] = { length: 100 };
  world.pages['Tiny Two'] = { length: 100 };
  const links = Array.from({ length: 80 }, (_, i) => `T${i}`);
  for (const l of links) world.pages[l] = {};
  const lead = `<p>${links.slice(0, 12).map((t) => `<a href="/wiki/${t}">t</a>`).join(' ')}</p>`;
  const { FALLBACK_STARTS } = await import('./fallback.js');
  assert.ok(FALLBACK_STARTS.length >= 30);
  for (const t of FALLBACK_STARTS) world.pages[t] = { links, leadHtml: lead, views: 1000 };
  const { wiki } = mk(world, { random: () => 0 });
  const a = await wiki.randomStart();
  assert.equal(a.title, FALLBACK_STARTS[0]);
});

test('links in order of appearance come from the wikitext', async () => {
  const { extractWikitextLinks, normalizeTarget, orderLinks } = await import('./order.js');
  assert.equal(normalizeTarget('steam_engine#History'), 'Steam engine');
  assert.equal(normalizeTarget(':Category:Trains'), null);
  assert.equal(normalizeTarget('File:Loco.jpg'), null);
  assert.equal(normalizeTarget('fr:Locomotive'), null);
  assert.equal(normalizeTarget('Star Trek: The Next Generation'), 'Star Trek: The Next Generation');
  assert.equal(normalizeTarget('#Section only'), null);
  const wt = `{{Infobox|maker=[[James Watt]]}} A '''locomotive''' is a [[rail transport]] vehicle.<!-- [[Hidden]] -->
It may use a [[steam engine|steam]] or [[Diesel engine]]s. See [[rail transport]] and [[File:X.jpg|thumb|a [[boiler]]]]
<nowiki>[[Not a link]]</nowiki> [[Category:Vehicles]] [[USA]]`;
  const written = extractWikitextLinks(wt);
  assert.deepEqual(written, ['James Watt', 'Rail transport', 'Steam engine', 'Diesel engine', 'Boiler', 'USA']);
  const known = ['Boiler', 'Diesel engine', 'James Watt', 'Navbox only', 'Rail transport', 'Steam engine', 'United States'];
  const canonical = (w) => (w === 'USA' ? 'United States' : null);
  assert.deepEqual(
    orderLinks(written, canonical, known, 'Locomotive'),
    ['James Watt', 'Rail transport', 'Steam engine', 'Diesel engine', 'Boiler', 'United States', 'Navbox only'],
  );
  // never the page itself, never a link the page does not have, capped
  assert.deepEqual(orderLinks(['Locomotive', 'Ghost', 'Boiler'], () => null, ['Boiler', 'Locomotive'], 'Locomotive'), ['Boiler']);
  assert.equal(orderLinks(written, canonical, known, 'Locomotive', 3).length, 3);
});

test('featuredPrefix gives a capital letter then lower-case letters, from the whole alphabet', async () => {
  const { featuredPrefix } = await import('./index.js');
  assert.equal(featuredPrefix(() => 0, 2), 'Aa');
  assert.equal(featuredPrefix(() => 0.999999, 2), 'Zz');
  assert.equal(featuredPrefix(() => 0.5, 1), 'N');
  assert.match(featuredPrefix(Math.random, 2), /^[A-Z][a-z]$/);
});
