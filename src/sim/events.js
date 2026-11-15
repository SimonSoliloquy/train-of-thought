// Tiny synchronous event emitter. A throwing handler never breaks the sim.

export function createEmitter() {
  const handlers = new Map();
  function on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
    return () => handlers.get(name)?.delete(fn);
  }
  function emit(name, payload) {
    const set = handlers.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[sim] '${name}' handler threw`, err);
      }
    }
  }
  return { on, emit };
}
