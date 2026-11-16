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
 *   links: string[],          every outbound main-namespace link IN ORDER OF APPEARANCE on the page,
 *                             deduped, at most WIKI.maxLinks; always contains every lead link
 * }} Article
 */

/**
 * @typedef {Object} WikiApi
 * @property {() => Promise<Article>} randomStart
 *   A good starting article: kind 'article', >= WIKI.startMinLeadLinks lead links,
 *   >= WIKI.startMinLinks links, and reasonably well known (best of a random sample).
 * @property {(title: string) => Promise<Article>} getArticle   Rejects if the page does not exist.
 * @property {(title: string) => Promise<string>} getArticleHtml   The article's HTML as Wikipedia renders it.
 *   Untrusted markup: the UI sanitises it (src/ui/sanitize.js) before putting it on the page.
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
 * @property {{q:number, r:number, kind:'ground'|'ledge'|'bridge'|'tunnel', shared?: boolean, lane?: number, over?: boolean, under?: boolean}[]} hexes
 *   from -> to, inclusive of both station hexes. Tracks never lie on top of one another:
 *   - `lane` (absent or 0 = the hex's own centreline): this track runs ALONGSIDE track that was already
 *     there, as the next parallel track of a shared corridor. +n / -n is the n-th track to the right /
 *     left of the first track's centreline, WORLD.laneSpacing apart. A route joins a corridor, runs
 *     beside the other track, and splits off again (combine and split); `points` already carry the offset.
 *   - `over`: here the track crosses ABOVE another track on a short bridge (kind 'bridge'), with at least
 *     WORLD.crossingClearance of height between the two rails. `under`: it crosses BELOW another track.
 *   - `shared`: here the track runs ON the rails of track that was already there. A route JOINS existing
 *     track at a junction, runs along it, and FORKS off again; `points` coincide with that track's
 *     centreline for the shared stretch and curve away smoothly at the fork. This is the preferred
 *     way for routes to combine: sharing rails costs only WORLD.sharedCostFactor of the hex price and
 *     no extra upkeep, so routes join a trunk and fork rather than run beside it. Trains of different
 *     tracks use the same rails there. A parallel `lane` is a rare fallback.
 *   Two tracks only share a centreline along `shared` hexes and inside a station hex.
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
 * @property {(title: string, links: string[]) => void} [noteLinks]
 *   Optional. The sim calls it when a station is built (before placeGhosts for that station), with
 *   the article's full link list. The layout uses it so that an unbuilt link sits towards the other
 *   built stations that also link to it: direction on the map reflects how articles are related.
 *   Unbuilt placements are invisible reservations and MAY be moved by later noteLinks/placeGhosts
 *   calls; a built station never moves.
 * @property {(parentTitle: string, title: string, x: number, z: number) => {placement: Placement|null, revealed: Tile[]}} [placeAt]
 *   Optional (Rail Builder, github.com/SimonSoliloquy/railbuilder). An unbuilt spot on the acceptable hex nearest world point (x, z);
 *   unlike placeGhosts it is never moved afterwards. Null if the title is already placed.
 * @property {(title: string) => boolean} [dropGhost]   Optional. Removes an unbuilt spot again.
 * @property {(title: string) => {revealed: Tile[]}} setBuilt   ghost -> built; reveals WORLD.revealStation.
 * @property {(fromTitle: string, toTitle: string) => {cheap: Route, direct: Route, same: boolean}} findRoutes
 *   cheap = lowest construction cost (winds round water and high ground);
 *   direct = shortest, bridging and tunnelling as needed. `same` when both are the same path.
 *   Routes never pass through a third station's hex. Throws if either title is not placed.
 *   A route should JOIN existing track that goes its way and fork off where it must (hexes marked
 *   `shared`, WORLD.sharedCostFactor of the hex price); a parallel lane beside existing track
 *   (WORLD.laneCostFactor) is a rare fallback; and it must cross existing track at a different height
 *   (over or under), never at grade.
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
 * @property {number} incomePerMin   uniqueLinks * ECON.linkIncomePerUniqueLinkPerMin (0 for list/disambiguation);
 *                                   the UI shows it per payday (x ECON.paydaySeconds / 60)
 * @property {number[]} waiting      ids of thoughts waiting on the platform
 * @property {number} builtAt        game time, seconds
 */

