// THE CONTRACT. Five modules are built in parallel against these shapes:
//   src/wiki/index.js    createWiki()                      -> WikiApi
//   src/world/index.js   createWorld({ seed })             -> World      (pure logic, no three.js, no DOM)
//   src/sim/index.js     createGame({ wiki, world, seed }) -> Game       (pure logic, no three.js, no DOM)
//   src/render/index.js  createRenderer({ container, game, world }) -> Renderer  (three.js)
//   src/ui/index.js      createUI({ root, game, renderer }) -> UI        (DOM overlay)
// src/main.js wires them and runs the frame loop: game.update(dt); renderer.update(dt); ui.update(dt).
// This file has no runtime exports; it is documentation that tools can type-check.
//
// GAME IN ONE PARAGRAPH: single-player real-time tycoon. Stations are Wikipedia articles.
// Track may only be laid from a built station to an article that station's article links to.
// "Thoughts" (passengers) appear at stations wanting to reach some article a few links away;
// the player works out the link path, builds track, draws lines, buys trains, and earns a fare
// on delivery. Stations also earn a trickle for links no earlier station covered. Upkeep
// inflates over time; the run ends in bankruptcy. Landscape is scenery that only changes
// track price (bridges, tunnels, ledges).
//
// TITLES: every title anywhere in these shapes is a canonical, redirect-resolved Wikipedia
// title with spaces (never underscores). A title is the identity of an article/station.

/** @typedef {'article'|'list'|'disambiguation'} PageKind */

/**
 * Cheap facts about an article, available for many titles in one batched request.
 * @typedef {Object} ArticleStub
 * @property {string} title
 * @property {PageKind} kind
 * @property {string} description   short description, '' if none
 * @property {number} popularity    0..1, log-scaled from recent page views; drives station price
 */

/**
 * @typedef {ArticleStub & {
 *   summary: string,          plain-text first paragraph
 *   thumbnail: string|null,   image URL
 *   url: string,              article URL on wikipedia.org
 *   leadLinks: string[],      links in the lead section, in reading order, main namespace only,
 *                             deduped, no self-link, at most WIKI.maxLeadLinks
 *   links: string[],          every outbound main-namespace link, deduped, at most WIKI.maxLinks;
 *                             always a superset of leadLinks
 * }} Article
 */

/**
 * @typedef {Object} WikiApi
 * @property {() => Promise<Article>} randomStart
 *   A good starting article: kind 'article', >= WIKI.startMinLeadLinks lead links,
 *   >= WIKI.startMinLinks links, and reasonably well known (best of a random sample).
 * @property {(title: string) => Promise<Article>} getArticle   Rejects if the page does not exist.
 * @property {(titles: string[]) => Promise<Map<string, ArticleStub>>} getStubs
 *   Batched. Keyed by the title as requested; stub.title is the canonical title. Missing pages are omitted.
 */

// ---------------------------------------------------------------- world

/**
 * Where a station sits. Position is decided by links, never by chance: see World.placeGhosts.
 * @typedef {Object} Placement
 * @property {string} title
 * @property {number} q
 * @property {number} r
 * @property {'ghost'|'built'} state
 * @property {string|null} parent   title of the station whose link first put it on the map
 */

/**
 * One hex of scenery. Immutable once generated.
 * @typedef {Object} Tile
 * @property {number} q
 * @property {number} r
 * @property {string} biome       one of BIOMES
 * @property {number} elevation   world-unit height of the tile's top surface, 0..WORLD.maxElevation
 * @property {boolean} water      river or lake; track crosses it on a bridge
 * @property {number} detail      0..1 deterministic per-tile value for the renderer to vary props
 */

/**
 * @typedef {Object} RoutePoint
 * @property {number} x
 * @property {number} y   rail height
 * @property {number} z
 * @property {'ground'|'ledge'|'bridge'|'tunnel'} kind
 */

/**
 * A stretch of track between two stations.
 * @typedef {Object} Route
 * @property {string} from
 * @property {string} to
 * @property {'cheap'|'direct'} style
 * @property {{q:number, r:number, kind:'ground'|'ledge'|'bridge'|'tunnel'}[]} hexes  from -> to, inclusive of both station hexes
 * @property {RoutePoint[]} points  dense, already-smoothed centreline polyline from -> to (about 8 points per hex).
 *                                  Everyone positions things on it with sampleRoute() from src/route.js.
 * @property {number} length        world-unit length of `points`
 * @property {number} cost          construction cost before inflation: sum of ECON.trackCostPerHex over hexes
 */

