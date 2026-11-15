// Upgrade tags: a clickable chip floating over the middle of every track that can still be
// upgraded, in plain words: "Add train · 120 gold" on bare track, then "Upgrade · Express 327 gold",
// then the final pair "Freight 520 gold" / "Bullet 520 gold", each with its blurb. Bright amber when
// affordable, dim when not. The quotes come from game.quoteUpgrade. While the goal is to put
// the first train on a track, that track's tag pulses under a bouncing arrow.
import { sampleRoute } from './rail.js';
import { tagParameter } from './lanes.js';
import { gold } from './format.js';

export const TAG_REQUERY = 0.5; // seconds between quote refreshes
export const TAG_LIFT = 0.55;   // tag sits this far above the rail (or the hill over a tunnel)

/**
 * Where a track's tag floats: over the middle of the route, above any hill there. Pure.
 * With opts.network (lanes.js) and opts.id it moves along the route to a stretch where the track runs
 * alone (or as far from other tracks as it gets), and away from opts.taken (anchors of other tags), so
 * tags of tracks in one corridor never sit on top of each other.
 */
export function tagAnchor(route, groundAt, opts = {}) {
  const t = opts.network ? tagParameter(route.points, opts.network, opts.id, opts.taken || []) : 0.5;
  const p = sampleRoute(route, t);
  let top = p.y;
  if (typeof groundAt === 'function') {
    const g = groundAt(p.x, p.z);
    if (Number.isFinite(g)) top = Math.max(top, g);
  }
  return { x: p.x, y: top + TAG_LIFT, z: p.z, railY: p.y };
}

/** Normalise a quoteUpgrade result to a list of options (empty when nothing is on offer). Pure. */
export function quoteOptions(quote) {
  if (!quote || quote.ok !== true || !Array.isArray(quote.options)) return [];
  return quote.options.filter((o) => o && typeof o.typeId === 'string').map((o) => ({
    typeId: o.typeId,
    name: o.name || o.typeId,
    blurb: o.blurb || '',
    cost: Number.isFinite(o.cost) ? o.cost : 0,
    affordable: !!o.affordable,
  }));
}


/** What each chip of a tag says, as an instruction. level: the track's level (0 = bare). Pure. */
export function tagChoices(level, options, plain = false) {
  const one = options.length === 1;
  return options.map((o) => {
    let title, sub;
    if (plain) {
      // no prices: just what the click does
      return { ...o, title: one ? `Upgrade \u00b7 ${o.name}` : o.name, sub: o.blurb };
    }
    if (one && (level === 0 || (level == null && o.typeId === 'local'))) {
      title = `Add train \u00b7 ${gold(o.cost)}`;
      sub = o.blurb ? `${o.name} \u00b7 ${o.blurb}` : o.name;
    } else if (one) {
      title = `Upgrade \u00b7 ${o.name} ${gold(o.cost)}`;
      sub = o.blurb;
    } else {
      title = `${o.name} ${gold(o.cost)}`;
      sub = o.blurb;
    }
    return { ...o, title, sub };
  });
}

/** The goal id during which the first bare track's tag is made unmissable. */
export const FIRST_TRAIN_GOAL = 'first-train';

export class UpgradeTags {
  constructor({ game, labels, groundAt, onClick, network, plain = false }) {
    this.plain = !!plain;
    this.network = network || null; // lanes.js Network of built tracks (tracks-view.js owns it)
    this.game = game;
    this.labels = labels;
    this.groundAt = groundAt;
    this.onClick = onClick || null;
    this.tags = new Map();   // trackId -> {trackId, options, x, y, z, railY, afford}
    this.hover = null;       // {trackId, typeId} from the DOM chip or the 3D proxy
    this.t = 0;
    this.dirty = true;
    this.goalTrack = null;   // track whose tag the first-train goal points at
    this.lastGoal = undefined;
  }

  /** Re-ask the game for every track's next upgrade now (after a purchase, payday, new track). */
  refresh() { this.dirty = true; }

