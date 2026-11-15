// Shared UI controller state: which built station is selected, which link is being priced for a
// build, which train the camera is riding. Components talk through this and its bus.
import { createBus } from './dom.js';

export function createCtx({ game, renderer, toast }) {
  const state = game.state;
  const bus = createBus();

  const ctx = {
    game,
    renderer,
    state,
    bus,
    toast,
    /** the selected built station: { kind: 'station', title } | null */
    sel: null,
    /** the link being priced: { to, from } where from is the station the player came from (or null) */
    build: null,
    /** the built station the player was last looking at; the default "build from" */
    lastBuilt: null,
    /** id of the train the camera is following */
    riding: null,

    /** Toast a failed Result and return whether it succeeded. */
    report(res) {
      if (!res || !res.ok) {
        toast((res && res.reason) || 'That did not work.', 'bad');
        return false;
      }
      return true;
    },

    kindOf(title) {
      if (state.stations.has(title)) return 'station';
      if (state.stubs && state.stubs.has(title)) return 'ghost';
      return null;
    },

    /** The title the 3D view should ring: the link being priced, else the selected station. */
    ringTitle() {
      if (ctx.build) return ctx.build.to;
      return ctx.sel ? ctx.sel.title : null;
    },

    syncRing() {
      renderer.setSelection(ctx.ringTitle());
    },

    /**
     * Select a built station (the 3D view then shows its signposts) and end any pricing.
     * A title that is not a built station is priced instead.
     * opts: from, focus, kind ('station' | 'ghost' when state has not caught up)
     */
    select(title, opts = {}) {
      if (!title) return ctx.deselect();
      const kind = opts.kind || ctx.kindOf(title);
      if (kind === 'ghost') return ctx.openBuild(title, opts.from);
      if (kind !== 'station') return;
      ctx.sel = { kind: 'station', title };
      ctx.build = null;
      ctx.lastBuilt = title;
      ctx.syncRing();
      if (opts.focus) renderer.focus(title);
      bus.emit('selection');
      bus.emit('build');
    },

    /** Price building towards `to` (a link, or an already-built station to join). */
    openBuild(to, from) {
      ctx.build = { to, from: from || null };
      if (from) ctx.lastBuilt = from;
      ctx.syncRing();
      bus.emit('build');
    },

    closeBuild() {
      if (!ctx.build) return false;
      ctx.build = null;
      ctx.syncRing();
      bus.emit('build');
      return true;
    },

    /** Clear the selection and any pricing. */
    deselect() {
      const had = ctx.sel || ctx.build;
      ctx.sel = null;
      ctx.build = null;
      ctx.syncRing();
      if (had) {
        bus.emit('selection');
        bus.emit('build');
      }
    },

    /** Escape ladder: pricing first, then the selection. */
    back() {
      if (ctx.closeBuild()) return true;
      if (ctx.sel) {
        ctx.deselect();
        return true;
      }
      return false;
    },

    startRide(trainId) {
      ctx.riding = trainId;
      renderer.follow(trainId);
      bus.emit('riding');
    },

    stopRide() {
      if (ctx.riding == null) return;
      ctx.riding = null;
      renderer.follow(null);
      bus.emit('riding');
    },
  };
  return ctx;
}
