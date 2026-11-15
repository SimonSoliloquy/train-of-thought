// Shared sampling of a Route's centreline. The sim (train position), the renderer
// (rails, trains, carriages) and nothing else decide where a train is: everyone
// calls sampleRoute so the train always sits exactly on the drawn track.

const cumCache = new WeakMap();

function cumulative(route) {
  let cum = cumCache.get(route);
  if (cum) return cum;
  const pts = route.points;
  cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  cumCache.set(route, cum);
  return cum;
}

/** Length of the centreline polyline in world units. */
export function routeLength(route) {
  const cum = cumulative(route);
  return cum[cum.length - 1] || 0;
}

/**
 * Point on the route at t in [0, 1], measured by arc length from route.from to route.to.
 * @returns {{x:number,y:number,z:number,dx:number,dy:number,dz:number,kind:string}}
 *   position, unit tangent pointing toward route.to, and the track kind at that point.
 */
export function sampleRoute(route, t) {
  const pts = route.points;
  const cum = cumulative(route);
  const total = cum[cum.length - 1] || 0;
  const d = Math.min(1, Math.max(0, t)) * total;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[Math.min(lo + 1, pts.length - 1)];
  const seg = cum[Math.min(lo + 1, cum.length - 1)] - cum[lo];
  const f = seg > 0 ? (d - cum[lo]) / seg : 0;
  let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    z: a.z + (b.z - a.z) * f,
    dx, dy, dz,
    kind: (f < 0.5 ? a.kind : b.kind) || 'ground',
  };
}
