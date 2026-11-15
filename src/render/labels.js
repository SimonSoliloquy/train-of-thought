// Station titles as DOM labels (CSS2DRenderer): always crisp text. Labels fade
// with distance and a greedy screen-space pass places them: lower-priority ones that would
// overlap are hidden, and movable ones (upgrade tags) step aside instead, so the map never
// turns into a word cloud and a tag never sits on top of a signpost.
import * as THREE from 'three';
import { gold } from './format.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const STYLE_ID = 'tot-render-labels-style';
const CSS = `
.tot-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.tot-shift { display: flex; flex-direction: column; align-items: center; transition: transform .22s ease; }
.tot-label { pointer-events: none; transition: opacity .25s ease; white-space: nowrap; will-change: transform, opacity;
  font: 700 13px/1.15 "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif; letter-spacing: .01em; }
.tot-label .tot-pill { display: inline-flex; flex-direction: column; align-items: center; gap: 1px; padding: 4px 10px; border-radius: 4px;
  color: #fff; background: linear-gradient(180deg, #2a5797, #1a3c70 60%, #163463);
  box-shadow: inset 0 0 0 2px #1a3c70, inset 0 0 0 3.3px #f2f5fa, 0 0 0 1.5px #0b1c38, 0 3px 8px rgba(0,0,0,.45);
  text-shadow: 0 1px 0 rgba(0,0,0,.45); transition: box-shadow .15s ease, transform .15s ease, background .15s ease; }
.tot-row { display: inline-flex; align-items: center; gap: 6px; }
.tot-label .tot-dot { width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: radial-gradient(circle at 35% 30%, #fff2c8, #c9a253 60%, #6b4d1c); box-shadow: 0 0 0 1px rgba(0,0,0,.4); }
.tot-label .tot-count { font: 800 12px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #251905; background: linear-gradient(#ffe39a, #ffb53d);
  padding: 2px 5px; border-radius: 7px; box-shadow: 0 0 0 1px #4a3210, 0 0 6px rgba(255,170,50,.6); text-shadow: none; }
/* built stations: enamel railway signs; amber glow on hover, brighter when selected */
.tot-label.hover .tot-pill { box-shadow: inset 0 0 0 2px #1a3c70, inset 0 0 0 3.3px #f2f5fa, 0 0 0 2px #ffcf6a, 0 0 14px 3px rgba(255,170,50,.75); }
.tot-label.selected .tot-pill { box-shadow: inset 0 0 0 2px #1a3c70, inset 0 0 0 3.3px #f2f5fa, 0 0 0 2.5px #ffcf6a, 0 0 0 4px #4a3210, 0 0 18px 5px rgba(255,170,50,.8); }
/* places on the map not yet built: an unlit iron plate */
.tot-label.ghost { font-weight: 600; font-size: 12px; }
.tot-label.ghost .tot-pill { color: #f3e8cc; background: rgba(30, 28, 24, .72); padding: 2px 8px; text-shadow: 0 1px 0 #000;
  box-shadow: inset 0 0 0 1px rgba(201, 162, 83, .6), 0 2px 6px rgba(0,0,0,.3); }
.tot-label.ghost .tot-dot { background: transparent; box-shadow: inset 0 0 0 1.5px #c9a253; }
.tot-label.ghost.target { font-size: 13px; font-weight: 700; }
.tot-label.ghost.target .tot-pill { background: rgba(30, 28, 24, .92); box-shadow: inset 0 0 0 1px rgba(201,162,83,.8), 0 0 0 2px #ffcf6a, 0 0 14px 3px rgba(255,170,50,.6); }
/* link signposts: brass-framed parchment plates with the price */
.tot-label.sign { pointer-events: auto; cursor: pointer; font-size: 13px; z-index: 100000 !important; }
.tot-label.sign .tot-pill { color: #23180b; text-shadow: none; border: 2px solid transparent; border-radius: 4px; padding: 3px 10px 3px 8px;
  background: linear-gradient(180deg, #fbf3dd, #ecdfba) padding-box, linear-gradient(145deg, #f6e3a6, #c9a253 25%, #7d5a22 55%, #d6b467) border-box;
  box-shadow: 0 0 0 1px rgba(40,25,5,.55), 0 3px 9px rgba(0,0,0,.45); }
.tot-label.sign .tot-dot { width: 0; height: 0; border-radius: 0; background: none; box-shadow: none;
  border-left: 7px solid #b8452f; border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
.tot-label.sign.hover .tot-pill { background: linear-gradient(180deg, #fff7df, #ffe7a8) padding-box, linear-gradient(145deg, #fff0c0, #e2b65c 30%, #9a7130 60%, #f0d48c) border-box;
  box-shadow: 0 0 0 1px rgba(40,25,5,.55), 0 4px 12px rgba(0,0,0,.45), 0 0 16px 4px rgba(255,170,50,.8); transform: scale(1.07); }
.tot-sub { display: none; font: 700 12px/1.2 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #4a3a18; }
.tot-label.sign .tot-sub { display: block; }
.tot-sub.dear { color: #a8221a; }
.tot-badge { display: none; margin-top: 2px; padding: 2px 8px; border-radius: 3px; font: 800 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #06322a; background: linear-gradient(#c8f5ea, #6fd0bb); box-shadow: 0 0 0 1px #1e7564, 0 0 10px rgba(90,210,180,.7); }
/* passengers want to go there: a verdigris lamp */
.tot-label.sign.want .tot-badge { display: block; animation: tot-bob 1.2s ease-in-out infinite; }
.tot-label.sign.want .tot-pill { animation: tot-glow 1.6s ease-in-out infinite; }
.tot-label.sign.want .tot-dot { border-left-color: #1e7564; }
@keyframes tot-glow { 0%, 100% { box-shadow: 0 0 0 1px rgba(40,25,5,.55), 0 3px 9px rgba(0,0,0,.45), 0 0 6px rgba(90,210,180,.45); }
  50% { box-shadow: 0 0 0 1px rgba(40,25,5,.55), 0 3px 12px rgba(0,0,0,.45), 0 0 20px 4px rgba(90,210,180,.85); } }
/* the surveyor's pick: a gold-leaf signpost, unmistakable */
.tot-label.sign.tkt-hint, .tot-label.sign.tkt-to, .tot-label.sign.tkt-from { z-index: 110000 !important; font-size: 14.5px; }
.tot-label.sign.tkt-hint .tot-pill, .tot-label.sign.tkt-to .tot-pill { color: #2a1700; padding: 4px 12px 4px 9px;
  background: linear-gradient(180deg, #fff6c8, #ffd34d 55%, #f0b323) padding-box, linear-gradient(145deg, #fff3c4, #e8a50f 35%, #8a5a00 60%, #ffd966) border-box;
  animation: tot-gold 1.3s ease-in-out infinite; }
.tot-label.sign.tkt-hint .tot-sub { color: #3a2400; }
.tot-label.sign.tkt-hint .tot-dot, .tot-label.sign.tkt-to .tot-dot, .tot-label.sign.tkt-from .tot-dot { border-left-color: #8a5a00; }
.tot-label.sign.tkt-hint .tot-badge, .tot-label.sign.tkt-to .tot-badge, .tot-label.sign.tkt-from .tot-badge { display: block; animation: tot-bob 1.2s ease-in-out infinite;
  font-size: 13px; color: #2a1700; background: linear-gradient(#fff2a8, #ffc233); box-shadow: 0 0 0 1.5px #8a5a00, 0 0 14px rgba(255,200,60,.95); }
@keyframes tot-gold { 0%, 100% { box-shadow: 0 0 0 1.5px #5a3a00, 0 3px 12px rgba(0,0,0,.4), 0 0 10px 2px rgba(255,190,40,.6); }
  50% { box-shadow: 0 0 0 2px #fff3c4, 0 3px 14px rgba(0,0,0,.4), 0 0 28px 8px rgba(255,200,60,.95); } }
/* train upgrade tags and the Build button: brass push-plates, lit when affordable, unlit when not */
.tot-label.tag { pointer-events: auto; z-index: 90000 !important; }
.tot-tagrow { display: flex; gap: 6px; }
.tot-tag { cursor: pointer; display: flex; flex-direction: column; align-items: center; padding: 4px 11px 5px; border-radius: 5px; white-space: nowrap; user-select: none;
  font: 700 13px/1.15 "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  color: #241805; background: linear-gradient(180deg, #ffeaae 0%, #e2b65c 50%, #b98a33 100%); text-shadow: 0 1px 0 rgba(255,248,220,.6);
  box-shadow: 0 0 0 1px #4a3210, 0 3px 0 #4a3210, 0 4px 10px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.6), 0 0 14px rgba(255,170,50,.55);
  transition: transform .1s ease, box-shadow .12s ease; }
.tot-tag small { font: 700 12px/1.2 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #3d2a0c; margin-top: 2px; }
.tot-tag.hover { transform: translateY(1px); box-shadow: 0 0 0 1px #4a3210, 0 2px 0 #4a3210, 0 3px 8px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.6), 0 0 24px 5px rgba(255,180,60,.9); }
.tot-tag:active { transform: translateY(3px); box-shadow: 0 0 0 1px #4a3210, inset 0 2px 4px rgba(80,50,0,.5), 0 0 18px rgba(255,180,60,.8); }
.tot-tag.dim { color: #efe4c9; text-shadow: 0 1px 0 #000; background: linear-gradient(180deg, #3d3830, #23201b);
  box-shadow: 0 0 0 1px #8a6a30, 0 3px 0 #0e0d0b, 0 4px 8px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,240,200,.12); }
.tot-tag.dim small { color: #d2c299; }
.tot-tag.dim.hover { transform: translateY(1px); box-shadow: 0 0 0 1px #c9a253, 0 2px 0 #0e0d0b, 0 3px 8px rgba(0,0,0,.35); }
.tot-arrow { display: none; font: 900 22px/1 system-ui, sans-serif; color: #ffc94a; text-shadow: 0 2px 0 #4a3210, 0 0 10px rgba(255,180,50,.9);
  margin-bottom: 2px; pointer-events: none; }
.tot-label.tag.goal .tot-arrow { display: block; animation: tot-bob .8s ease-in-out infinite; }
.tot-label.tag.goal .tot-tag:not(.dim) { animation: tot-lit 1.1s ease-in-out infinite; font-size: 15px; padding: 6px 14px 7px; }
@keyframes tot-bob { 0%, 100% { transform: translateY(-4px); } 50% { transform: translateY(4px); } }
@keyframes tot-lit { 0%, 100% { box-shadow: 0 0 0 1px #4a3210, 0 3px 0 #4a3210, 0 4px 10px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.6), 0 0 10px rgba(255,170,50,.5); }
  50% { box-shadow: 0 0 0 2px #fff3c4, 0 3px 0 #4a3210, 0 5px 14px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.6), 0 0 30px 7px rgba(255,190,60,.95); } }
/* passengers' speech bubbles: parchment and ink */
.tot-label.thought { font-weight: 700; font-size: 12px; }
.tot-label.thought .tot-pill { color: #23180b; text-shadow: none; background: linear-gradient(#fbf4df, #efe2bf); padding: 2px 8px; border-radius: 10px 10px 10px 2px;
  box-shadow: 0 0 0 1px #9a7a40, 0 2px 6px rgba(0,0,0,.35); }
.tot-label.thought .tot-dot { display: none; }
.tot-label.thought.restless .tot-pill { background: linear-gradient(#ffeec0, #ffd77a); }
.tot-label.thought.urgent .tot-pill { background: linear-gradient(#ffb3a5, #ff8a76); color: #2a0b08; box-shadow: 0 0 0 1px #8c1a10, 0 2px 6px rgba(0,0,0,.35); }
/* a ticket holder: a brass-rimmed porthole over the station the ticket starts from */
.tot-label.holder .tot-pill { flex-direction: column; gap: 6px; padding: 0; background: none; box-shadow: none; text-shadow: none; }
.tot-label.holder .tot-dot { position: relative; width: 60px; height: 60px; border-radius: 50%; flex: none; margin-top: 7px;
  background: #bfe3f5 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23bfe3f5'/%3E%3Crect y='47' width='64' height='17' fill='%23cfc6b4'/%3E%3Crect y='47' width='64' height='3' fill='%23f1d36a'/%3E%3Cpath d='M15 60 L18 36 Q28 28 38 36 L41 60 Z' fill='%23d1495b'/%3E%3Ccircle cx='28' cy='21' r='9.5' fill='%23e0ac7e'/%3E%3Cpath d='M19 18 Q28 7 37 18 Q28 14 19 18 Z' fill='%233a2a20'/%3E%3Ccircle cx='25' cy='21' r='1.2' fill='%232a2100'/%3E%3Ccircle cx='31' cy='21' r='1.2' fill='%232a2100'/%3E%3Cpath d='M37 38 L49 29' stroke='%23d1495b' stroke-width='6' stroke-linecap='round'/%3E%3Cg transform='rotate(-14 51 20)'%3E%3Crect x='43' y='13' width='17' height='11' rx='1.5' fill='%23ffd24a' stroke='%232a2100' stroke-width='1.3'/%3E%3Cpath d='M46 17 h10 M46 20.5 h6' stroke='%232a2100' stroke-width='1.2'/%3E%3C/g%3E%3C/svg%3E") center / cover no-repeat;
  box-shadow: inset 0 0 0 2px rgba(40,25,5,.7), inset 0 -6px 12px rgba(0,0,0,.25), 0 6px 16px rgba(0,0,0,.45);
  animation: tot-holder-bob 2.4s ease-in-out infinite; }
.tot-label.holder .tot-dot::before { content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  background: radial-gradient(ellipse 45% 30% at 34% 24%, rgba(255,255,255,.55), transparent 70%); }
.tot-label.holder .tot-dot::after { content: ''; position: absolute; inset: -7px; border-radius: 50%; pointer-events: none;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 74 74'%3E%3Cdefs%3E%3ClinearGradient id='b' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23f6e3a6'/%3E%3Cstop offset='.45' stop-color='%23c49b4c'/%3E%3Cstop offset='.7' stop-color='%237d5a22'/%3E%3Cstop offset='1' stop-color='%23d9b867'/%3E%3C/linearGradient%3E%3C/defs%3E%3Ccircle cx='37' cy='37' r='33.5' fill='none' stroke='url(%23b)' stroke-width='7'/%3E%3Ccircle cx='37' cy='37' r='36.6' fill='none' stroke='%233b2a0e' stroke-width='.8'/%3E%3Ccircle cx='37' cy='37' r='30.2' fill='none' stroke='%233b2a0e' stroke-width='.8'/%3E%3Cg fill='%23fff0c4' stroke='%235a3f15' stroke-width='.7'%3E%3Ccircle cx='37.0' cy='3.5' r='1.7'/%3E%3Ccircle cx='60.7' cy='13.3' r='1.7'/%3E%3Ccircle cx='70.5' cy='37.0' r='1.7'/%3E%3Ccircle cx='60.7' cy='60.7' r='1.7'/%3E%3Ccircle cx='37.0' cy='70.5' r='1.7'/%3E%3Ccircle cx='13.3' cy='60.7' r='1.7'/%3E%3Ccircle cx='3.5' cy='37.0' r='1.7'/%3E%3Ccircle cx='13.3' cy='13.3' r='1.7'/%3E%3C/g%3E%3C/svg%3E") center / 100% 100% no-repeat; }
.tot-label.holder .tot-text { font-size: 12px; font-weight: 700; color: #23180b; background: linear-gradient(#fbf3dd, #ecdfba); padding: 2px 8px 2px 9px; border-radius: 3px;
  box-shadow: 0 0 0 1px #8a6528, 0 2px 6px rgba(0,0,0,.4); max-width: 190px; overflow: hidden; text-overflow: ellipsis; }
.tot-label.holder .tot-count { display: none; }
.tot-label.holder.restless .tot-dot { box-shadow: inset 0 0 0 2px rgba(40,25,5,.7), inset 0 -6px 12px rgba(0,0,0,.25), 0 0 0 9px rgba(255,150,40,.55), 0 0 18px 8px rgba(255,150,40,.6); animation-duration: 1.2s; }
.tot-label.holder.urgent .tot-dot { box-shadow: inset 0 0 0 2px rgba(40,25,5,.7), inset 0 -6px 12px rgba(0,0,0,.25), 0 0 0 9px rgba(229,67,47,.7), 0 0 20px 9px rgba(229,67,47,.75); animation-duration: .55s; }
.tot-label.holder.urgent .tot-text { background: linear-gradient(#ffd6cc, #ffb3a5); color: #2a0b08; box-shadow: 0 0 0 1px #8c1a10, 0 2px 6px rgba(0,0,0,.4); }
@keyframes tot-holder-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
/* rising "+N gold" */
.tot-float { pointer-events: none; font: 800 17px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #ffd55a; white-space: nowrap; z-index: 120000 !important;
  text-shadow: 0 1px 0 #3b2600, 1px 0 0 #3b2600, -1px 0 0 #3b2600, 0 -1px 0 #3b2600, 0 2px 3px rgba(0,0,0,.6), 0 0 12px rgba(255,170,40,.7); }
.tot-float .tot-streak { color: #a8f2df; margin-left: 4px; text-shadow: 0 1px 0 #0d4a3e, 1px 0 0 #0d4a3e, -1px 0 0 #0d4a3e, 0 -1px 0 #0d4a3e, 0 0 8px rgba(90,210,180,.7); }
.tot-float.big { font-size: 24px; color: #ffd23f; }
.tot-float.big small, .tot-float.goal small { display: block; text-align: center; font-size: 14px; margin-top: 4px; color: #fff4c8; }
.tot-float.goal { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; font-size: 26px; color: #fff4d6;
  text-shadow: 0 1px 0 #5a2e0a, 1px 0 0 #5a2e0a, -1px 0 0 #5a2e0a, 0 -1px 0 #5a2e0a, 0 3px 4px rgba(0,0,0,.55), 0 0 26px rgba(255,170,40,.95); }
.tot-float.goal small { font-size: 16px; color: #ffe066; }
.tot-float.coin { font-size: 13px; opacity: .9; }
@media (prefers-reduced-motion: reduce) {
  .tot-label, .tot-label *, .tot-label *::before, .tot-label *::after, .tot-shift { animation: none !important; transition: none !important; }
}
`;

