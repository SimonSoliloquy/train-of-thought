// Shared constants. Key NAMES are part of the contract (see types.js); only the
// sim agent may tune the VALUES in ECON and TRAIN_TYPES.

export const HEX_SIZE = 1; // centre-to-corner, world units; pointy-top axial grid

// Scenery only: biomes affect looks and which track kinds a route needs, nothing else.
export const BIOMES = ['grassland', 'forest', 'jungle', 'desert', 'mountains', 'riverlands', 'canyon'];

export const TRACK_KINDS = ['ground', 'ledge', 'bridge', 'tunnel'];

export const WORLD = {
  ghostsPerStation: 8,     // lead links shown on the map when a station is built
  ghostMinDist: 4,          // hexes from the linking station (first lead link)
  ghostMaxDist: 8,          // hexes from the linking station (last lead link)
  minStationSpacing: 3,     // hexes between any two stations
  revealStation: 3,         // tiles revealed around a built station
  revealTrack: 2,           // tiles revealed along committed track
  revealGhost: 1,           // tiles revealed around a ghost station
  maxElevation: 4,          // world units
};

export const ECON = {
  startMoney: 1000,
  stationBaseCost: 40,
  stationPopularityCost: 160,       // + popularity (0..1) * this
  specialPageCostMult: 5,           // lists and disambiguation pages
  trackCostPerHex: { ground: 10, ledge: 22, bridge: 35, tunnel: 50 },
  trackUpkeepPerHexPerMin: 1.6,
  linkIncomePerUniqueLinkPerMin: 0.01,
  fareBase: 50,
  farePerHop: 50,
  fareHopExponent: 1.2,
  fareMinFraction: 0.5,             // fare paid when patience is nearly gone
  patienceBase: 150,                // seconds
  patiencePerHop: 60,
  spawnIntervalBase: 12,            // seconds between thoughts with one station
  spawnIntervalPerStation: 0.8,     // seconds shaved per built station
  spawnIntervalMin: 3,
  maxWaitingPerStation: 8,
  deliveriesPerDepthStep: 6,        // destination depth = 1 + floor(delivered / this)
  maxDepth: 6,
  inflationRate: 0.02,              // multiplier = 1 + rate * minutes ^ exponent
  inflationExponent: 1.6,          // applied to all upkeep and all build prices
  // Reputation (0..1): fast deliveries raise it, thoughts that give up lower it. It scales
  // both what passengers will pay and how many turn up, from the Min to the Max multiplier.
  reputationStart: 0.5,
  reputationPerDelivery: 0.03,      // at full patience; a quarter of this when patience is gone
  reputationPerLost: 0.03,
  reputationFareMin: 0.7,
  reputationFareMax: 1.3,
  reputationCrowdMin: 0.7,
  reputationCrowdMax: 1.3,
  bankruptcyGraceSeconds: 20,
  sellRefund: 0.5,
  dwellSeconds: 1.5,
  milestones: [
    { uniqueLinks: 2000, unlock: 'express' },
    { uniqueLinks: 5000, unlock: 'hauler' },
  ],
  score: { perDelivered: 10, perStation: 25, perUniqueLink: 0.1 },
};

// speed is world units per second along the track centreline.
export const TRAIN_TYPES = {
  local:   { id: 'local',   name: 'Local',   cost: 120, speed: 1.6, capacity: 4,  upkeepPerMin: 8,  cars: 2 },
  express: { id: 'express', name: 'Express', cost: 320, speed: 3.2, capacity: 4,  upkeepPerMin: 14, cars: 2 },
  hauler:  { id: 'hauler',  name: 'Hauler',  cost: 380, speed: 1.3, capacity: 12, upkeepPerMin: 14, cars: 4 },
};
export const STARTING_TRAIN_TYPES = ['local'];

export const LINE_COLORS = ['#e4572e', '#2e86ab', '#f3a712', '#76b041', '#a23b72', '#17bebb', '#8d6a9f', '#d1495b'];

export const WIKI = {
  apiUrl: 'https://en.wikipedia.org/w/api.php',
  maxLeadLinks: 16,
  maxLinks: 1500,
  startMinLeadLinks: 8,
  startMinLinks: 60,
};
