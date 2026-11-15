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
  if (pick.kind === 'upgrade') {
    // an upgrade tag: buy that train for the track
    const res = game.upgradeTrack(pick.trackId, pick.typeId);
    say(res.ok ? `upgraded track ${pick.trackId} to ${pick.typeId}` : res.reason);
  } else if (pick.kind === 'article') {
    say(`article card: ${pick.title}`);
  } else if (pick.kind === 'station') {
    // a built station: its unbuilt links stand as signposts around it
    selectedStation = pick.title;
    renderer.setSelection(pick.title);
    renderer.setRoutePreview(null);
    renderer.focus(pick.title);
  } else if (pick.kind === 'ghost') {
    // a signpost: price the route to that link; its marker shows at the far end.
    // Clicking the same link again builds it.
    if (selectedStation && pricing === pick.title) {
      const from = selectedStation;
      game.build(from, pick.title).then((res) => {
        say(res.ok ? `built ${from} -> ${pick.title}` : res.reason);
        if (res.ok) { renderer.setRoutePreview(null); renderer.setSelection(pick.title); selectedStation = pick.title; }
      });
      pricing = null;
      return;
    }
    pricing = pick.title;
    renderer.setSelection(pick.title);
    if (selectedStation) {
      try {
        const r = world.findRoutes(selectedStation, pick.title);
        renderer.setRoutePreview([r.cheap], 'cheap');
        previewOn = true;
      } catch (err) { say(String(err)); }
    }
  } else if (pick.kind === 'train') {
    following = pick.trainId;
    renderer.follow(pick.trainId);
  } else {
    renderer.setSelection(null);
  }
});

let following = null;
let pricing = null;
let selectedStation = null;
let previewStyle = 'direct';
let previewOn = false;
function showPreview() {
  if (!world.placements.has('Iron Bridge') || world.placements.get('Iron Bridge').state !== 'built') return;
  const r = world.findRoutes('Iron Bridge', 'Danube');
  renderer.setRoutePreview([previewStyle === 'cheap' ? r.cheap : r.direct], previewStyle);
  renderer.setSelection('Danube');
  previewOn = true;
}

// where the demo's shared corridor (a trunk with a track on each side) and flyover are
const VIEWS = {
  lanes: { x: 3.4, y: 1.4, z: -2.8, dist: 6, polar: 0.8 },
  flyover: { x: 2.8, y: 2.0, z: -4.5, dist: 7, polar: 1.0 },
};
let viewIndex = 0;
function flyTo(name) {
  const v = VIEWS[name];
  const rig = renderer._debug && renderer._debug.rig;
  if (!v || !rig) return;
  rig.glideTo({ x: v.x, y: v.y, z: v.z }, v.dist, 1.2, v.polar);
  say(`camera: ${name}`);
}
if (params.has('view')) setTimeout(() => flyTo(params.get('view')), 5500);

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'c') {
    const names = Object.keys(VIEWS);
    flyTo(names[viewIndex++ % names.length]);
  } else if (k === 'f') {
    const ids = game.state.trains.map((t) => t.id);
    if (!ids.length) return;
    const i = following == null ? 0 : ids.indexOf(following) + 1;
    following = i >= ids.length ? null : ids[i];
    renderer.follow(following);
    say(following == null ? 'free camera' : `following train ${following}`);
  } else if (k === 'm') {
    game.state.money += 250;
    say(`gold: ${Math.round(game.state.money)}`);
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
  } else if (k === 'k') {
    // pretend a goal was met (celebration test)
    game._emit('goalDone', { goal: { id: 'test', text: 'Test goal', how: '', progress: 1, target: 1, reward: 100 }, reward: 100, next: game.state.goal });
    say('goalDone (test)');
  } else if (k === 'o') {
    const list = [...game.state.stations.keys()];
    const st = list[Math.floor(Math.random() * list.length)];
    game._emit('routeBonus', { station: st, count: 3, amount: 120 });
    say(`routeBonus at ${st} (test)`);
  } else if (k === 't') {
    const t = game.state.tickets[0] || { from: 'Locomotive', to: 'Steam engine', reward: 650 };
    game._emit('ticketDone', { ticket: t, reward: t.reward });
    say('ticketDone (test)');
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
    const g = game.state.goal;
    document.getElementById('gold').textContent = `gold ${Math.round(game.state.money)} · streak ${game.state.streak}${g ? ` · goal: ${g.text} (${g.progress}/${g.target})` : ''}`;
    fpsEl.textContent = `${Math.round(frames / fpsT)} fps · ${renderer._debug.terrain.tileCount} tiles · ${info.render.calls} calls · ${(info.render.triangles / 1000).toFixed(0)}k tris`;
    frames = 0; fpsT = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
