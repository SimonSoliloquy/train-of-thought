// Train Track Builder: the map and the trains with nothing else. No gold, no Wikipedia, no
// names, no end. Click the ground to build a station there; the track and its train come with it.
import './free.js'; // must be first: makes everything free before the rules load
import { createWorld } from '../world/index.js';
import { createGame } from '../sim/index.js';
import { createRenderer } from '../render/index.js';
import { worldToHex, hexDistance } from '../hex.js';
import { createPlaces } from './places.js';

const seed = (Math.random() * 2 ** 32) >>> 0;
const wiki = createPlaces(seed);
const world = createWorld({ seed });
const game = createGame({ wiki, world, seed, surprises: false });
const renderer = createRenderer({ container: document.getElementById('view'), game, world, plain: true });
const hint = document.getElementById('hint');

/** Track from the selected station only reaches this far (hexes); beyond, the nearest station builds. */
const REACH = 14;
/** A click may be moved this far (hexes) to find dry, level ground; farther and nothing is built. */
const NUDGE = 3;

let selected = null;
let busy = false;
let built = 0;

function select(title) {
  selected = title;
  renderer.setSelection(title);
}

function say(text) {
  if (hint && hint.textContent !== text) hint.textContent = text;
}

/** Track from `from` to `to`; true if it was built. */
async function lay(from, to) {
  const quote = game.quoteBuild(from, to);
  if (!quote || quote.ok === false) return false;
  const res = await game.build(from, to);
  if (!(res && res.ok)) return false;
  built++;
  select(to); // carry on from the new end of the line
  if (built === 1) say('Keep going: click the ground again. Click a station to branch from it.');
  else if (built === 3) say('Click a train to ride it.');
  else if (built === 6) say('Click one station, then another, to join them with a loop.');
  else if (built === 9) say('Drag to look around, scroll to zoom. The map never ends.');
  return true;
}

/** The built station track should come from to reach hex h: the selected one if near enough, else the nearest. */
function sourceFor(h) {
  const near = (t) => { const p = world.placements.get(t); return p ? hexDistance(p, h) : Infinity; };
  if (selected && game.state.stations.has(selected) && near(selected) <= REACH) return selected;
  let best = null, bestD = Infinity;
  for (const t of game.state.stations.keys()) {
    const d = near(t);
    if (d < bestD) { best = t; bestD = d; }
  }
  return best;
}

/** A new station on the ground at world point (x, z). */
async function buildAt(x, z) {
  const h = worldToHex(x, z);
  if (!world.isRevealed(h.q, h.r)) return;
  const from = sourceFor(h);
  if (!from) return;
  const title = wiki.create(from);
  game.link(from, title);
  game.state.stubs.set(title, wiki.stub(title));
  const { placement } = world.placeAt(from, title, x, z);
  let ok = false;
  try {
    if (placement && hexDistance(placement, h) <= NUDGE) ok = await lay(from, title);
  } finally {
    if (!ok) {
      world.dropGhost(title);
      wiki.forget(title);
      game.state.stubs.delete(title);
      say('Nowhere to build just there: try drier, flatter ground.');
    }
  }
}

/** Joins two built stations, or picks the station if they cannot be joined. */
async function joinOrSelect(title) {
  if (selected && selected !== title && game.state.stations.has(selected)) {
    wiki.join(selected, title);
    game.link(selected, title);
    if (await lay(selected, title)) return;
  }
  select(title);
}

game.on('started', (e) => {
  if (e && e.station) select(e.station.title);
  say('Click the ground to build a station there.');
});

renderer.onPick(async (pick) => {
  if (game.state.phase !== 'running' || busy) return;
  busy = true;
  try {
    switch (pick.kind) {
      case 'ground':
        renderer.follow(null);
        await buildAt(pick.x, pick.z);
        break;
      case 'station':
      case 'article':
        renderer.follow(null);
        await joinOrSelect(pick.title);
        break;
      case 'train':
        renderer.follow(pick.trainId);
        break;
      case 'none':
        renderer.follow(null);
        break;
      default:
        break;
    }
  } finally {
    busy = false;
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') renderer.follow(null);
});

// Handy for poking at it from the browser console.
window.ttb = { wiki, world, game, renderer };

game.start().catch((err) => {
  console.error(err);
  say('The map could not be drawn. Reload to try again.');
});

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  game.state.money = 1e9; // there is no gold here, so it can never run out
  game.update(dt);
  renderer.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