function ensureStyle(doc) {
  let st = doc.getElementById(STYLE_ID);
  if (!st) {
    st = doc.createElement('style');
    st.id = STYLE_ID;
    doc.head.appendChild(st);
  }
  if (st.textContent !== CSS) st.textContent = CSS; // hot reload brings new rules
}

const _v = new THREE.Vector3();

/**
 * Greedy screen placement. items: {x, y, w, h, priority, pinned?, movable?, prefer?:[dx, dy]}
 * (x, y = centre). Highest priority first (pinned before everything). An item that would
 * overlap something already placed is hidden, unless it is movable: then it tries a few
 * nearby spots (its previous spot first) and takes the first free one. A pinned item always
 * shows, at its least crowded spot. Returns Map index -> {dx, dy} of the items to show. Pure.
 */
export function placeLabels(items, pad = 4) {
  const order = items.map((_, i) => i).sort((a, b) => ((items[b].pinned ? 1e12 : 0) + items[b].priority) - ((items[a].pinned ? 1e12 : 0) + items[a].priority));
  const placed = [];
  const out = new Map();
  const rect = (it, dx, dy) => ({ l: it.x + dx - it.w / 2 - pad, r: it.x + dx + it.w / 2 + pad, t: it.y + dy - it.h / 2 - pad, b: it.y + dy + it.h / 2 + pad });
  const overlap = (r) => {
    let a = 0;
    for (const p of placed) {
      const w = Math.min(r.r, p.r) - Math.max(r.l, p.l), h = Math.min(r.b, p.b) - Math.max(r.t, p.t);
      if (w > 0 && h > 0) a += w * h;
    }
    return a;
  };
  for (const i of order) {
    const it = items[i];
    const cands = [[0, 0]];
    if (it.movable) {
      const sx = it.h + pad * 2, sw = it.w * 0.5 + 40;
      cands.push([0, -sx], [0, sx], [-sw, 0], [sw, 0], [-sw, -sx], [sw, -sx], [0, -2 * sx], [-sw, sx], [sw, sx], [0, 2 * sx]);
      if (it.prefer) cands.splice(1, 0, it.prefer);
    }
    let best = null, bestA = Infinity;
    for (const [dx, dy] of cands) {
      const r = rect(it, dx, dy);
      const a = overlap(r);
      if (a < bestA - 1e-6) { bestA = a; best = { dx, dy, r }; }
      if (a === 0) break;
    }
    if (bestA === 0 || it.pinned) {
      if (!(bestA === 0) && it.pinned && !it.movable) best = { dx: 0, dy: 0, r: rect(it, 0, 0) };
      placed.push(best.r);
      out.set(i, { dx: best.dx, dy: best.dy });
    }
  }
  return out;
}