/**
 * @typedef {Object} World
 * @property {Map<string, Placement>} placements   every station on the map, ghost or built
 * @property {(title: string) => {placement: Placement, revealed: Tile[]}} placeStart
 *   Puts the first station at (0, 0) as 'built' and reveals WORLD.revealStation around it.
 * @property {(parentTitle: string, titles: string[]) => {placements: Placement[], revealed: Tile[]}} placeGhosts
 *   Puts the parent's links on the map as ghosts, in the order given (reading order).
 *   Titles already placed are left where they are and not returned. Deterministic: the same
 *   parent, titles and existing map always give the same positions. Earlier links sit nearer
 *   (WORLD.ghostMinDist) and later ones farther (WORLD.ghostMaxDist); the fan points away from
 *   the parent's own parent so the network grows outward; stations keep WORLD.minStationSpacing.
 * @property {(title: string) => {revealed: Tile[]}} setBuilt   ghost -> built; reveals WORLD.revealStation.
 * @property {(fromTitle: string, toTitle: string) => {cheap: Route, direct: Route, same: boolean}} findRoutes
 *   cheap = lowest construction cost (winds round water and high ground);
 *   direct = shortest, bridging and tunnelling as needed. `same` when both are the same path.
 *   Routes never pass through a third station's hex. Throws if either title is not placed.
 * @property {(route: Route) => {revealed: Tile[]}} commitRoute   Records the track; reveals WORLD.revealTrack along it.
 * @property {(q: number, r: number) => Tile} terrainAt           Any hex, revealed or not.
 * @property {(q: number, r: number) => boolean} isRevealed
 * @property {() => Tile[]} revealedTiles
 */

// ---------------------------------------------------------------- sim

/** @typedef {{ok: true} | {ok: false, reason: string}} Result   reason is a short sentence the UI shows as-is */

/**
 * @typedef {Object} Station
 * @property {string} title
 * @property {Article} article
 * @property {number} q
 * @property {number} r
 * @property {number} uniqueLinks    links no earlier-built station had; fixed when built
 * @property {number} incomePerMin   uniqueLinks * ECON.linkIncomePerUniqueLinkPerMin (0 for list/disambiguation)
 * @property {number[]} waiting      ids of thoughts waiting on the platform
 * @property {number} builtAt        game time, seconds
 */

/**
 * @typedef {Object} Track
 * @property {number} id
 * @property {string} from   == route.from
 * @property {string} to     == route.to
 * @property {Route} route
 */

/**
 * A service the player drew: trains shuttle end to end and back, stopping at every station.
 * @typedef {Object} Line
 * @property {number} id
 * @property {string} name
 * @property {string} color        from LINE_COLORS
 * @property {string[]} stations   >= 2 built stations; each consecutive pair is joined by a Track
 * @property {number[]} trainIds
 */

/**
 * @typedef {Object} Train
 * @property {number} id
 * @property {string} typeId       key of TRAIN_TYPES
 * @property {number} lineId
 * @property {'moving'|'dwelling'} state
 * @property {number} trackId      track it is on, or about to leave along when dwelling
 * @property {number} t            0..1 along that track's route, measured from route.from
 * @property {boolean} forward     true when travelling route.from -> route.to
 * @property {string} atStation    last station stopped at (current one when dwelling)
 * @property {number[]} passengers thought ids on board
 */

/**
 * @typedef {Object} Thought
 * @property {number} id
 * @property {string} from          station where it appeared
 * @property {string} to            destination article title (may not be on the map yet)
 * @property {string} toDescription short description of the destination, '' if none
 * @property {number} hops          link distance used to price it
 * @property {number} fare          paid if delivered now (falls toward fareMinFraction as patience runs out)
 * @property {number} patience      seconds left
 * @property {number} patienceMax
 * @property {'waiting'|'riding'|'delivered'|'lost'} state
 * @property {string|null} at       station title while waiting
 * @property {number|null} trainId  while riding
 */

/**
 * Read-only for everyone but the sim. Objects are mutated in place between frames.
 * @typedef {Object} GameState
 * @property {'idle'|'loading'|'running'|'over'} phase
 * @property {number} time          game seconds elapsed
 * @property {number} speed         0 (paused), 1, 2 or 4
 * @property {number} money
 * @property {number} score
 * @property {number} inflation     current multiplier, >= 1
 * @property {number} incomePerMin  link income only
 * @property {number} upkeepPerMin  track + trains, after inflation
 * @property {number} faresPerMin   rolling average over the last 60 game seconds
 * @property {number} delivered
 * @property {number} lost
 * @property {number} reputation    0..1; fast deliveries raise it, thoughts that give up lower it. Scales fares
 *                                  and how many thoughts appear (ECON.reputation*)
 * @property {number} uniqueLinks   total across all stations
 * @property {number|null} bankruptIn  seconds until bankruptcy while money < 0, else null
 * @property {string[]} unlockedTrainTypes
 * @property {{uniqueLinks: number, unlock: string}|null} nextMilestone
 * @property {Map<string, Station>} stations   built stations by title
 * @property {Map<string, ArticleStub>} stubs  facts for every title on the map, ghost or built
 * @property {Track[]} tracks
 * @property {Line[]} lines
 * @property {Train[]} trains
 * @property {Thought[]} thoughts   waiting and riding only; finished thoughts are removed
 */

