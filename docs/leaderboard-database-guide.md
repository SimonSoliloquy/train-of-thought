# Guide: adding a database-backed leaderboard to Train of Thought

For the agent adding shared leaderboard storage. Written 2026-11-15, against commit `0c6829f`;
updated the same day to describe what was built (Cloudflare Worker, names, daily boards, longest line),
and on 2026-11-19 when the "today" board was dropped and the game moved to simonsoliloquy.com.

## What you are building

Today the game keeps a "Best runs on this machine" board in the player's own browser. Your job is a
shared board: every player's finished run goes to a database, and the game-over screen shows the
best runs from everyone. The local board must keep working whenever the database cannot be reached.

## Simon's rulings that bind this work

Quoted from Simon. Do not reopen them.

- "I want leaderboard stored but I'm at my supabase limit right now for the free tier", then
  "i won't pay for this leaderboard storage". The storage must cost nothing, and you cannot create a
  new Supabase project. Check the current free allowance of whatever you pick, and tell Simon which
  store you are using before you create it.
- "no company levels- a finished run leaves nothing behind." Only scores are stored. No accounts,
  progress, unlocks or saved games.
- "It needs to be as few buttons as possible. The more buttons we have, the worse of a job you've
  done on the user interface." Submitting a run must not add a button.
- Money is "gold", never "$".
- Commit, push and deploy only when Simon says so.

## What Simon decided (2026-11-15), and what was built

The questions this guide first asked Simon are answered:

1. **Store:** not a Vercel function and not Supabase. A shared Cloudflare Worker + D1 (free tier),
   deployed by another agent and shared with other games: `https://leaderboards.ai-wizards.workers.dev`.
   It is public, so there are no keys anywhere. This game only ever calls its `/train-of-thought/`
   routes, never another game's (e.g. Linkshot). There are no `/api` handlers in this repo.
2. **Names:** optional. One small text field on the game-over screen, no button. Blank = "Anonymous".
   Max 20 characters, remembered in `localStorage` (`tot.name`). The server filters names too.
3. **Boards:** all time only. A "today" board (UTC) was built first; Simon dropped it on 2026-11-19 to
   stay inside the Worker's free-tier limits (it doubled the reads). `GET /top?scope=daily` now just
   returns the all-time list; the client does not ask for it.
4. **Longest train line:** every run names its longest line, "A → B", shown on every board row. It does
   not change the score.

## Where things are now

| What | Where |
|---|---|
| Stack | Vite + three.js, plain JS ES modules, no framework, no backend in this repo. `npm run dev` (port 5183), `npm test` (200 passing), `npm run build` |
| Hosting | Cloudflare (static assets, `wrangler.jsonc`, built by `tools/cf-build.sh`), live at https://simonsoliloquy.com/train-of-thought/. Repo: private, `SimonSoliloquy/train-of-thought`, branch `main`. A push to `main` deploys. The old https://wiki-train-of-thought.vercel.app only redirects there (`vercel.json`) until about 2026-12-19 |
| Local board | `src/ui/board.js`: `loadRuns`, `saveRun(storage, run)` returns `{runs, rank, best}`, `cleanRun` (now keeps `lineFrom`/`lineTo`), `sortRuns`. Key `tot.runs`, top 10. Tests in `src/ui/board.test.js` |
| Shared board client | `src/ui/remote-board.js`: `LEADERBOARD_URL`, `submitRun(run, opts)`, `fetchTop(opts)` (memory-cached, `forgetTop` for tests), `sharedBoardOn`, `isLocalHost`, `cleanName`/`loadName`/`saveName`, `playerId`. Tests (fake `fetch`) in `src/ui/remote-board.test.js` |
| Longest line | `src/sim/line.js`: `longestLine(tracks)`. Tests in `src/sim/line.test.js` |
| Game-over screen | `src/ui/screens.js`: `onGameOver(payload)` calls `saveRun` once and draws at once, then reads the shared boards and sends the run in the background |
| Event wiring | `src/ui/index.js` passes the sim's `gameOver` event to `screens.onGameOver` |
| Contract | `src/types.js` documents every event and type, including the BOARDS section. Update it if you change a shape |
| Board styles | `src/ui/styles.css`: `tot-boards`, `tot-board`, `tot-board-head`, `tot-board-best`, `tot-board-name`, `tot-board-line`, `tot-board-ranks`, `tot-name`, `tot-name-input`, `tot-over-line`; row class `mine`. Every button rule must start with `.tot` or it loses to `.tot button` |

The `gameOver` payload, emitted once per run from `src/sim/index.js`:

```js
{ score, time, delivered, stations, tickets, start, lineFrom, lineTo }
// score: whole number; time: game seconds; delivered: passengers carried;
// stations: stations built; tickets: tickets met; start: title of the starting article;
// lineFrom / lineTo: the two station titles at the ends of the run's longest train line,
// or both null with fewer than two connected stations
```