/** Greedy overlap culling (no moving). Returns Set of indices to show. Pure: exported for tests. */
export function cullOverlaps(items, pad = 4) {
  return new Set(placeLabels(items.map((it) => ({ ...it, movable: false })), pad).keys());
}


export class LabelLayer {
  constructor(container) {
    const doc = container.ownerDocument || document;
    ensureStyle(doc);
    this.doc = doc;
    this.renderer = new CSS2DRenderer();
    this.renderer.domElement.className = 'tot-labels';
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.top = '0';
    this.renderer.domElement.style.left = '0';
    this.renderer.domElement.style.pointerEvents = 'none';
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.items = new Map();
    this.layoutT = 0;
    this.width = 1; this.height = 1;
  }

  setSize(w, h) { this.width = w; this.height = h; this.renderer.setSize(w, h); }

  _shell(key, cls) {
    const el = this.doc.createElement('div');
    el.className = cls;
    const shift = this.doc.createElement('div');
    shift.className = 'tot-shift';
    el.appendChild(shift);
    el.style.opacity = '0';
    const obj = new CSS2DObject(el);
    obj.center.set(0.5, 1);
    this.scene.add(obj);
    return { key, el, obj, shift, w: 0, h: 0, alpha: 0, flags: '', dx: 0, dy: 0, onClick: null, onHover: null };
  }

