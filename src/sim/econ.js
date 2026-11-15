// Pure economy formulas. Everything that turns ECON numbers into prices, fares and timings.
import { ECON } from '../config.js';

export const isSpecialKind = (kind) => kind === 'list' || kind === 'disambiguation';

/** Upkeep and price multiplier at a game time in seconds. */
export function inflationAt(timeSeconds) {
  const minutes = Math.max(0, timeSeconds) / 60;
  return 1 + ECON.inflationRate * Math.pow(minutes, ECON.inflationExponent);
}

/** Game seconds between thoughts for a network of `stationCount` built stations. */
export function spawnInterval(stationCount) {
  return Math.max(
    ECON.spawnIntervalMin,
    ECON.spawnIntervalBase - ECON.spawnIntervalPerStation * (Math.max(1, stationCount) - 1),
  );
}

export function targetDepth(delivered) {
  return Math.min(ECON.maxDepth, 1 + Math.floor(delivered / ECON.deliveriesPerDepthStep));
}

export function baseFare(hops) {
  return ECON.fareBase + ECON.farePerHop * Math.pow(hops, ECON.fareHopExponent);
}

export function patienceFor(hops) {
  return ECON.patienceBase + ECON.patiencePerHop * hops;
}

/** Fare paid now: linear from base at full patience down to base * fareMinFraction at zero. */
export function liveFare(base, patience, patienceMax) {
  const f = patienceMax > 0 ? Math.min(1, Math.max(0, patience / patienceMax)) : 0;
  return base * (ECON.fareMinFraction + (1 - ECON.fareMinFraction) * f);
}

/** Station price before inflation. `stub` may be missing (treated as popularity 0.5, kind article). */
export function stationBaseCost(stub) {
  const pop = stub && Number.isFinite(stub.popularity) ? stub.popularity : 0.5;
  const mult = stub && isSpecialKind(stub.kind) ? ECON.specialPageCostMult : 1;
  return (ECON.stationBaseCost + pop * ECON.stationPopularityCost) * mult;
}

export function incomePerMinFor(kind, uniqueLinks) {
  return isSpecialKind(kind) ? 0 : uniqueLinks * ECON.linkIncomePerUniqueLinkPerMin;
}

export function scoreFor(delivered, stations, uniqueLinks, tickets = 0) {
  const s = ECON.score;
  return Math.round(delivered * s.perDelivered + stations * s.perStation + uniqueLinks * s.perUniqueLink + tickets * (s.perTicket || 0));
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Fare multiplier for a reputation in 0..1. */
export function reputationFareMult(rep) {
  return ECON.reputationFareMin + (ECON.reputationFareMax - ECON.reputationFareMin) * clamp01(rep);
}

/** How many more (or fewer) thoughts turn up for a reputation in 0..1. */
export function reputationCrowdMult(rep) {
  return ECON.reputationCrowdMin + (ECON.reputationCrowdMax - ECON.reputationCrowdMin) * clamp01(rep);
}

/** Reputation after a delivery made with `patienceFrac` (0..1) of the passenger's patience left. */
export function reputationAfterDelivery(rep, patienceFrac) {
  return clamp01(rep + ECON.reputationPerDelivery * (0.25 + 0.75 * clamp01(patienceFrac)));
}

/** Reputation after a waiting thought gives up. */
export function reputationAfterLoss(rep) {
  return clamp01(rep - ECON.reputationPerLost);
}

/** Fare multiplier for a delivery made after `streak` earlier deliveries in a row. */
export function streakFareMult(streak) {
  return 1 + Math.min(ECON.streakFareMax, ECON.streakFarePerStep * Math.max(0, streak));
}

/** Gold paid at once for one waiting passenger when their destination is built. */
export function routeBonusFor(fare) {
  return ECON.routeBonusFraction * fare;
}
