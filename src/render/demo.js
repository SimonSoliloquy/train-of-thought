// Standalone demo of the 3D view against a MOCK world and game (see mock.js).
// Served by Vite at /render-demo.html.
import { createRenderer } from './index.js';
import { createMockWorld, createMockGame, revealDisc } from './mock.js';

const params = new URLSearchParams(location.search);
const world = createMockWorld();
const game = createMockGame({ world });
if (params.has('big')) revealDisc(world, Number(params.get('big')) || 37); // perf test: ~4,200 tiles drawn at creation

const renderer = createRenderer({ container: document.getElementById('view'), game, world });
window.tot = { world, game, renderer };

const log = document.getElementById('log');
const fpsEl = document.getElementById('fps');
function say(text) {
  const row = document.createElement('div');
  row.textContent = text;
  log.prepend(row);
  while (log.children.length > 6) log.lastChild.remove();
}

renderer.onPick((pick) => {
  say(`pick ${JSON.stringify(pick)}`);
  console.log('[demo] pick', pick);
  if (pick.kind === 'station' || pick.kind === 'ghost') {
    renderer.setSelection(pick.title);
    renderer.focus(pick.title);
  } else if (pick.kind === 'train') {
    following = pick.trainId;
    renderer.follow(pick.trainId);
  } else {
    renderer.setSelection(null);
  }
});

let following = null;
let lineHi = null;
let previewStyle = 'direct';
let previewOn = false;
function showPreview() {
  if (!world.placements.has('Iron Bridge') || world.placements.get('Iron Bridge').state !== 'built') return;
  const r = world.findRoutes('Iron Bridge', 'Danube');
  renderer.setRoutePreview([r.cheap, r.direct], previewStyle);
  previewOn = true;
}

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'f') {
    const ids = game.state.trains.map((t) => t.id);
    if (!ids.length) return;
    const i = following == null ? 0 : ids.indexOf(following) + 1;
    following = i >= ids.length ? null : ids[i];
    renderer.follow(following);
    say(following == null ? 'free camera' : `following train ${following}`);
  } else if (k === 'l') {
    const ids = [null, ...game.state.lines.map((l) => l.id)];
    lineHi = ids[(ids.indexOf(lineHi) + 1) % ids.length];
    renderer.setLineHighlight(lineHi);
    say(`line highlight ${lineHi}`);
  } else if (k === 'p') {
    previewStyle = previewStyle === 'direct' ? 'cheap' : 'direct';
    showPreview();
    say(`preview active: ${previewStyle}`);
  } else if (k === 'x') {
    if (previewOn) { renderer.setRoutePreview(null); previewOn = false; } else showPreview();
  } else if (k === 'r') {
    const list = [...world.placements.values()];
    const p = list[Math.floor(Math.random() * list.length)];
    const tiles = world._reveal(p.q, p.r, 5);
    game._emit('tilesRevealed', { tiles });
    say(`revealed ${tiles.length} tiles around ${p.title}`);
  } else if (k === 'b') {
    const tiles = revealDisc(world, 37);
    game._emit('tilesRevealed', { tiles });
    say(`revealed ${tiles.length} tiles (perf test)`);
  } else if (k === ' ') {
    game.setSpeed(game.state.speed ? 0 : 1);
    e.preventDefault();
  } else if (k === 'escape') {
    renderer.setSelection(null);
    renderer.follow(null);
    following = null;
  } else if (k === 'g') {
    const ghosts = [...world.placements.values()].filter((p) => p.state === 'ghost');
    if (ghosts.length) { const g = ghosts[Math.floor(Math.random() * ghosts.length)]; renderer.setSelection(g.title); renderer.focus(g.title); }
  }
});

setTimeout(() => game.start(), 600);
setTimeout(showPreview, 9000);

let last = performance.now();
let frames = 0, fpsT = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  game.update(dt);
  renderer.update(dt);
  frames++; fpsT += dt;
  if (fpsT >= 0.5) {
    const info = renderer._debug.renderer.info;
    fpsEl.textContent = `${Math.round(frames / fpsT)} fps · ${renderer._debug.terrain.tileCount} tiles · ${info.render.calls} calls · ${(info.render.triangles / 1000).toFixed(0)}k tris`;
    frames = 0; fpsT = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