  /**
   * kind: 'built' | 'ghost' | 'thought' (optionally 'thought restless' / 'thought urgent') | 'sign'.
   * sub: a second line (signposts: the price); subDim: shown dim and reddish (cannot afford);
   * badge: a highlighted third line (signposts: passengers waiting to go there); want: stand out.
   */
  upsert(key, { text, kind, x, y, z, priority = 0, count = 0, pinned = false, movable = false, onClick = null, onHover = null, sub = '', subDim = false, badge = '', want = false, tone = '' }) {
    let it = this.items.get(key);
    if (!it) {
      it = this._shell(key, `tot-label ${kind}`);
      const pill = this.doc.createElement('div');
      pill.className = 'tot-pill';
      const row = this.doc.createElement('span');
      row.className = 'tot-row';
      const dot = this.doc.createElement('span');
      dot.className = 'tot-dot';
      const tx = this.doc.createElement('span');
      tx.className = 'tot-text';
      const cnt = this.doc.createElement('span');
      cnt.className = 'tot-count';
      row.append(dot, tx, cnt);
      const subEl = this.doc.createElement('span');
      subEl.className = 'tot-sub';
      const badgeEl = this.doc.createElement('span');
      badgeEl.className = 'tot-badge';
      pill.append(row, subEl, badgeEl);
      it.shift.appendChild(pill);
      Object.assign(it, { tx, cnt, subEl, badgeEl, kind: null, text: null, count: -1, sub: null, subDim: null, badge: null, want: null, priority });
      // interactive labels (signposts) take the pointer themselves
      const self = it;
      it.el.addEventListener('pointerdown', (e) => { if (self.onClick) e.stopPropagation(); });
      it.el.addEventListener('click', (e) => { if (self.onClick) { e.stopPropagation(); self.onClick(); } });
      it.el.addEventListener('pointerenter', () => { if (self.onHover) self.onHover(true); });
      it.el.addEventListener('pointerleave', () => { if (self.onHover) self.onHover(false); });
      this.items.set(key, it);
    }
    it.pinned = pinned;
    it.movable = movable; // may step aside on screen so labels never sit on top of each other
    it.onClick = onClick;
    it.onHover = onHover;
    it.el.style.pointerEvents = onClick && it.alpha >= 0.05 ? 'auto' : '';
    if (it.kind !== kind || it.want !== !!want || it.tone !== tone) { it.kind = kind; it.want = !!want; it.tone = tone; it.flags = '\u0000'; it.w = 0; }
    if (it.text !== text) { it.text = text; it.tx.textContent = text; it.w = 0; }
    if (it.count !== count) {
      it.count = count;
      it.cnt.textContent = count > 0 ? String(count) : '';
      it.cnt.style.display = count > 0 ? '' : 'none';
      it.w = 0;
    }
    if (it.sub !== sub || it.subDim !== !!subDim) {
      it.sub = sub; it.subDim = !!subDim;
      it.subEl.textContent = sub || '';
      it.subEl.className = `tot-sub${subDim ? ' dear' : ''}`;
      it.subEl.style.visibility = sub ? '' : 'hidden';
      it.w = 0;
    }
    if (it.badge !== badge) { it.badge = badge; it.badgeEl.textContent = badge || ''; it.w = 0; }
    if (it.flags === '\u0000') this._applyClass(it, false, false);
    it.obj.position.set(x, y, z);
    it.priority = priority;
    return it;
  }