/**
 * A stretch of track between two stations, and the one train that serves it. There are no
 * lines to draw: the player upgrades a track and its train shuttles between its two stations
 * on its own. Upgrades go one way: bare track -> local -> express -> then a CHOICE of final
 * train, freight (big, slower) or bullet (small, faster). See TRACK_UPGRADES in config.js.
 * @typedef {Object} Track
 * @property {number} id
 * @property {string} from   == route.from
 * @property {string} to     == route.to
 * @property {Route} route
 * @property {number} level           0 bare track (no train), 1 local, 2 express, 3 final train
 * @property {string|null} typeId     key of TRAIN_TYPES for the train serving it, null at level 0
 * @property {number|null} trainId    its train, null at level 0
 */

/**
 * @typedef {Object} Train
 * @property {number} id
 * @property {string} typeId       key of TRAIN_TYPES
 * @property {number} trackId      the one track it serves, for life
 * @property {'moving'|'dwelling'} state
 * @property {number} t            0..1 along the track's route, measured from route.from
 * @property {boolean} forward     true when travelling route.from -> route.to
 * @property {string} atStation    last station stopped at (current one when dwelling)
 * @property {number[]} passengers thought ids on board
 */

/**
 * What the next upgrade of a track would be. One option at levels 0 and 1, two at level 2.
 * @typedef {Object} UpgradeOption
 * @property {string} typeId     key of TRAIN_TYPES
 * @property {string} name       e.g. 'Local'
 * @property {string} blurb      a few words, e.g. 'carries 12, slower'
 * @property {number} cost       after inflation, whole number; exactly what upgradeTrack charges
 * @property {boolean} affordable
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
 * Money arrives in one lump every ECON.paydaySeconds game seconds, so the player sees a single
 * clear number: station income for the period, plus fares collected during it, minus running
 * costs for the period. Purchases are charged at once.
 * @typedef {Object} Payday
 * @property {number} period     ECON.paydaySeconds
 * @property {number} in         game seconds until the next payday
 * @property {number} income     station link income accrued so far this period
 * @property {number} fares      fares collected so far this period
 * @property {number} upkeep     running costs accrued so far this period (positive number)
 * @property {number} pending    income + fares - upkeep so far this period
 * @property {number} forecast   what this payday will pay if nothing else happens:
 *                               pending + the rest of the period at the current income and upkeep rates
 * @property {{amount: number, income: number, fares: number, upkeep: number, time: number}|null} last
 *                               the payday that just happened, null before the first
 */

/**
 * One goal at a time, in plain words, with a gold reward paid the moment it is met. The first
 * few teach the game in order (build a station, put a train on the track, deliver a passenger,
 * upgrade a track); after that they repeat and grow (deliver N, reach N stations).
 * @typedef {Object} Goal
 * @property {string} id
 * @property {string} text       what to do, e.g. 'Deliver 5 passengers'
 * @property {string} how        how to do it, in a few words, e.g. 'Click the price tag on a track'
 * @property {number} progress
 * @property {number} target
 * @property {number} reward     gold paid when progress reaches target
 */

/**
 * A ticket: a route for the player to find and build. There are never more than ECON.maxTickets
 * at once. `to` is always an article the player has NOT built; `from` is always a station the
 * player owns (its passenger waits there). The game does not say which links lead
 * there: working that out is the game. A ticket is met the moment both ends are stations joined
 * by track (every track has a train), and pays its reward in gold at once.
 * @typedef {Object} Ticket
 * @property {number} id
 * @property {string} from
 * @property {string} to
 * @property {string} fromDescription   short description, '' if none
 * @property {string} toDescription
 * @property {number} links      how many links the game knows a route to need, counted from the player's
 *                               network (a hint of distance, not the route)
 * @property {boolean} express   an express ticket: ECON.expressRewardMult the reward, on a shorter clock. They turn up
 *                               unannounced; the UI stamps them "Express".
 * @property {number} reward     whole gold paid if met now; falls towards half as time runs out
 * @property {number} time       game seconds left before the ticket is withdrawn (no penalty)
 * @property {number} timeMax
 * @property {number} surveyCost   gold a surveyor costs for this ticket right now
 * @property {{from: string, to: string, left: number, total: number}|null} surveying   a surveyor is at work at
 *                               station `from`; `left` seconds until they report (ECON.surveyorSeconds)
 * @property {{from: string, to: string}|null} hint   what a bought surveyor found: build `to` next, from your
 *                               station `from`. Cleared once `to` is built (another surveyor can then be bought).
 */