  _query(state) {
    const tracks = (state && state.tracks) || [];
    const seen = new Set();
    const canQuote = this.game && typeof this.game.quoteUpgrade === 'function';
    for (const tr of tracks) {
      if (!tr || tr.id == null || !tr.route || !Array.isArray(tr.route.points) || tr.route.points.length < 2) continue;
      if (this.plain) continue; // plain: no upgrade tags at all, only places to build
      let options = [];
      if (canQuote) {
        try { options = quoteOptions(this.game.quoteUpgrade(tr.id)); } catch { options = []; }
      }
      if (!options.length) continue;
      seen.add(tr.id);
      let tag = this.tags.get(tr.id);
      const ver = this.network ? this.network.version : 0;
      if (!tag || tag.route !== tr.route || tag.ver !== ver) {
        const taken = [];
        for (const o of this.tags.values()) if (o.trackId !== tr.id) taken.push(o);
        tag = { trackId: tr.id, route: tr.route, ver, ...tagAnchor(tr.route, this.groundAt, { network: this.network, id: tr.id, taken }) };
        this.tags.set(tr.id, tag);
      }
      tag.level = Number.isFinite(tr.level) ? tr.level : null;
      tag.options = tagChoices(tag.level, options, this.plain);
      tag.afford = options.some((o) => o.affordable);
    }
    // the first-train goal points at one bare track: the first affordable one, else the first
    const goal = state && state.goal && state.goal.id === FIRST_TRAIN_GOAL;
    let pick = null;
    if (goal) {
      for (const tag of this.tags.values()) {
        if (tag.level !== 0 && !(tag.level == null && tag.options.length === 1 && tag.options[0].typeId === 'local')) continue;
        if (!pick || (tag.afford && !pick.afford) || (tag.afford === pick.afford && tag.trackId < pick.trackId)) pick = tag;
      }
    }
    this.goalTrack = pick ? pick.trackId : null;
    for (const id of [...this.tags.keys()]) {
      if (seen.has(id)) continue;
      this.tags.delete(id);
      if (this.labels) this.labels.remove(`tag:${id}`);
      if (this.hover && this.hover.trackId === id) this.hover = null;
    }
  }

  update(dt, state) {
    this.t -= dt;
    const goalId = state && state.goal ? state.goal.id : null;
    if (goalId !== this.lastGoal) { this.lastGoal = goalId; this.dirty = true; }
    if (this.dirty || this.t <= 0) {
      this.t = TAG_REQUERY;
      this.dirty = false;
      this._query(state);
    }
    if (!this.labels) return;
    for (const tag of this.tags.values()) {
      const id = tag.trackId;
      this.labels.upsertTag(`tag:${id}`, {
        x: tag.x, y: tag.y, z: tag.z,
        options: tag.options,
        hoverType: this.hover && this.hover.trackId === id ? this.hover.typeId : null,
        // affordable tags are never culled; dim ones yield to station labels and each other.
        // All tags step aside rather than cover a signpost (see labels.placeLabels).
        goal: id === this.goalTrack,
        pinned: tag.afford || id === this.goalTrack,
        priority: id === this.goalTrack ? 9e4 : tag.afford ? 5e4 : 600,
        onClick: (typeId) => { if (this.onClick) this.onClick(id, typeId); },
        onHover: (typeId) => {
          if (typeId) this.hover = { trackId: id, typeId };
          else if (this.hover && this.hover.trackId === id) this.hover = null;
        },
      });
    }
  }

  /** 3D hit proxies: one over the chip, one on the rails under it. */
  pickables() {
    const out = [];
    for (const tag of this.tags.values()) {
      out.push({ trackId: tag.trackId, options: tag.options, x: tag.x, y: tag.y + 0.2, z: tag.z, r: 0.65 });
      out.push({ trackId: tag.trackId, options: tag.options, x: tag.x, y: tag.railY + 0.1, z: tag.z, r: 0.45 });
    }
    return out;
  }

  /** Tracks to glow: those with an affordable upgrade (and whichever tag is hovered). */
  glowWanted() {
    const out = new Map();
    for (const tag of this.tags.values()) {
      const hovered = !!(this.hover && this.hover.trackId === tag.trackId);
      if (tag.afford || hovered || tag.trackId === this.goalTrack) out.set(tag.trackId, { hovered: hovered || tag.trackId === this.goalTrack });
    }
    return out;
  }

  dispose() {
    if (this.labels) for (const id of this.tags.keys()) this.labels.remove(`tag:${id}`);
    this.tags.clear();
  }
}
