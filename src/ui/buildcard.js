// The build card: what happens, what it costs, one button. Always the cheap route, always built from
// the station the player came from (or, failing that, the cheapest station that links to it).
import { ECON } from '../config.js';
import { h, add, clear, setText, setClass, setDisabled } from './dom.js';
import {
  fmtMoney, premiumNote, summarizeQuote, quoteLine, quoteAffordable, needsRequote, buildSources, chooseSource,
  waitingBonus, bonusLine, needMoreText,
} from './format.js';

export function createBuildCard(ctx) {
  const { game, renderer, state } = ctx;
  const el = h('section', { class: 'tot-panel tot-buildcard', hidden: true });
  /** open card: { to, from, quote, error, lastInfl, inflight, refs } */
  let cur = null;

  function close() {
    if (cur) {
      cur = null;
      renderer.setRoutePreview(null);
    }
    clear(el);
    el.hidden = true;
  }

  function quoteFrom(from, to) {
    const res = game.quoteBuild(from, to);
    return res && res.ok ? res.cheap : null;
  }

  function open(to, preferredFrom) {
    close();
    el.hidden = false;
    const sources = buildSources(to, state, (a, b) => !!game.trackBetween(a, b));
    const from = chooseSource(sources, preferredFrom, ctx.lastBuilt, (s) => {
      const q = quoteFrom(s, to);
      return q ? q.total : null;
    });
    cur = { to, from, quote: null, error: '', lastInfl: 0, inflight: false, refs: null };

    const built = state.stations.get(to);
    const stub = state.stubs && state.stubs.get(to);
    const article = built && built.article;
    const desc = (article && article.description) || (stub && stub.description) || '';
    const kindName = (article && article.kind) || (stub && stub.kind);
    const premium = premiumNote(kindName, ECON.specialPageCostMult);

    const price = h('div', { class: 'tot-price' });
    const quiet = h('div', { class: 'tot-quiet' });
    const bonus = h('div', { class: 'tot-bonus', hidden: true });
    const btn = h('button', { class: 'tot-btn tot-btn-primary tot-buildbtn', type: 'button', onClick: doBuild, text: 'Build' });
    const note = h('div', { class: 'tot-note' });
    cur.refs = { price, quiet, bonus, btn, note, track: !!built };

    add(el, [
      h('h2', { text: built ? `Build a track to ${to}` : `Build a station at ${to}` }),
      desc ? h('p', { class: 'tot-desc', text: desc }) : null,
      premium ? h('p', { class: 'tot-note premium', text: premium }) : null,
      price, quiet, bonus, btn, note,
    ]);
    if (!from) {
      cur.error = built ? 'No station of yours can reach this one by a link.' : 'None of your stations links to this page.';
      setText(quiet, cur.error);
      cur.refs.quiet.classList.add('bad');
      btn.hidden = true;
      renderer.setRoutePreview(null);
      return;
    }
    requote();
  }

  function requote() {
    if (!cur || !cur.from) return;
    const res = game.quoteBuild(cur.from, cur.to);
    cur.lastInfl = state.inflation;
    if (!res || !res.ok) {
      cur.quote = null;
      cur.error = (res && res.reason) || 'No quote available.';
      renderer.setRoutePreview(null);
    } else {
      cur.quote = res.cheap;
      cur.error = '';
      renderer.setRoutePreview([res.cheap.route], 'cheap');
    }
    cur.refs.quiet.classList.toggle('bad', !!cur.error);
    updateLive(true);
  }

  /** Cheap per-tick work: affordability against live gold, waiting passengers, button label. */
  function updateLive(force) {
    if (!cur || !cur.from) return;
    const { price, quiet, bonus, btn, note } = cur.refs;
    const q = cur.quote;
    if (!q) {
      setText(quiet, cur.error);
      setText(price, '');
      bonus.hidden = true;
      btn.hidden = true;
      return;
    }
    if (force) setText(quiet, quoteLine(summarizeQuote(q)));
    setText(price, fmtMoney(q.total));
    // Building a station that passengers are waiting for pays a bonus at once.
    const line = cur.refs.track ? '' : bonusLine(waitingBonus(state.thoughts, cur.to, ECON.routeBonusFraction));
    setText(bonus, line);
    bonus.hidden = !line;
    btn.hidden = false;
    const ok = quoteAffordable(q, state.money);
    setText(btn, cur.inflight ? 'Building\u2026' : `Build \u00b7 ${fmtMoney(q.total)}`);
    setDisabled(btn, cur.inflight || !ok);
    setClass(btn, 'unaffordable', !ok);
    setText(note, ok || cur.inflight ? '' : needMoreText(q.total, state.money));
  }

  function update() {
    if (!cur || !cur.from) return;
    if (cur.quote && needsRequote(cur.lastInfl, state.inflation)) requote();
    else updateLive(false);
  }

  async function doBuild() {
    if (!cur || cur.inflight || !cur.quote) return;
    const mine = cur;
    const { from, to } = mine;
    mine.inflight = true;
    updateLive(false);
    let res;
    try {
      res = await game.build(from, to, 'cheap');
    } catch (err) {
      res = { ok: false, reason: (err && err.message) || 'Building failed.' };
    }
    mine.inflight = false;
    if (!ctx.report(res)) {
      if (cur === mine) requote();
      return;
    }
    // Follow the new station only if the player is still looking at this card.
    if (cur === mine) ctx.select(to, { kind: 'station' });
  }

  /** Re-render when the target or the way to it changes. */
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
    open(b.to, cur.from || b.from);
  }

  ctx.bus.on('build', sync);
  return { el, update, refresh };
}
