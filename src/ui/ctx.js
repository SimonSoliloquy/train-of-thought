// Shared UI controller state: what is selected, which link is being priced for a build,
// which train the camera is riding. Components talk to each other through this and its bus.
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
    /** { kind: 'station', title } | { kind: 'thought', id, title } | null */
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
      return ctx.sel && ctx.sel.kind === 'station' ? ctx.sel.title : null;
    },

    syncRing() {
      renderer.setSelection(ctx.ringTitle());
    },

    /**
     * Select a built station (opens its card, closes any build card). A title that is not a
     * built station opens the build card for it instead.
     * opts: from (station the player came from), focus, kind ('ghost' when state has not caught up)
     */
    select(title, opts = {}) {
      if (!title) return ctx.deselect();
      const kind = opts.kind || ctx.kindOf(title);
      if (kind === 'ghost') return ctx.openBuild(title, opts.from, opts);
      if (kind !== 'station') return;
      ctx.sel = { kind: 'station', title };
      ctx.build = null;
      ctx.lastBuilt = title;
      if (renderer.setThoughtSelection) renderer.setThoughtSelection(null);
      ctx.syncRing();
      if (opts.focus) renderer.focus(title);
      bus.emit('selection');
      bus.emit('build');
    },

    /** Price building towards `to` (a link, or an already-built station to join). */
    openBuild(to, from, opts = {}) {
      ctx.build = { to, from: from || null };
      if (from) ctx.lastBuilt = from;
      ctx.syncRing();
      if (opts.focus) renderer.focus(to);
      bus.emit('build');
    },

    closeBuild() {
      if (!ctx.build) return false;
      ctx.build = null;
      ctx.syncRing();
      bus.emit('build');
      return true;
    },

    /** Open the card for one waiting passenger (a thought), picked on the map. */
    selectThought(id) {
      const th = state.thoughts.find((t) => t.id === id);
      if (!th) return;
      ctx.sel = { kind: 'thought', title: 'thought ' + id, id };
      ctx.build = null;
      if (renderer.setThoughtSelection) renderer.setThoughtSelection(id);
      ctx.syncRing();
      bus.emit('selection');
      bus.emit('build');
    },

    /** Close everything that is open. */
    deselect() {
      const had = ctx.sel || ctx.build;
      ctx.sel = null;
      ctx.build = null;
      if (renderer.setThoughtSelection) renderer.setThoughtSelection(null);
      ctx.syncRing();
      if (had) {
        bus.emit('selection');
        bus.emit('build');
      }
    },

    /** Escape ladder: the build card first, then the station or passenger card. */
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
