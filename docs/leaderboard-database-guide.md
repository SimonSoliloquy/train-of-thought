# Guide: adding a database-backed leaderboard to Train of Thought

For the agent adding shared leaderboard storage. Written 2026-11-15, against commit `0c6829f`.

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
  done on the user interface." Submitting a run must not add a button. See "Ask Simon" below about names.
- Money is "gold", never "$".
- Commit, push and deploy only when Simon says so.

## Ask Simon before building

1. **Which store.** Realistic free choices: a new table in one of his existing Supabase projects (no
   new project, so the project limit does not apply), or a free-tier store added through the Vercel
   dashboard (a Postgres or key-value store). Confirm the price is zero at the time you set it up.
2. **Do runs carry a player name?** A name means a text field somewhere, a length limit and a
   word filter. Without one the board can only show the starting article and the date. This is his call.
3. **One board, or also daily / weekly boards?** The schema below supports either.

## Where things are now

| What | Where |
|---|---|
| Stack | Vite + three.js, plain JS ES modules, no framework, no backend. `npm run dev` (port 5183), `npm test` (177 passing), `npm run build` |
| Hosting | Vercel project `train-of-thought`, live at https://wiki-train-of-thought.vercel.app. Repo: private, `SimonSoliloquy/train-of-thought`, branch `main`. A push to `main` deploys |
| Local board | `src/ui/board.js`: `loadRuns(storage)`, `saveRun(storage, run)` returns `{runs, rank, best}`, `cleanRun`, `sortRuns`. Key `tot.runs`, top 10. Tests in `src/ui/board.test.js` |
| Game-over screen | `src/ui/screens.js`: `onGameOver(payload)` calls `saveRun` once, `boardView()` draws the table |
| Event wiring | `src/ui/index.js` passes the sim's `gameOver` event to `screens.onGameOver` |
| Contract | `src/types.js` documents every event and type. Update it if you change a shape |
| Board styles | `src/ui/styles.css`, classes `tot-board`, `tot-board-head`, `tot-board-best`, row class `mine`. Every button rule must start with `.tot` or it loses to `.tot button` |

The `gameOver` payload, emitted once per run from `src/sim/index.js`:

```js
{ score, time, delivered, stations, tickets, start }
// score: whole number; time: game seconds; delivered: passengers carried;
// stations: stations built; tickets: tickets met; start: title of the starting article
```

Score is computed in `src/sim/econ.js` (`scoreFor`) from `ECON.score` in `src/config.js`:
`delivered * 10 + stations * 25 + uniqueLinks * 0.1 + tickets * 60`. `uniqueLinks` is not in the payload.

## Recommended shape

Keep the browser away from the database. The game is a public static site, so anything in the
bundle is public.

```
browser  --POST /api/runs-->  Vercel function  --server-side key-->  database
browser  <--GET /api/runs---  Vercel function  <-------------------  database
```

1. **Server:** two handlers under `/api` at the repo root (Vercel serves them beside the Vite build).
   `POST /api/runs` validates and inserts one run, and returns the run's rank. `GET /api/runs`
   returns the top N. Credentials live in Vercel environment variables, never in `src/`, and never
   with a `VITE_` prefix (that prefix puts a value in the public bundle). `.env*` is already git-ignored.
2. **Client:** a new module, for example `src/ui/remote-board.js`, with `submitRun(run)` and
   `fetchTop()`. Both must time out after a few seconds and resolve to `null` on any failure.
3. **Screen:** in `screens.js`, keep the `saveRun` call exactly as it is, so the local board appears
   at once. Then submit in the background and, when the answer arrives, redraw with a second table
   ("Best runs anywhere" or similar) above or in place of the local one. The game-over screen must
   never wait on the network or show an error box if the board is down.
4. **Dev:** `vite` does not serve `/api`. Either run `vercel dev`, or make the client treat a 404 as
   "no shared board" so `npm run dev` keeps working unchanged. The second is required either way.

### Table

```sql
create table runs (
  id          bigint generated always as identity primary key,
  score       integer     not null check (score between 0 and 10000000),
  time_s      integer     not null check (time_s between 0 and 864000),
  stations    integer     not null check (stations between 1 and 5000),
  tickets     integer     not null check (tickets between 0 and 5000),
  delivered   integer     not null check (delivered between 0 and 1000000),
  start_title text        not null check (char_length(start_title) between 1 and 120),
  player      text        check (char_length(player) <= 24),  -- only if Simon wants names
  created_at  timestamptz not null default now()
);
create index runs_by_score on runs (score desc, created_at asc);
```

If the store is Supabase: turn on row level security with no public policies and write only through
the server function's key, or allow public `select` only. Never ship a key that can insert or delete.

### Validation in `POST /api/runs`

The score is worked out in the player's browser, so it can be faked. It cannot be proven, only
bounded. Reject a run unless:

- every field is a whole number in the ranges above, and `start_title` is a plain string;
- `score >= delivered*10 + stations*25 + tickets*60` and
  `score <= delivered*10 + stations*25 + tickets*60 + stations*150` (a page counts at most 1,500 links);
- `time_s` is plausible for the size: a run cannot have 50 stations after 30 seconds. The clock
  starts on the first build, and gold limits building, so pick a generous floor and note it in code;
- the caller has not posted more than a few runs a minute (limit by IP in the function or the store).

Cap the request body at a few hundred bytes. If you take names, trim them, cap the length and
filter them on the server. Drawing is already safe: the screen builds rows with `h(..., { text })`,
which sets text, never HTML. Keep it that way.

## Rules of the house

- **Privacy.** Store nothing about the player beyond the run (and a name if Simon wants one). No IP
  addresses in the table, no analytics, no third-party scripts.
- **Wikipedia.** The game calls the Wikipedia API from the browser. Do not route that through your
  function or add identifying headers.
- **Tests.** Add `node:test` tests for the client module (fake `fetch`: success, timeout, 404, bad
  JSON) and for the server's validation as a pure function. `npm test` must stay green.
- **Simon may be playing.** He often has the local game open. Editing files under `src/` reloads his
  tab and ends his run, and so does reloading or navigating a browser tab he is using. Open your own
  tab for testing. Testing game over writes to `localStorage` key `tot.runs` on `localhost:5183`: save
  the old value first and put it back after.
- **Check it for real.** Finish a run on the deployed preview and confirm the row lands in the
  database and shows on a second browser. Then confirm the game-over screen still works with the
  function switched off, and that it fits at 660 px wide without sideways scrolling.

## Done means

- A finished run appears on the shared board for other players, with no new button to press.
- With the database unreachable, game over looks exactly as it does today.
- No secret is in the repo or the built bundle (`grep` the `dist/` output for the key).
- Simon has confirmed the store costs nothing.
- `src/types.js` and this guide are updated to match what was built.