  _applyClass(it, hover, selected) {
    it.flags = `${hover ? 'h' : ''}${selected ? 's' : ''}`;
    it.el.className = `tot-label ${it.kind}${it.want ? ' want' : ''}${it.tone ? ` ${it.tone}` : ''}${hover ? ' hover' : ''}${selected ? ' selected' : ''}`;
  }

  /**
   * An upgrade tag: one clickable chip per option, side by side.
   * options: [{typeId, title, sub, affordable}] (title/sub in plain words; falls back to
   * "name $cost" / blurb); hoverType: typeId shown hovered; goal: make it unmissable.
   */
  upsertTag(key, { x, y, z, options, hoverType = null, pinned = false, priority = 0, goal = false, onClick = null, onHover = null }) {
    let it = this.items.get(key);
    if (!it) {
      it = this._shell(key, 'tot-label tag');
      const arrow = this.doc.createElement('div');
      arrow.className = 'tot-arrow';
      arrow.textContent = '▼';
      const row = this.doc.createElement('div');
      row.className = 'tot-tagrow';
      it.shift.append(arrow, row);
      Object.assign(it, { row, kind: 'tag', text: '', count: 0, priority, sig: '', hoverType: null, goal: null });
      const typeOf = (e) => { const t = e.target && e.target.closest ? e.target.closest('.tot-tag') : null; return t ? t.dataset.type : null; };
      const self = it;
      it.el.addEventListener('pointerdown', (e) => e.stopPropagation());
      it.el.addEventListener('click', (e) => { e.stopPropagation(); const t = typeOf(e); if (t && self.onClick) self.onClick(t); });
      it.el.addEventListener('pointerover', (e) => { if (self.onHover) self.onHover(typeOf(e)); });
      it.el.addEventListener('pointerleave', () => { if (self.onHover) self.onHover(null); });
      this.items.set(key, it);
    }
    const sig = options.map((o) => o.typeId + ':' + (o.title || o.cost) + ':' + (o.sub || '') + ':' + (o.affordable ? 1 : 0)).join('|');
    if (sig !== it.sig) {
      it.sig = sig;
      it.row.textContent = '';
      for (const o of options) {
        const chip = this.doc.createElement('div');
        chip.className = 'tot-tag ' + (o.affordable ? 'afford' : 'dim');
        chip.dataset.type = o.typeId;
        const top = this.doc.createElement('span');
        top.textContent = o.title || `${o.name} ${gold(o.cost)}`;
        const small = this.doc.createElement('small');
        small.textContent = o.sub != null ? o.sub : (o.blurb || '');
        chip.append(top, small);
        it.row.appendChild(chip);
      }
      it.text = sig;
      it.w = 0;
      it.hoverType = undefined;
    }
    if (it.goal !== !!goal) {
      it.goal = !!goal;
      it.el.className = `tot-label tag${goal ? ' goal' : ''}`;
      it.w = 0;
    }
    if (hoverType !== it.hoverType) {
      it.hoverType = hoverType;
      for (const chip of it.row.children) chip.classList.toggle('hover', chip.dataset.type === hoverType);
    }
    it.obj.position.set(x, y, z);
    it.priority = priority;
    it.pinned = pinned;
    it.movable = true;
    it.onClick = onClick;
    it.onHover = onHover;
    return it;
  }

