// Goals: one at a time, in plain words. The first few teach the game; after that they alternate
// "deliver N more passengers" and "grow to N stations" for ever, paying more each step.
// Pure functions: the sim owns when a goal is checked and when its reward is paid.
import { ECON } from '../config.js';

// What the sim tells us about itself: { stations, delivered, maxLevel }.
const TEACHING = [
  {
    id: 'first-station',
    text: 'Build your first station',
    how: 'Click a signpost by your station, then Build',
    target: 1,
    rewardMult: 1,
    measure: (m) => m.stations - 1,
  },
  {
    id: 'first-train',
    text: 'Put a train on the track',
    how: 'Click the price tag floating over the track',
    target: 1,
    rewardMult: 1,
    measure: (m) => (m.maxLevel >= 1 ? 1 : 0),
  },
  {
    id: 'first-delivery',
    text: 'Deliver a passenger',
    how: 'Build the station a passenger asks for, and put a train on the way',
    target: 1,
    rewardMult: 1.5,
    measure: (m) => m.delivered,
  },
  {
    id: 'four-stations',
    text: 'Grow to 4 stations',
    how: 'Signposts with waiting passengers pay a bonus',
    target: 4,
    rewardMult: 1.5,
    measure: (m) => m.stations,
  },
  {
    id: 'first-express',
    text: 'Upgrade a track to Express',
    how: 'Click the Express tag on a busy track',
    target: 1,
    rewardMult: 2,
    measure: (m) => (m.maxLevel >= 2 ? 1 : 0),
  },
];

export const TEACHING_GOALS = TEACHING.length;

const DELIVER_TARGETS = [5, 8, 12, 16];

/** Passengers to deliver in the m-th (0-based) "deliver" goal: 5, 8, 12, 16, 20, 24, ... */
export function deliverTarget(m) {
  return m < DELIVER_TARGETS.length ? DELIVER_TARGETS[m] : DELIVER_TARGETS[DELIVER_TARGETS.length - 1] + 4 * (m - DELIVER_TARGETS.length + 1);
}

/** Reward of the n-th (0-based) goal after the teaching ones, before inflation. */
export function repeatingReward(n) {
  return ECON.goalRewardBase * (2 + 0.5 * n);
}

/**
 * Builds goal number `index` (0-based) as it becomes current.
 * @param {number} index
 * @param {{stations:number, delivered:number, maxLevel:number}} m  the game right now
 * @param {number} inflation
 * @returns {{goal: import('../types.js').Goal, measure: (m:any)=>number}}
 */
export function makeGoal(index, m, inflation) {
  if (index < TEACHING.length) {
    const g = TEACHING[index];
    return {
      goal: { id: g.id, text: g.text, how: g.how, progress: 0, target: g.target, reward: Math.round(ECON.goalRewardBase * g.rewardMult) },
      measure: g.measure,
    };
  }
  const n = index - TEACHING.length;
  const reward = Math.round(repeatingReward(n) * inflation);
  if (n % 2 === 0) {
    const target = deliverTarget(n / 2);
    const base = m.delivered;
    return {
      goal: {
        id: `deliver-${target}`,
        text: `Deliver ${target} more passengers`,
        how: 'Put trains on the tracks passengers are waiting for',
        progress: 0,
        target,
        reward,
      },
      measure: (x) => x.delivered - base,
    };
  }
  const target = m.stations + 3;
  return {
    goal: {
      id: `stations-${target}`,
      text: `Grow to ${target} stations`,
      how: 'Signposts with waiting passengers pay a bonus',
      progress: 0,
      target,
      reward,
    },
    measure: (x) => x.stations,
  };
}
