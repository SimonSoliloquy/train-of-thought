import { createWiki } from './wiki/index.js';
import { createWorld } from './world/index.js';
import { createGame } from './sim/index.js';
import { createRenderer } from './render/index.js';
import { createUI } from './ui/index.js';

const seed = (Math.random() * 2 ** 32) >>> 0;
const wiki = createWiki();
const world = createWorld({ seed });
const game = createGame({ wiki, world, seed });
const renderer = createRenderer({ container: document.getElementById('view'), game, world });
const ui = createUI({ root: document.getElementById('ui'), game, renderer });

// Handy for poking at the game from the browser console.
window.tot = { wiki, world, game, renderer, ui };

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  game.update(dt);
  renderer.update(dt);
  ui.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
