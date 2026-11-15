// ASCII preview of a world: node src/world/dump.mjs [seed] [width] [height]
// Prints (1) biomes with the sample network on top, (2) elevation, (3) route summaries.
// Biomes: g grassland, f forest, j jungle, d desert, M mountains, r riverlands, C canyon, ~ water.
// Network: @ built station, o unbuilt reservation (invisible in game), track kinds: + ground, L ledge, H bridge, T tunnel.
// Elevation digit = floor(elevation / maxElevation * 9.99).

import { createWorld } from './index.js';
import { WORLD } from '../config.js';
import { hexDistance } from '../hex.js';

const seed = process.argv[2] ?? 'demo';
const W = Number(process.argv[3] ?? 60), H = Number(process.argv[4] ?? 40);
const world = createWorld({ seed: /^-?\d+$/.test(seed) ? Number(seed) : seed });

const BIOME_CH = { grassland: 'g', forest: 'f', jungle: 'j', desert: 'd', mountains: 'M', riverlands: 'r', canyon: 'C' };
const KIND_CH = { ground: '+', ledge: 'L', bridge: 'H', tunnel: 'T' };

// ---- a small sample network: start, its links, build a few, their links ----
const links = (name, n) => Array.from({ length: n }, (_, i) => `${name}/${i}`);
world.placeStart('Start');
world.noteLinks('Start', links('Start', 10));
world.placeGhosts('Start', links('Start', 10));
const routes = [];
function build(from, to) {
  const { cheap, direct, same } = world.findRoutes(from, to);
  world.setBuilt(to);
  world.commitRoute(cheap);
  routes.push({ cheap, direct, same });
}
for (const t of ['Start/0', 'Start/3', 'Start/6', 'Start/9']) build('Start', t);
world.placeGhosts('Start/3', [...links('Start/3', 8), 'Start/6', 'Start/0']);
build('Start/3', 'Start/3/2');
build('Start/3/2', 'Start/6'); // a loop back into the network
// grow outward a few generations: each new station builds to its first, fourth and last link
const queue = ['Start/9', 'Start/0', 'Start/6', 'Start/3/2'];
for (let g = 0; g < 10 && queue.length; g++) {
  const from = queue.shift();
  if (![...world.placements.values()].some((p) => p.parent === from)) world.placeGhosts(from, links(from, 10));
  for (const i of [0, 4, 9]) {
    const to = `${from}/${i}`;
    const p = world.placements.get(to);
    if (!p || p.state === 'built') continue;
    build(from, to);
    world.noteLinks(to, links(to, 10));
    world.placeGhosts(to, links(to, 10));
    queue.push(to);
  }
}
const track = new Map();
for (const { cheap } of routes) for (const h of cheap.hexes) track.set(`${h.q},${h.r}`, h.kind);
const stations = new Map();
for (const p of world.placements.values()) stations.set(`${p.q},${p.r}`, p.state === 'built' ? '@' : 'o');

function grid(cell) {
  const lines = [];
  for (let row = 0; row < H; row++) {
    const r = row - (H >> 1);
    let line = (row & 1) ? ' ' : '';
    for (let col = 0; col < W; col++) {
      const q = col - (W >> 1) - Math.floor(r / 2);
      line += cell(q, r) + ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const counts = {};
let water = 0;
console.log(`seed ${seed}: biomes + network (${W}x${H}, origin at centre)`);
console.log(grid((q, r) => {
  const t = world.terrainAt(q, r);
  counts[t.biome] = (counts[t.biome] || 0) + 1;
  if (t.water) water++;
  const k = `${q},${r}`;
  if (stations.has(k)) return stations.get(k);
  if (track.has(k)) return KIND_CH[track.get(k)];
  return t.water ? '~' : BIOME_CH[t.biome];
}));
console.log('\nelevation (0-9), ~ water');
console.log(grid((q, r) => {
  const t = world.terrainAt(q, r);
  if (t.water) return '~';
  return String(Math.min(9, Math.floor((t.elevation / WORLD.maxElevation) * 9.99)));
}));
const total = W * H;
console.log('\nbiome share:', Object.entries(counts).map(([b, n]) => `${b} ${((n / total) * 100).toFixed(0)}%`).join(', '),
  `| water ${((water / total) * 100).toFixed(1)}%`);
console.log('routes (cheap vs direct):');
for (const { cheap, direct, same } of routes) {
  const kinds = (r) => r.hexes.map((h) => KIND_CH[h.kind]).join('');
  const gap = hexDistance(world.placements.get(cheap.from), world.placements.get(cheap.to));
  console.log(`  ${cheap.from} -> ${cheap.to} (${gap} apart): cheap ${cheap.hexes.length} hexes $${cheap.cost} [${kinds(cheap)}]` +
    (same ? '  (same)' : ` | direct ${direct.hexes.length} hexes $${direct.cost} [${kinds(direct)}]`));
}
