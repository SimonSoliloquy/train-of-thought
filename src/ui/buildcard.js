// The build controller. No DOM: when a link is being priced it works out where to build from and
// what it costs, draws the route, brings the place on screen, and hands the renderer one offer
// (setBuildOffer) to float over the place. The Build button itself lives in the 3D view; a click on
// it arrives as Pick { kind: 'build', title }, which calls build().
import { buildSources, chooseSource, needsRequote, quoteAffordable, buildOffer } from './format.js';

export function createBuildCard(ctx) {
  const { game, renderer, state } = ctx;
  /** the link being priced: { to, from, quote, lastInfl, inflight, key } */
  let cur = null;
  let shown = false; // whether the renderer holds an offer and a preview from us

  function close() {
    cur = null;
    if (shown) {
      shown = false;
      renderer.setBuildOffer(null);
      renderer.setRoutePreview(null);
    }
  }

  /** Pricing cannot go on: say why (unless the map merely changed under it) and end it. */
  function fail(reason, quiet) {
    if (!quiet) ctx.toast(reason, 'bad');
    close();
    ctx.closeBuild();
  }

  function open(to, preferredFrom, quiet) {
    const same = cur && cur.to === to;
    close();
    const sources = buildSources(to, state, (a, b) => !!game.trackBetween(a, b));
    const from = chooseSource(sources, preferredFrom, ctx.lastBuilt, (s) => {
      const res = game.quoteBuild(s, to);
      return res && res.ok ? res.cheap.total : null;
    });
    if (!from) {
      return fail(state.stations.has(to) ? 'No station of yours can reach this one by a link.' : 'None of your stations links to this page.', quiet);
    }
    cur = { to, from, quote: null, lastInfl: 0, inflight: false, key: '' };
    if (!same) renderer.focus(to);
    requote(quiet);
  }

  function requote(quiet) {
    if (!cur) return;
    const res = game.quoteBuild(cur.from, cur.to);
    cur.lastInfl = state.inflation;
    if (!res || !res.ok) return fail((res && res.reason) || 'No quote available.', quiet);
    cur.quote = res.cheap;
    shown = true;
    renderer.setRoutePreview([res.cheap.route]);
    cur.key = '';
    updateLive();
  }

  /** Cheap per-tick work: the offer follows gold, the ticket reward and the in-flight state. */
  function updateLive() {
    if (!cur || !cur.quote) return;
    const ticket = (state.tickets || []).find((t) => t.to === cur.to) || null;
    const offer = buildOffer({ title: cur.to, quote: cur.quote, money: state.money, inflight: cur.inflight, ticket });
    const key = `${offer.label}|${offer.sub}|${offer.affordable}`;
    if (key === cur.key) return;
    cur.key = key;
    renderer.setBuildOffer(offer);
  }

  function update() {
    if (!cur || !cur.quote) return;
    if (needsRequote(cur.lastInfl, state.inflation)) requote(true);
    else updateLive();
  }

  /** Pick { kind: 'build', title }: the Build button over the map was clicked. */
  async function build(title) {
    const mine = cur;
    if (!mine || mine.to !== title || mine.inflight || !mine.quote) return;
    if (!quoteAffordable(mine.quote, state.money)) return;
    const { from, to } = mine;
    mine.inflight = true;
    updateLive();
    let res;
    try {
      res = await game.build(from, to, 'cheap');
    } catch (err) {
      res = { ok: false, reason: (err && err.message) || 'Building failed.' };
    }
    mine.inflight = false;
    if (!ctx.report(res)) {
      if (cur === mine) requote(true);
      return;
    }
    // Follow the new station only if the player is still looking at this link.
    if (cur === mine) ctx.select(to, { kind: 'station' });
  }

  /** The bus says the target changed (or ended). */
  function sync() {
    const b = ctx.build;
    if (!b) return close();
    if (cur && cur.to === b.to && (!b.from || cur.from === b.from)) return;
    open(b.to, b.from);
  }

  /** The map changed: the target may now be built, or a track may now join the pair. */
  function refresh() {
    if (!cur || cur.inflight) return;
    const b = ctx.build;
    if (!b) return;
    if (state.stations.has(b.to) && cur.from && game.trackBetween(cur.from, b.to)) {
      ctx.select(b.to, { kind: 'station' });
      return;
    }
    open(b.to, cur.from || b.from, true);
  }

  ctx.bus.on('build', sync);
  return { update, refresh, build };
}