/**
 * @typedef {Object} Quote
 * @property {'cheap'|'direct'} style
 * @property {Route} route
 * @property {number} trackCost     after inflation
 * @property {number} stationCost   after inflation; 0 when the destination is already built
 * @property {number} total
 * @property {boolean} affordable
 */

/**
 * EVENTS (game.on(name, handler) returns an unsubscribe function):
 *   'started'          { station: Station }
 *   'tilesRevealed'    { tiles: Tile[] }
 *   'ghostsAdded'      { placements: Placement[] }
 *   'stationBuilt'     { station: Station, track: Track }
 *   'trackBuilt'       { track: Track }                  (also fired with stationBuilt)
 *   'thoughtSpawned'   { thought: Thought }
 *   'thoughtBoarded'   { thought: Thought, train: Train }
 *   'thoughtDelivered' { thought: Thought, fare: number, station: string }
 *   'thoughtLost'      { thought: Thought }
 *   'linesChanged'     { }
 *   'trainsChanged'    { }
 *   'milestone'        { unlock: string, uniqueLinks: number }
 *   'toast'            { text: string, tone: 'info'|'good'|'bad' }
 *   'gameOver'         { score: number, time: number, delivered: number, stations: number }
 *
 * @typedef {Object} Game
 * @property {GameState} state
 * @property {(name: string, handler: (payload: any) => void) => () => void} on
 * @property {() => Promise<void>} start
 *   phase 'loading' -> picks wiki.randomStart(), places it, adds its ghosts, phase 'running'. Fires 'started'.
 * @property {(dt: number) => void} update   dt in real seconds; the sim multiplies by state.speed.
 * @property {(speed: number) => void} setSpeed
 * @property {(fromTitle: string, toTitle: string) => ({ok: true, cheap: Quote, direct: Quote, same: boolean} | {ok: false, reason: string})} quoteBuild
 *   from must be built; to must be on the map; from's article must link to `to`
 *   (or, when both are built, either may link to the other); no track may already join them.
 * @property {(fromTitle: string, toTitle: string, style: 'cheap'|'direct') => Promise<Result>} build
 *   Pays, lays the track, and if `to` was a ghost: loads its article, builds the station, adds its ghosts.
 * @property {(fromTitle: string, linkTitle: string) => Promise<Result>} survey
 *   Puts any one of a built station's links on the map as a ghost (free), so it can be built to.
 * @property {(stations: string[]) => (Result & {line?: Line})} createLine
 * @property {(lineId: number, stations: string[]) => Result} setLineStations   Trains on it restart from the first stop.
 * @property {(lineId: number) => Result} deleteLine   Sells its trains at ECON.sellRefund.
 * @property {(typeId: string, lineId: number) => (Result & {train?: Train})} buyTrain
 * @property {(trainId: number) => Result} sellTrain
 * @property {(a: string, b: string) => Track|null} trackBetween   in either direction
 */

// ---------------------------------------------------------------- render

/**
 * @typedef {{kind: 'station'|'ghost', title: string} | {kind: 'train', trainId: number} | {kind: 'thought', thoughtId: number} | {kind: 'none'}} Pick
 *   'thought' is a click on a passenger waiting on a platform.
 *
 * The renderer subscribes to game events itself and reads game.state every frame.
 * @typedef {Object} Renderer
 * @property {(dt: number) => void} update          real seconds
 * @property {(handler: (pick: Pick) => void) => () => void} onPick   click (not drag) on the 3D view
 * @property {(title: string|null) => void} setSelection   ring/highlight on one station or ghost
 * @property {(thoughtId: number|null) => void} setThoughtSelection   the station's speech bubble follows this waiting passenger
 * @property {(routes: Route[]|null, activeStyle?: 'cheap'|'direct') => void} setRoutePreview
 *   Draws proposed routes over the terrain; the active one bright, the other dim.
 * @property {(lineId: number|null) => void} setLineHighlight
 * @property {(title: string) => void} focus        glide the camera to a station or ghost
 * @property {(trainId: number|null) => void} follow   ride-along camera; null returns to free orbit
 * @property {() => void} dispose
 */

// ---------------------------------------------------------------- ui

/**
 * The UI owns the start screen (calls game.start()), HUD, thought board, station card,
 * build panel, lines and trains panel, toasts and the game-over screen. It calls Game
 * actions and Renderer methods; nothing calls into it except update().
 * @typedef {Object} UI
 * @property {(dt: number) => void} update   real seconds; refresh live numbers
 */

export {};