  /** Screen rects of a tag's chips (for picking the option under a 3D click). */
  tagChipAt(key, clientX, clientY) {
    const it = this.items.get(key);
    if (!it || !it.row) return null;
    for (const chip of it.row.children) {
      const b = chip.getBoundingClientRect();
      if (clientX >= b.left && clientX <= b.right && clientY >= b.top && clientY <= b.bottom) return chip.dataset.type;
    }
    return null;
  }

  /**
   * Short text rising and fading from a point ("+$95").
   * opts: {cls: 'big'|'goal'|'coin', scale, dur, rise, sub (second, smaller line), streak (accent text)}
   */
  floatText(x, y, z, text, opts = {}) {
    if (typeof opts === 'number') opts = { dur: opts };
    if (!this.floats) this.floats = [];
    const el = this.doc.createElement('div');
    el.className = `tot-float${opts.cls ? ' ' + opts.cls : ''}`;
    el.textContent = text;
    if (opts.streak) {
      const s = this.doc.createElement('span');
      s.className = 'tot-streak';
      s.textContent = opts.streak;
      el.appendChild(s);
    }
    if (opts.sub) {
      const s = this.doc.createElement('small');
      s.textContent = opts.sub;
      el.appendChild(s);
    }
    if (opts.scale && opts.scale !== 1) el.style.fontSize = `${Math.round(17 * opts.scale)}px`;
    const obj = new CSS2DObject(el);
    obj.center.set(0.5, 1);
    obj.position.set(x, y, z);
    this.scene.add(obj);
    this.floats.push({ el, obj, y0: y, age: 0, dur: opts.dur || 1.6, rise: opts.rise ?? 0.9, pop: !!opts.pop });
    while (this.floats.length > 32) this._dropFloat(this.floats[0]);
  }