Score is computed in `src/sim/econ.js` (`scoreFor`) from `ECON.score` in `src/config.js`:
`delivered * 10 + stations * 25 + uniqueLinks * 0.1 + tickets * 60`. `uniqueLinks` is not in the payload.

### Longest train line

Of every pair of stations joined by built track, the pair whose *shortest* way along the track is
longest, measured in track length (the sum of `route.length` of the tracks on the way; the polyline
the trains ride). Dijkstra from every station over `state.tracks` (station title nodes, one edge per
track). Several separate networks: the longest of any. Ties keep the pair found first (stations in
the order they first appear on a track). It is computed once, at game over.

### The Worker's API (as called)

- `POST {url}/train-of-thought/submit?n=10`, JSON body sent **without** a `Content-Type` header
  (so it goes as `text/plain` and the browser sends no CORS preflight; the Worker parses JSON anyway)
  `{player, name, score, time, stations, tickets, delivered, start, lineFrom, lineTo}` →
  `{rankAllTime, rankDaily: null, totalPlayers, top, daily: null}`, where `top` is the updated
  all-time list (same rows as `GET /top`, `n` long). `player` is a random id kept in `localStorage`
  (`tot.player`); `name` is `''` when blank; `time` is sent as whole seconds.
- `GET {url}/train-of-thought/top?n=10` → the all-time list
  `[{name, score, stations, tickets, delivered, time, start, lineFrom, lineTo, at}]` (the browser
  caches it 30 s). `name` is null for unnamed or filtered runs; the client shows "Anonymous".
- Request budget: at most **one GET per page load** (the list is kept in memory and shared by every
  caller; a failed read is not retried) and **one POST per saved run**, whose `top` replaces the list
  so nothing is re-read. Each "New run" reloads the page.
- Both time out after 5 s and resolve to `null` on any failure (non-2xx, bad JSON, wrong shape,
  thrown fetch). While `LEADERBOARD_URL` contains `WORKER_SUBDOMAIN` the client makes no call at all.
- Server rules (from the Worker's author): 400 if `score` is outside `[base, base + 150 × stations]`
  with `base = delivered×10 + stations×25 + tickets×60`, or if `stations > 20 + time/2`,
  `delivered > 20 + time/2`, `tickets > 5 + time/10`; `start` 1–120 characters; 429 on more than 10
  submits a minute; 403 from origins it does not allow (localhost and 127.0.0.1 are allowed for GET).

### The game-over screen

1. `saveRun` runs exactly as before and the local board ("Best runs on this machine") is drawn at once.
2. The all-time list is fetched once in the background. When it has a run, "Best runs of all time"
   takes the local board's place; if it fails (or is empty) the local board stays.
   No error is ever shown for the network.
3. The run is sent **once**, when the player presses Enter in the name field or leaves it, presses
   "New run" (sent with `keepalive`), closes the page (`pagehide`), or 30 s after game over if the field
   is untouched (not while it has focus). The field then locks for this run; the name is remembered for
   the next. The answer's `top` list is drawn (no second read), this run's row is picked out by its
   rank, and a line under it says e.g. "This run: 37th of all time · 120 players."
4. Never sent from `localhost`, `127.x`, `[::1]` or `*.localhost` (`isLocalHost`), so testing never
   pollutes the board. Reading the boards does work from a local dev tab.
5. Rows: `#, Score, Stations, Tickets, Time`, then a two-line cell: the player's name (shared) or the
   start article (local), and "A → B" (or a dash). The full text is in the cell's tooltip.

## Rules of the house

- **Privacy.** Store nothing about the player beyond the run (and a name if Simon wants one). No IP
  addresses in the table, no analytics, no third-party scripts.
- **Wikipedia.** The game calls the Wikipedia API from the browser. Do not route that through your
  function or add identifying headers.
- **Tests.** `node:test` tests cover the client module (fake `fetch`: success, timeout, 400/404/429/500,
  bad JSON, thrown fetch, placeholder URL, localhost) and the longest-line computation. The server's
  validation lives with the Worker, not here. `npm test` must stay green.
- **Simon may be playing.** He often has the local game open. Editing files under `src/` reloads his
  tab and ends his run, and so does reloading or navigating a browser tab he is using. Open your own
  tab for testing. Testing game over writes to `localStorage` key `tot.runs` on `localhost:5183`: save
  the old value first and put it back after.
- **Check it for real.** Finish a run on the deployed preview (not localhost: it never submits) and
  confirm the row shows on a second browser. Then confirm the game-over screen still works with the
  Worker unreachable, and that it fits at 660 px wide without sideways scrolling.

## Done means

- A finished run appears on the shared board for other players, with no new button to press.
- With the Worker unreachable, game over shows the local board as before.
- No secret is in the repo or the built bundle (there is none to have: the Worker is public).
- `src/types.js` and this guide match what was built.

Still open as of 2026-11-15: a real submit from the deployed site has not been seen landing on the
board (nothing is committed or deployed yet), and the post-submit view (ranks line, highlighted row)
has only been checked in unit tests of the client, not in a browser.
