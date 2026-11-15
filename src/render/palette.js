// Colours of the diorama. All hex strings are sRGB; rgb() converts to linear.
import { WORLD } from '../config.js';
import { rgb, mix, shade } from './builder.js';

export const SKY = {
  zenith: '#5f9fd6',
  horizon: '#e3ebe9',
  below: '#cfdbdc',
  mist: '#d6e0e1',
  sun: '#fff1d6',
};

// top: grass/sand surface; top2: second tone mixed by detail; side: cliff walls.
export const BIOME_PALETTE = {
  grassland:  { top: '#97c459', top2: '#b3cf63', side: '#94714a' },
  forest:     { top: '#5c9a3f', top2: '#4a8a3a', side: '#76583a' },
  jungle:     { top: '#2f9a4b', top2: '#47ad4f', side: '#664b31' },
  desert:     { top: '#ecc982', top2: '#f3d79a', side: '#cf9f62' },
  mountains:  { top: '#8e9088', top2: '#7f8a72', side: '#8d857b', snow: '#f3f6f8' },
  riverlands: { top: '#82c56b', top2: '#9bd27a', side: '#8a7150' },
  canyon:     { top: '#d77a45', top2: '#e39257', side: '#b04f2e' },
};

export const WATER = { surface: '#3fa7cf', deep: '#2b7fa8', bed: '#c9b27c', bedSide: '#a58c5c' };

export const TRACK_COLORS = {
  ballast: '#9a9188',
  ballastDark: '#7d756d',
  sleeper: '#5b4130',
  rail: '#c9ccd1',
  railSide: '#7f838a',
  deck: '#6b4a33',
  girder: '#a5432f',
  pier: '#a8a196',
  pierDark: '#8a8378',
  wall: '#b9ab92',
  embank: '#8c7d5a',
  wallCap: '#d6cbb5',
  portal: '#b7ab97',
  portalDark: '#141414',
};

export const ROUTE_PREVIEW = {
  ground: '#ffe9a8',
  ledge: '#ffc35a',
  bridge: '#7fe3ff',
  tunnel: '#c7a6ff',
};

export const BUBBLE_COLORS = { calm: '#9ff3ff', worried: '#ffd36b', urgent: '#ff6b5e' };

const SNOW_LINE = WORLD.maxElevation * 0.72;

export function biomeOf(tile) {
  return BIOME_PALETTE[tile && tile.biome] ? tile.biome : 'grassland';
}

export function isSnowy(tile) {
  return biomeOf(tile) === 'mountains' && !tile.water && tile.elevation >= SNOW_LINE;
}

/**
 * Per-tile colours, linear RGB arrays in [0,1].
 * @returns {{top:number[], side:number[]}}
 */
export function tileColors(tile) {
  const b = biomeOf(tile);
  const p = BIOME_PALETTE[b];
  const d = Number.isFinite(tile.detail) ? tile.detail : 0.5;
  const e = Number.isFinite(tile.elevation) ? tile.elevation : 0;
  if (tile.water) {
    return { top: shade(WATER.bed, 0.9 + d * 0.15), side: rgb(WATER.bedSide) };
  }
  let top = mix(p.top, p.top2, d);
  if (b === 'mountains') {
    // grassy foothills -> grey rock -> snow
    const t = Math.min(1, Math.max(0, e / SNOW_LINE));
    top = mix(mix('#86a35e', p.top, Math.min(1, t * 1.6)), p.top2, d * 0.4);
    if (e >= SNOW_LINE) top = mix(p.snow, '#dfe6ec', d * 0.5);
  }
  const k = 0.92 + (d - 0.5) * 0.14 + Math.min(e, WORLD.maxElevation) * 0.018;
  top = shade(top, k);
  const side = shade(p.side, 0.94 + d * 0.1);
  return { top: clamp01(top), side: clamp01(side) };
}

function clamp01(c) {
  return [Math.min(1, Math.max(0, c[0])), Math.min(1, Math.max(0, c[1])), Math.min(1, Math.max(0, c[2]))];
}