  _dropFloat(f) {
    this.scene.remove(f.obj);
    f.el.remove();
    this.floats = this.floats.filter((g) => g !== f);
  }

  _updateFloats(dt) {
    if (!this.floats || !this.floats.length) return;
    for (const f of [...this.floats]) {
      f.age += dt;
      const u = f.age / f.dur;
      if (u >= 1) { this._dropFloat(f); continue; }
      f.obj.position.y = f.y0 + (1 - (1 - u) * (1 - u)) * f.rise;
      const a = u < 0.12 ? u / 0.12 : u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1;
      f.el.style.opacity = a.toFixed(2);
      if (f.pop) {
        const k = u < 0.15 ? 0.4 + (u / 0.15) * 0.8 : u < 0.25 ? 1.2 - ((u - 0.15) / 0.1) * 0.2 : 1;
        f.el.style.scale = k.toFixed(3);
      }
    }
  }

  setFlags(key, hover, selected) {
    const it = this.items.get(key);
    if (!it) return;
    const f = `${hover ? 'h' : ''}${selected ? 's' : ''}`;
    if (f === it.flags) return;
    this._applyClass(it, hover, selected);
  }

  remove(key) {
    const it = this.items.get(key);
    if (!it) return;
    this.scene.remove(it.obj);
    it.el.remove();
    this.items.delete(key);
  }

