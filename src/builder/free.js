// Train Track Builder: nothing costs anything. This module is imported first, so the shared
// numbers are already zero when the rules and the renderer load.
import { ECON, TRAIN_TYPES } from '../config.js';

ECON.startMoney = 1e9;
ECON.stationBaseCost = 0;
ECON.stationPopularityCost = 0;
for (const k of Object.keys(ECON.trackCostPerHex)) ECON.trackCostPerHex[k] = 0;
ECON.overheadPerMin = 0;
ECON.trackUpkeepPerHexPerMin = 0;
ECON.inflationRate = 0;
ECON.goalRewardBase = 0;
ECON.maxTickets = 0; // no tickets: passengers only ride between stations that exist
for (const t of Object.values(TRAIN_TYPES)) {
  t.cost = 0;
  t.upkeepPerMin = 0;
}