/**
 * Read-only for everyone but the sim. Objects are mutated in place between frames.
 * @typedef {Object} GameState
 * @property {'idle'|'loading'|'running'|'over'} phase
 * @property {number} time          game seconds elapsed
 * @property {boolean} clockRunning  false until the player builds their first track: until then no time passes,
 *                                  nothing is paid or charged, and ticket timers do not run (tickets still arrive)
 * @property {number} speed         0 (paused), 1, 2 or 4
 * @property {number} money
 * @property {number} score
 * @property {number} inflation     current multiplier, >= 1
 * @property {Payday} payday      money changes at a payday, when the player buys something, and when a reward
 *                                (a goal or a route bonus) is paid, which is instant
 * @property {Ticket[]} tickets  at most ECON.maxTickets; the only requests the UI lists. Ordinary passengers
 *                                (state.thoughts) still ride between stations that exist, unlisted, for small fares
 * @property {Goal|null} goal     the one thing the game is asking for right now; doubles as the tutorial
 * @property {number} streak      deliveries in a row with no passenger giving up; each step adds
 *                                ECON.streakFarePerStep to fares, up to ECON.streakFareMax
 * @property {number} delivered
 * @property {number} lost
 * @property {number} reputation    0..1; fast deliveries raise it, thoughts that give up lower it. Scales fares
 *                                  and how many thoughts appear (ECON.reputation*)
 * @property {number} uniqueLinks   total across all stations
 * @property {number|null} bankruptIn  seconds until bankruptcy while money < 0, else null
 * @property {Map<string, Station>} stations   built stations by title
 * @property {Map<string, ArticleStub>} stubs  facts for every title on the map, ghost or built
 * @property {Track[]} tracks
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
 *   'thoughtDelivered' { thought: Thought, fare: number, station: string, streak: number }   (the fare, streak bonus
 *                      included, is banked for the next payday)
 *   'routeBonus'       { station: string, count: number, amount: number }   building a station that passengers were
 *                      waiting for pays ECON.routeBonusFraction of each one's fare at once
 *   'goalDone'         { goal: Goal, reward: number, next: Goal|null }
 *   'ticketAdded'      { ticket: Ticket }
 *   'ticketDone'       { ticket: Ticket, reward: number }     paid at once
 *   'ticketExpired'    { ticket: Ticket }
 *   'ticketHint'       { ticket: Ticket, hint: {from: string, to: string}|null }   a surveyor reported, or their advice was used
 *   'surprise'         { station: string, kind: 'find'|'jackpot'|'tip', text: string, amount: number }   unannounced gold,
 *                      already paid: a new station turned something up, or a ticket's passenger tipped
 *   'thoughtLost'      { thought: Thought }
 *   'trackUpgraded'    { track: Track, train: Train }
 *   'trainsChanged'    { }
 *   'payday'           { amount: number, income: number, fares: number, upkeep: number }
 *   'toast'            { text: string, tone: 'info'|'good'|'bad' }
 *   'gameOver'         { score: number, time: number, delivered: number, stations: number, tickets: number, start: string,
 *                        lineFrom: string|null, lineTo: string|null }
 *                      (tickets met, the article the run started on, and the run's longest train line: of every pair of
 *                      stations joined by built track, the pair whose shortest way along the track is longest in track
 *                      length (sum of route.length), see longestLine() in src/sim/line.js; both null with fewer than two
 *                      connected stations. It does not change the score.)
 *
 * @typedef {Object} Game
 * @property {GameState} state
 * @property {(name: string, handler: (payload: any) => void) => () => void} on
 * @property {() => Promise<void>} start   Called by the UI as soon as the page loads: there is no start button.
 *   phase 'loading' -> picks wiki.randomStart(), places it, adds its ghosts, phase 'running'. Fires 'started'.
 * @property {(dt: number) => void} update   dt in real seconds; the sim multiplies by state.speed.
 * @property {(speed: number) => void} setSpeed
 * @property {(fromTitle: string, toTitle: string) => ({ok: true, cheap: Quote, direct: Quote, same: boolean} | {ok: false, reason: string})} quoteBuild
 *   from must be built; to must be on the map; from's article must link to `to`
 *   (or, when both are built, either may link to the other); no track may already join them.
 * @property {(fromTitle: string, toTitle: string, style?: 'cheap'|'direct') => Promise<Result>} build
 *   style defaults to 'cheap'; the UI no longer offers a choice of route.
 *   Pays, lays the track, and if `to` was a ghost: loads its article, builds the station, adds its ghosts.
 * @property {(fromTitle: string, linkTitle: string) => Promise<Result>} survey
 *   Puts any one of a built station's links on the map as a ghost (free), so it can be built to.
 * @property {(trackId: number) => ({ok: true, options: UpgradeOption[]} | {ok: false, reason: string})} quoteUpgrade
 *   The next step for this track. ok:false with a reason when it is fully upgraded.
 * @property {(trackId: number, typeId?: string) => Result} upgradeTrack
 *   Pays and puts that train on the track (replacing the one there; its passengers get off at
 *   the station it last stopped at). typeId may be omitted when there is only one option.
 *   The new train starts running at once: there is nothing else to press.
 * @property {(ticketId: number) => Promise<Result & {hint?: {from: string, to: string}}>} buySurveyor
 *   Pays Ticket.surveyCost and sends a surveyor to work (Ticket.surveying). When they finish, Ticket.hint is
 *   set: the next article to build towards that ticket's destination and the station to build it from, and
 *   only then does that signpost turn gold. One step per purchase. Nothing else marks where a ticket leads:
 *   the player finds the way by reading the articles.
 * @property {(a: string, b: string) => Track|null} trackBetween   in either direction
 */