  keys() { return this.items.keys(); }

  update(camera, dt, focusKeys) {
    this._updateFloats(dt);
    this.layoutT -= dt;
    if (this.layoutT <= 0) {
      this.layoutT = 0.1;
      this._layout(camera, focusKeys);
    }
    this.renderer.render(this.scene, camera);
  }

  _layout(camera, focusKeys) {
    const W = this.width, H = this.height;
    const list = [];
    const camPos = camera.position;
    for (const it of this.items.values()) {
      _v.copy(it.obj.position);
      const dist = _v.distanceTo(camPos);
      _v.project(camera);
      const on = _v.z > -1 && _v.z < 1 && Math.abs(_v.x) < 1.15 && Math.abs(_v.y) < 1.15;
      const focused = focusKeys && focusKeys.has(it.key);
      // distance fade (ghost labels give up earlier)
      const isThought = it.kind.startsWith('thought');
      const isTag = it.kind === 'tag';
      const [near, far] = isThought ? [16, 26] : isTag ? [30, 48] : it.kind === 'ghost' ? [20, 34] : [42, 70];
      let alpha = dist <= near ? 1 : dist >= far ? 0 : 1 - (dist - near) / (far - near);
      if (it.kind === 'ghost') alpha *= 0.9;
      if (focused || it.pinned) alpha = 1;
      if (!it.w && it.obj.visible) { it.w = it.el.offsetWidth || 0; it.h = it.el.offsetHeight || 0; }
      const w = it.w || (it.text ? it.text.length * 7 + 26 : 60);
      const h = it.h || (isTag ? 40 : it.kind === 'ghost' || isThought ? 18 : 24);
      const ay = (-_v.y * 0.5 + 0.5) * H; // the anchor is the label's bottom centre
      list.push({
        it, on, alpha,
        x: (_v.x * 0.5 + 0.5) * W,
        y: ay - h / 2,
        w, h,
        pinned: !!it.pinned,
        movable: !!it.movable,
        prefer: it.movable && (it.dx || it.dy) ? [it.dx, it.dy] : null,
        priority: (focused ? 1e6 : 0) + it.priority - dist * 2,
      });
    }
    const cand = list.filter((l) => l.on && l.alpha > 0.02);
    const placed = placeLabels(cand);
    const shown = new Map();
    cand.forEach((l, i) => { const p = placed.get(i); if (p) shown.set(l.it, p); });
    for (const l of list) {
      const p = shown.get(l.it);
      const a = p ? l.alpha : 0;
      if (!l.on) { l.it.obj.visible = false; l.it.alpha = 0; l.it.el.style.opacity = '0'; continue; }
      l.it.obj.visible = true;
      if (p && (p.dx !== l.it.dx || p.dy !== l.it.dy)) {
        l.it.dx = p.dx; l.it.dy = p.dy;
        l.it.shift.style.transform = p.dx || p.dy ? `translate(${p.dx}px, ${p.dy}px)` : '';
      }
      if (Math.abs(a - l.it.alpha) > 0.02) {
        l.it.alpha = a;
        l.it.el.style.opacity = a.toFixed(2);
        l.it.el.style.pointerEvents = a < 0.05 ? 'none' : (l.it.onClick || l.it.kind === 'tag' ? 'auto' : '');
      }
    }
  }

  dispose() {
    for (const f of [...(this.floats || [])]) this._dropFloat(f);
    for (const k of [...this.items.keys()]) this.remove(k);
    this.renderer.domElement.remove();
  }
}
