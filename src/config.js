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
  revealGhost: -1,          // tiles revealed around an unbuilt link's reserved spot; -1 = none (nothing shows in the fog)
  maxElevation: 4,          // world units
  laneSpacing: 0.26,        // world units between parallel tracks in a shared corridor
  maxLanesPerSide: 1,       // a corridor holds the first track plus this many each side (a rare fallback)
  laneCostFactor: 0.9,      // laying track beside existing track costs this share of the hex price
  sharedCostFactor: 0.15,   // running on rails that are already there costs this share: joining and forking is the cheap way
  crossingClearance: 0.6,   // least height between two rails where one track crosses over another
};

export const ECON = {
  startMoney: 600,
  stationBaseCost: 55,
  stationPopularityCost: 190,       // + popularity (0..1) * this
  specialPageCostMult: 5,           // lists and disambiguation pages
  trackCostPerHex: { ground: 13, ledge: 16, bridge: 27, tunnel: 35 },
  overheadPerMin: 36,               // what the company costs to run once the clock starts, whatever its size (times inflation)
  trackUpkeepPerHexPerMin: 2.3,
  linkIncomePerUniqueLinkPerMin: 0.05,  // the steady trickle: each station pays for the links its page has
  fareBase: 6,
  farePerHop: 6,
  fareHopExponent: 1.2,
  fareMinFraction: 0.5,             // fare paid when patience is nearly gone
  patienceBase: 150,                // seconds
  patiencePerHop: 60,
  spawnIntervalBase: 30,            // seconds between thoughts with one station
  spawnIntervalPerStation: 0.6,     // seconds shaved per built station
  spawnIntervalMin: 10,
  maxWaitingPerStation: 12,
  deliveriesPerDepthStep: 6,        // destination depth = 1 + floor(delivered / this)
  maxDepth: 6,
  inflationRate: 0.022,              // multiplier = 1 + rate * minutes ^ exponent
  inflationExponent: 1.55,         // applied to all upkeep and all build prices
  // Reputation (0..1): fast deliveries raise it, thoughts that give up lower it. It scales
  // both what passengers will pay and how many turn up, from the Min to the Max multiplier.
  reputationStart: 0.5,
  reputationPerDelivery: 0.03,      // at full patience; a quarter of this when patience is gone
  reputationPerLost: 0.012,
  reputationFareMin: 0.7,
  reputationFareMax: 1.3,
  reputationCrowdMin: 0.7,
  reputationCrowdMax: 1.3,
  // Rewards. A goal pays at once; so does opening a route passengers were waiting for.
  routeBonusFraction: 0.5,          // of each waiting passenger's fare, when their destination is built
  streakFarePerStep: 0.04,          // extra fare per delivery in a row without a passenger giving up
  streakFareMax: 0.4,
  builtDestinationShare: 0.55,      // share of new passengers who want a station that already exists
  goalRewardBase: 40,
  // Tickets: routes to find and build. Never more than maxTickets at once.
  maxTickets: 3,
  ticketBase: 130,                  // a ticket is the big bonus: reward = (base + perLink * links) * inflation when issued
  ticketPerLink: 370,
  ticketMaxLinks: 5,                // the furthest a ticket ever reaches; how far it really reaches follows the player's skill
  ticketSecondsBase: 420,           // time before a ticket is withdrawn
  ticketSecondsPerLink: 240,
  surveyorCost: 250,                 // gold (times inflation) for a surveyor to show the next article towards a ticket
  surveyorSeconds: 60,              // how long a surveyor works before revealing what they found
  // Tickets scale with the player: a skill number sets how many links away the next ticket is.
  ticketSkillStart: 2,              // links away, once the very first ticket (always one link) is out
  ticketSkillFast: 0.6,             // gained for a ticket met with more than half its time left
  ticketSkillSlow: 0.3,             // gained for a ticket met later than that
  ticketSkillExpired: 0.7,          // lost when a ticket runs out
  ticketShorterChance: 0.3,         // share of tickets drawn one link shorter than the skill allows, for variety
  // Express tickets turn up unannounced: a bigger prize on a shorter clock.
  expressTicketChance: 0.2,
  expressRewardMult: 2,
  expressTimeMult: 0.6,
  // Surprises: gold nobody promised, paid at once (amounts times inflation).
  surpriseFindChance: 0.16,         // a new station turns something up
  surpriseFindMin: 40,
  surpriseFindMax: 160,
  surpriseJackpotChance: 0.04,      // a new station turns up something big
  surpriseJackpot: 450,
  surpriseTipChance: 0.15,          // a ticket's passenger tips on arrival
  surpriseTipFraction: 0.3,         // of the ticket's reward
  ticketGapSeconds: 20,              // pause before a new ticket replaces one that is gone
  paydaySeconds: 10,                // money arrives in one lump this often
  bankruptcyGraceSeconds: 45,
  dwellSeconds: 3,
  score: { perDelivered: 10, perStation: 25, perUniqueLink: 0.1, perTicket: 60 },
};

// speed is world units per second along the track centreline.
// One train serves each track. `blurb` is shown on the upgrade tag; `color` paints the train.
export const TRAIN_TYPES = {
  local:   { id: 'local',   name: 'Local',   blurb: 'carries 4',            cost: 120, speed: 0.85, capacity: 4,  upkeepPerMin: 12,  cars: 2, color: '#e4572e' },
  express: { id: 'express', name: 'Express', blurb: 'carries 6, faster',    cost: 320, speed: 1.4, capacity: 6,  upkeepPerMin: 20, cars: 3, color: '#2e86ab' },
  freight: { id: 'freight', name: 'Freight', blurb: 'carries 16, slower',   cost: 520, speed: 1.1, capacity: 16, upkeepPerMin: 28, cars: 5, color: '#76b041' },
  bullet:  { id: 'bullet',  name: 'Bullet',  blurb: 'carries 6, very fast', cost: 520, speed: 2.5, capacity: 6,  upkeepPerMin: 28, cars: 3, color: '#f3a712' },
};
// What a track can be upgraded to from each level (index = current level). The last step is a choice.
export const TRACK_UPGRADES = [['local'], ['express'], ['freight', 'bullet'], []];


export const WIKI = {
  apiUrl: 'https://en.wikipedia.org/w/api.php',
  maxLeadLinks: 16,
  maxLinks: 1500,
  startMinLeadLinks: 8,
  startMinLinks: 60,
};
