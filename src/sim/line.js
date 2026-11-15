// A run's longest train line: of every pair of stations joined by built track, the pair whose
// shortest way along the track is longest, measured in track length (world units of
// route.length, the same polyline the trains ride). It names the run on the boards and changes
// nothing about the score.

/**
 * @param {{from: string, to: string, route?: {length?: number}}[]} tracks  built tracks, in build order
 * @returns {{from: string, to: string, length: number}|null}  null with fewer than two connected stations.
 *   Ties keep the pair found first: stations in the order they first appear on a track, `from`
 *   the earlier of the two.
 */
export function longestLine(tracks) {
  const index = new Map();
  const names = [];
  const adj = [];
  const node = (t) => {
    let i = index.get(t);
    if (i === undefined) {
      i = names.length;
      index.set(t, i);
      names.push(t);
      adj.push([]);
    }
    return i;
  };
  for (const tr of tracks || []) {
    if (!tr || typeof tr.from !== 'string' || typeof tr.to !== 'string' || tr.from === tr.to) continue;
    const len = Number(tr.route && tr.route.length);
    const w = Number.isFinite(len) && len > 0 ? len : 0;
    const a = node(tr.from), b = node(tr.to);
    adj[a].push([b, w]);
    adj[b].push([a, w]);
  }
  const n = names.length;
  if (n < 2) return null;

  let best = null;
  const dist = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    dist.fill(Infinity);
    dist[s] = 0;
    const heap = [[0, s]];
    while (heap.length) {
      const [d, u] = pop(heap);
      if (d > dist[u]) continue;
      for (const [v, w] of adj[u]) {
        const nd = d + w;
        if (nd < dist[v]) {
          dist[v] = nd;
          push(heap, [nd, v]);
        }
      }
    }
    for (let t = s + 1; t < n; t++) {
      if (dist[t] === Infinity) continue;
      if (!best || dist[t] > best.length + 1e-9) best = { from: names[s], to: names[t], length: dist[t] };
    }
  }
  return best;
}

// a small binary min-heap of [distance, node]
function push(h, x) {
  h.push(x);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}

function pop(h) {
  const top = h[0];
  const last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}