// ---------------------------------------------------------------- render

/**
 * @typedef {{kind: 'station'|'ghost', title: string} | {kind: 'train', trainId: number} | {kind: 'thought', thoughtId: number} | {kind: 'upgrade', trackId: number, typeId: string} | {kind: 'build', title: string} | {kind: 'article', title: string} | {kind: 'none'}} Pick
 *   'ghost' is a click on a link signpost (or the marker of the link being priced).
 *   'thought' is a click on a passenger waiting on a platform.
 *   'upgrade' is a click on a track's upgrade tag; the UI then calls game.upgradeTrack(trackId, typeId).
 *   'build' is a click on the Build button floating over the place being built towards.
 *   'article' is a click on the small picture floating over a station: the UI opens that article to read.
 *
 * The renderer subscribes to game events itself and reads game.state every frame.
 * It draws, without being asked:
 *   - shared rails drawn once: where a Route hex is `shared` the rails already exist, so nothing is drawn
 *     twice, and the place where a track joins or forks off reads as a junction (points/switch);
 *   - tracks that share a corridor side by side (Route hexes with `lane`) and crossings where one track
 *     bridges over another (`over` / `under`): a clear span with no pier standing on the lower track;
 *   - an upgrade tag floating over every track that can still be upgraded (from game.quoteUpgrade):
 *     the train's name and price, bright when affordable and dim when not, two tags side by side
 *     when there is a choice; tracks with an affordable upgrade are highlighted;
 *   - "+$N" rising from a station when a thought is delivered there ('thoughtDelivered'), with the
 *     streak when it is 2 or more; a bigger burst for 'routeBonus' and for 'goalDone';
 *   - over every built station, its article's picture (Station.article.thumbnail) as a very small card
 *     that floats and slowly turns; clicking it is Pick { kind: 'article', title };
 *   - a burst and "+N gold" for 'ticketDone';
 *   - every amount as gold, never dollars: "326 gold", "+140 gold";
 *   - on each link signpost: the price to build there (game.quoteBuild) and, when passengers are
 *     waiting to go there, how many and what they will pay; such signposts stand out.
 *     Signposts do NOT give away where tickets lead. The only gold signpost is one a paid surveyor has
 *     finished pointing at (Ticket.hint.to, shown at the station Ticket.hint.from): "Surveyor: build here next".
 * @typedef {Object} Renderer
 * @property {(dt: number) => void} update          real seconds
 * @property {(handler: (pick: Pick) => void) => () => void} onPick   click (not drag) on the 3D view
 * @property {(title: string|null) => void} setSelection   ring/highlight on one station, with its link signposts, or the marker of an unbuilt link
 * @property {(thoughtId: number|null) => void} setThoughtSelection   the station's speech bubble follows this waiting passenger
 * @property {(offer: {title: string, label: string, sub?: string, affordable?: boolean}|null) => void} setBuildOffer
 *   The one Build button. It floats on the map over the place being built towards (never in a side
 *   panel); a click on it arrives as Pick { kind: 'build', title }. null removes it.
 * @property {(routes: Route[]|null, activeStyle?: 'cheap'|'direct') => void} setRoutePreview
 *   Draws a proposed route over the terrain.
 * @property {(title: string) => void} focus        glide the camera to a station or ghost
 * @property {(trainId: number|null) => void} follow   ride-along camera; null returns to free orbit
 * @property {() => void} dispose
 */

