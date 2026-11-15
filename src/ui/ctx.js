// Shared UI controller state: what is selected, whether the player is drawing a line,
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
    /** { kind: 'station'|'ghost'|'connect', title, from } | null */
    sel: null,
    /** the built station the player was last looking at; default "build from" */
    lastBuilt: null,
    /** { type: 'line', editId: number|null, stops: string[] } | null */
    mode: null,
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

    /**
     * Select a station or ghost (opens its card). While drawing a line cards stay closed;
     * the camera may still move.
     * opts: from (station the player came from), focus, connect (build panel for a built
     * target), kind (override when state has not caught up yet)
     */
    select(title, opts = {}) {
      if (!title) return ctx.deselect();
      if (ctx.mode) {
        if (opts.focus) renderer.focus(title);
        return;
      }
      const kind = opts.connect ? 'connect' : opts.kind || ctx.kindOf(title);
      if (!kind) return;
      ctx.sel = { kind, title, from: opts.from || null };
      if (renderer.setThoughtSelection) renderer.setThoughtSelection(null);
      if (kind === 'station') ctx.lastBuilt = title;
      else if (opts.from) ctx.lastBuilt = opts.from;
      renderer.setSelection(title);
      if (opts.focus) renderer.focus(title);
      bus.emit('selection');
    },

    /** Open the card for one waiting passenger (a thought), picked on the map. */
    selectThought(id) {
      if (ctx.mode) return;
      const th = state.thoughts.find((t) => t.id === id);
      if (!th) return;
      ctx.sel = { kind: 'thought', title: 'thought ' + id, id };
      renderer.setSelection(null);
      if (renderer.setThoughtSelection) renderer.setThoughtSelection(id);
      bus.emit('selection');
    },

    deselect() {
      if (!ctx.sel) return;
      ctx.sel = null;
      renderer.setSelection(null);
      if (renderer.setThoughtSelection) renderer.setThoughtSelection(null);
      bus.emit('selection');
    },

    setMode(mode) {
      if (mode) ctx.deselect();
      ctx.mode = mode;
      bus.emit('mode');
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
