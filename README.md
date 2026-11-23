# Train of Thought

A real-time train tycoon game in three.js where Wikipedia articles are stations. Track can only follow a
real link between two articles, and the passengers are thoughts on the platform, each heading for
another article. A passenger's ticket names an article you can't see from the map: open your station's
real Wikipedia article, find the link that leads towards it and build there. Finding the chain is the
game. Gold arrives every 10 seconds (stations earn for the links on their pages, track and trains cost
upkeep), and a growing reputation brings bigger fares and crowds. Single player, random start.

**Play:** https://simonsoliloquy.com/train-of-thought/ (the old https://wiki-train-of-thought.vercel.app
forwards there until about 2026-12-19). [Rail Builder](https://github.com/SimonSoliloquy/railbuilder)
is a lighter demo of the same train engine.

## Run it

```bash
npm install
npm run dev     # http://localhost:5183
npm test        # node --test "src/**/*.test.js" (a bare folder path runs no tests on Node 24)
```

## How the code is split

Five modules built against one contract, `src/types.js`:

| Folder | What |
|---|---|
| `src/wiki` | live Wikipedia data |
| `src/world` | the link-driven layout, scenery and routing |
| `src/sim` | money, thoughts, lines, trains and reputation |
| `src/render` | the three.js view |
| `src/ui` | the DOM panels |

Economy numbers live in `src/config.js`. Keep new mechanics inside the contract in `src/types.js`.

## Publishing

Cloudflare serves plain files (no Worker code) at `simonsoliloquy.com/train-of-thought/`. On every push
to `main`, Cloudflare's GitHub build runs `tools/cf-build.sh` (a Vite build into `.cf/train-of-thought/`)
and then `npx wrangler deploy` (settings in `wrangler.jsonc`). By hand:
`sh tools/cf-build.sh && npx wrangler@4.40.0 deploy`. `vercel.json` now only forwards the old Vercel
address.

High scores go to the shared leaderboard Worker (repo `leaderboards`, board `train-of-thought`);
`docs/leaderboard-database-guide.md` describes it.
