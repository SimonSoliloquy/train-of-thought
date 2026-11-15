// A tiny fake of the Wikipedia Action API for unit tests (not used by the game).
// world = { pages: {title: {ns?, views?, length?, desc?, disambig?, extract?, thumb?, links?: string[], leadHtml?: string}},
//           redirects: {from: to}, random?: string[] }
// Behaviours imitated: title normalisation (underscores, first letter), redirects=1, missing pages, generator=links
// continuation (2 pages per response by default), pageviews filling only `viewsPerCall` titles per response.

export function createFakeApi(world, opts = {}) {
  const linksPerPage = opts.linksPerPage ?? 500;
  const viewsPerCall = opts.viewsPerCall ?? 5;
  const calls = [];
  const failures = opts.failures || []; // statuses to answer with before succeeding, e.g. [429, 500]

  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const norm = (t) => cap(t.replace(/_/g, ' ').trim());

  function resolve(titles, redirects) {
    const normalized = [];
    const redirs = [];
    const out = [];
    for (const raw of titles) {
      let t = norm(raw);
      if (t !== raw) normalized.push({ from: raw, to: t });
      let hops = 0;
      while (redirects && world.redirects[t] && hops++ < 5) {
        redirs.push({ from: t, to: world.redirects[t] });
        t = world.redirects[t];
      }
      out.push(t);
    }
    return { normalized, redirs, titles: out };
  }

  function pageObj(t, props) {
    const p = world.pages[t];
    if (!p) return { ns: 0, title: t, missing: true };
    const o = { pageid: 1 + Object.keys(world.pages).indexOf(t), ns: p.ns ?? 0, title: t };
    if (props.includes('pageprops') && p.disambig) o.pageprops = { disambiguation: '' };
    if (props.includes('description') && p.desc) o.description = p.desc;
    if (props.includes('info')) o.length = p.length ?? 1000;
    if (props.includes('extracts')) o.extract = p.extract ?? '';
    if (props.includes('pageimages') && p.thumb) o.thumbnail = { source: p.thumb, width: 320, height: 200 };
    return o;
  }

  function handle(params) {
    if (params.list === 'random') {
      const n = Math.min(Number(params.rnlimit) || 1, (world.random || []).length);
      return { batchcomplete: true, query: { random: (world.random || []).slice(0, n).map((title) => ({ ns: 0, title })) } };
    }
    if (params.action === 'parse') {
      const r = resolve([params.page], params.redirects);
      const p = world.pages[r.titles[0]];
      if (!p) return { error: { code: 'missingtitle', info: 'The page you specified doesn\'t exist.' } };
      return { parse: { title: r.titles[0], pageid: 1, text: p.leadHtml ?? '<div class="mw-parser-output"></div>' } };
    }
    const props = String(params.prop || '');
    if (params.generator === 'links') {
      const r = resolve([params.titles], params.redirects);
      const p = world.pages[r.titles[0]];
      const all = ((p && p.links) || []).map((l) => resolve([l], true));
      const start = params.gplcontinue ? Number(params.gplcontinue) : 0;
      const slice = all.slice(start, start + linksPerPage);
      const pages = slice.map((x) => pageObj(x.titles[0], ''));
      const body = {
        batchcomplete: start + linksPerPage >= all.length,
        query: { redirects: slice.flatMap((x) => x.redirs), pages },
      };
      if (start + linksPerPage < all.length) body.continue = { gplcontinue: String(start + linksPerPage), continue: 'gplcontinue||' };
      return body;
    }
    const titles = String(params.titles).split('|');
    if (titles.length > 50) return { error: { code: 'toomanyvalues', info: 'too many titles' } };
    const r = resolve(titles, params.redirects);
    const uniq = [...new Set(r.titles)];
    const body = { query: {} };
    if (r.normalized.length) body.query.normalized = r.normalized;
    if (r.redirs.length) body.query.redirects = r.redirs;
    if (props === 'pageviews') {
      const start = params.pvipcontinue ? Number(params.pvipcontinue) : 0;
      const slice = uniq.slice(start, start + viewsPerCall);
      body.query.pages = slice.map((t) => {
        const o = pageObj(t, '');
        const v = (world.pages[t] || {}).views;
        if (!o.missing) {
          o.pageviews = {};
          for (let d = 1; d <= 7; d++) o.pageviews[`2026-01-0${d}`] = d === 7 ? null : v ?? 0;
        }
        return o;
      });
      if (start + viewsPerCall < uniq.length) body.continue = { pvipcontinue: String(start + viewsPerCall), continue: '||' };
      return body;
    }
    body.query.pages = uniq.map((t) => {
      const o = pageObj(t, props);
      const v = (world.pages[t] || {}).views;
      if (props.includes('pageviews') && !o.missing) {
        o.pageviews = {};
        for (let d = 1; d <= 7; d++) o.pageviews[`2026-01-0${d}`] = d === 7 ? null : v ?? 0;
      }
      return o;
    });
    return body;
  }

  async function fetch(url, init) {
    const u = new URL(url);
    const params = Object.fromEntries(u.searchParams.entries());
    calls.push({ params, url: String(url), init });
    const status = failures.length ? failures.shift() : 200;
    const headers = { get: (k) => (k.toLowerCase() === 'retry-after' && status === 429 ? '1' : null) };
    if (status !== 200) return { ok: false, status, headers, json: async () => ({}) };
    const body = handle(params);
    return { ok: true, status: 200, headers, json: async () => body };
  }

  return { fetch, calls };
}
