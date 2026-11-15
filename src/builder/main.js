// Train Track Builder: the map and the trains with nothing else. No gold, no Wikipedia, no
// names, no end. Click a signpost to build a station there; the track and its train come with it.
import './free.js'; // must be first: makes everything free before the rules load
import { createWorld } from '../world/index.js';
import { createGame } from '../sim/index.js';
import { createRenderer } from '../render/index.js';
import { createLattice } from './lattice.js';

const seed = (Math.random() * 2 ** 32) >>> 0;
const wiki = createLattice(seed);
const world = createWorld({ seed });
const game = createGame({ wiki, world, seed, surprises: false });
const renderer = createRenderer({ container: document.getElementById('view'), game, world, plain: true });
const hint = document.getElementById('hint');

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

async function lay(from, to) {
  if (busy || !from || from === to) return false;
  const quote = game.quoteBuild(from, to);
  if (!quote || quote.ok === false) return false;
  busy = true;
  try {
    const res = await game.build(from, to);
    if (res && res.ok) {
      built++;
      select(to); // carry on from the new end of the line
      if (built === 1) say('Keep going: click another signpost. Click a station to branch from it.');
      else if (built === 3) say('Click a train to ride it.');
      else if (built === 6) say('Click one station, then a neighbour, to join them with a loop.');
      else if (built === 9) say('Drag to look around, scroll to zoom. The map never ends.');
      return true;
    }
  } finally {
    busy = false;
  }
  return false;
}

game.on('started', (e) => {
  if (e && e.station) select(e.station.title);
  say('Click a signpost to build a station there.');
});

renderer.onPick(async (pick) => {
  if (game.state.phase !== 'running') return;
  switch (pick.kind) {
    case 'ghost':
      renderer.follow(null);
      await lay(selected, pick.title);
      break;
    case 'station':
    case 'article':
      renderer.follow(null);
      // A neighbouring station that is not joined yet: join it. Otherwise just pick it.
      if (!(await lay(selected, pick.title))) select(pick.title);
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
