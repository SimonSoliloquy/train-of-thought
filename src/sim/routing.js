// Passenger routing over the served network. Nodes are built stations; an edge is a track
// that has a train on it (level >= 1). Distances (in stops) are computed lazily per
// destination by BFS and cached until the network changes.

/** @param {() => Iterable<[string, string]>} getEdges */
export function createRouter(getEdges) {
  let adj = null;
  const distCache = new Map();

  function invalidate() {
    adj = null;
    distCache.clear();
  }

  function graph() {
    if (adj) return adj;
    adj = new Map();
    const link = (a, b) => {
      if (!adj.has(a)) adj.set(a, new Set());
      adj.get(a).add(b);
    };
    for (const [a, b] of getEdges()) {
      if (a === b) continue;
      link(a, b);
      link(b, a);
    }
    return adj;
  }

  /** Map station -> stops to `dest`. Empty when dest is not on a served track. */
  function distancesTo(dest) {
    let d = distCache.get(dest);
    if (d) return d;
    d = new Map();
    const g = graph();
    if (g.has(dest)) {
      d.set(dest, 0);
      const queue = [dest];
      for (let i = 0; i < queue.length; i++) {
        const cur = queue[i];
        const next = d.get(cur) + 1;
        for (const nb of g.get(cur)) {
          if (!d.has(nb)) {
            d.set(nb, next);
            queue.push(nb);
          }
        }
      }
    }
    distCache.set(dest, d);
    return d;
  }

  /** True when going from `at` to `next` lies on a shortest path to `dest`. */
  function isGoodStep(dest, at, next) {
    const d = distancesTo(dest);
    const da = d.get(at);
    const dn = d.get(next);
    return da !== undefined && dn !== undefined && dn === da - 1;
  }

  /** Stops from `at` to `dest`, or null when unreachable. */
  function stopsBetween(at, dest) {
    const v = distancesTo(dest).get(at);
    return v === undefined ? null : v;
  }

  /** One shortest path as a list of station titles (at ... dest), or null. */
  function path(at, dest) {
    const d = distancesTo(dest);
    if (!d.has(at)) return null;
    const out = [at];
    let cur = at;
    const g = graph();
    while (cur !== dest) {
      let step = null;
      for (const nb of g.get(cur)) if (d.get(nb) === d.get(cur) - 1) { step = nb; break; }
      if (step === null) return null;
      out.push(step);
      cur = step;
    }
    return out;
  }

  return { invalidate, isGoodStep, stopsBetween, path, distancesTo };
}
