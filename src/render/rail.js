// The contract's route centreline is the rail-top line at ground level on open track.
// Ballast and sleepers hang below the rail top, so the view lifts everything that sits on
// a track (rails, bridges, trains, highlights) by the same small amount to keep the
// trackbed above the tile surface.
import { sampleRoute as sampleRaw, routeLength } from '../route.js';

export const RAIL_LIFT = 0.075;

export function sampleRoute(route, t) {
  const p = sampleRaw(route, t);
  p.y += RAIL_LIFT;
  return p;
}

export { routeLength };