// ---------------------------------------------------------------- ui

/**
 * As few buttons and as few numbers as possible; a new player must understand it without
 * reading instructions. Nothing permanent covers the map except small readouts at its edges.
 * The UI starts the game by itself on load (calls game.start()), and owns:
 *   - one small gold readout: gold, and what the next payday will bring, with its countdown;
 *   - one goal line (state.goal);
 *   - the tickets (state.tickets, at most three), always visible: from, to, how many links away,
 *     the reward, and the time left;
 *   - the article reader: opened only when the player clicks a station's floating picture
 *     (Pick 'article'), closed by Esc or a click outside it;
 *   - a small search box for a selected station's other links;
 *   - toasts, the game-over screen, sound effects.
 * There is NO build or buy button in the UI: the Build button floats on the map over the place
 * being built towards (renderer.setBuildOffer; Pick 'build'), and train upgrades are tags on the
 * tracks (Pick 'upgrade'). Amounts are gold, never dollars ("326 gold").
 * It calls Game actions and Renderer methods; nothing calls into it except update().
 * @typedef {Object} UI
 * @property {(dt: number) => void} update   real seconds; refresh live numbers
 */

/**
 * BOARDS. The game-over screen shows the best runs at once from this browser (src/ui/board.js,
 * localStorage key 'tot.runs', top 10) and then, when the shared Worker answers, the best runs of
 * everyone today (UTC, the server's day) and of all time (src/ui/remote-board.js). Without an answer
 * the local board stays: the screen never waits on the network and never shows an error for it.
 * Shared Worker: LEADERBOARD_URL in remote-board.js; public, no keys; this game only calls its
 * /train-of-thought/ routes. While the address holds the placeholder WORKER_SUBDOMAIN nothing is fetched.
 *   POST {url}/train-of-thought/submit  SubmittedRun -> SubmitAnswer   (never from localhost / 127.x / [::1])
 *   GET  {url}/train-of-thought/top?scope=daily|alltime&n=10 -> SharedRun[]
 * localStorage: 'tot.player' a random id for this browser; 'tot.name' the name last typed (optional).
 *
 * @typedef {Object} SubmittedRun
 * @property {string} player       random id kept in this browser
 * @property {string} name         0-20 characters, plain; '' = Anonymous (the server filters names too)
 * @property {number} score
 * @property {number} time         whole game seconds
 * @property {number} stations
 * @property {number} tickets
 * @property {number} delivered
 * @property {string} start        1-120 characters
 * @property {string|null} lineFrom
 * @property {string|null} lineTo
 *
 * @typedef {Object} SubmitAnswer   every field null when the server sent something else
 * @property {number|null} rankAllTime   1 = best
 * @property {number|null} rankDaily
 * @property {number|null} totalPlayers
 *
 * @typedef {Object} SharedRun   as drawn: a null or filtered name reads 'Anonymous'
 * @property {string} name
 * @property {number} score
 * @property {number} stations
 * @property {number} tickets
 * @property {number} delivered
 * @property {number} time
 * @property {string} start
 * @property {string|null} lineFrom
 * @property {string|null} lineTo
 * @property {number|null} at   ms since 1970, when the server says
 */

export {};
