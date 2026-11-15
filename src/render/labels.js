// Station titles as DOM labels (CSS2DRenderer): always crisp text. Labels fade
// with distance and a greedy screen-space pass hides the lower-priority ones that
// would overlap, so the map never turns into a word cloud.
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const STYLE_ID = 'tot-render-labels-style';
const CSS = `
.tot-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.tot-label { pointer-events: none; transition: opacity .25s ease; white-space: nowrap; will-change: transform, opacity;
  font: 600 13px/1.15 ui-rounded, system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: .01em; }
.tot-label .tot-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px 4px 8px; border-radius: 999px;
  color: #fffdf6; background: rgba(28, 34, 46, .78); box-shadow: 0 2px 8px rgba(0,0,0,.22), inset 0 0 0 1px rgba(255,255,255,.12);
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
.tot-label .tot-dot { width: 7px; height: 7px; border-radius: 50%; background: #ffd36b; box-shadow: 0 0 6px #ffd36b; flex: none; }
.tot-label .tot-count { font-weight: 700; font-size: 11px; color: #9ff3ff; }
.tot-label.ghost { font-weight: 500; font-size: 11.5px; }
.tot-label.ghost .tot-pill { color: rgba(240, 248, 255, .92); background: rgba(40, 52, 70, .45);
  box-shadow: inset 0 0 0 1px rgba(200, 230, 255, .35); padding: 2px 8px; }
.tot-label.ghost .tot-dot { background: transparent; box-shadow: inset 0 0 0 1.5px #bfe8ff; }
.tot-label.thought { font-weight: 600; font-size: 11px; }
.tot-label.thought .tot-pill { color: #2b2619; background: rgba(255, 251, 238, .95); padding: 2px 8px; border-radius: 10px 10px 10px 2px;
  box-shadow: 0 2px 6px rgba(0,0,0,.28); backdrop-filter: none; -webkit-backdrop-filter: none; }
.tot-label.thought .tot-dot { display: none; }
.tot-label.thought.restless .tot-pill { background: rgba(255, 228, 150, .96); }
.tot-label.thought.urgent .tot-pill { background: rgba(255, 120, 105, .97); color: #2a0b08; }
.tot-label.hover .tot-pill { background: rgba(28, 34, 46, .9); box-shadow: 0 0 0 2px #ffe08a, 0 4px 14px rgba(0,0,0,.3); }
.tot-label.selected .tot-pill { background: rgba(28, 34, 46, .95); box-shadow: 0 0 0 2px #ffd966, 0 4px 16px rgba(0,0,0,.35); }
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  doc.head.appendChild(st);
}

const _v = new THREE.Vector3();

/**
 * Greedy overlap culling. items: {x, y, w, h, priority}. Returns Set of indices to show.
 * Pure: exported for tests.
 */
export function cullOverlaps(items, pad = 4) {
  const order = items.map((_, i) => i).sort((a, b) => items[b].priority - items[a].priority);
  const placed = [];
  const show = new Set();
  for (const i of order) {
    const it = items[i];
    const r = { l: it.x - it.w / 2 - pad, r: it.x + it.w / 2 + pad, t: it.y - it.h / 2 - pad, b: it.y + it.h / 2 + pad };
    let hit = false;
    for (const p of placed) if (r.l < p.r && r.r > p.l && r.t < p.b && r.b > p.t) { hit = true; break; }
    if (!hit) { placed.push(r); show.add(i); }
  }
  return show;
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

  /** kind: 'built' | 'ghost' | 'thought' (optionally 'thought restless' / 'thought urgent') */
  upsert(key, { text, kind, x, y, z, priority = 0, count = 0 }) {
    let it = this.items.get(key);
    if (!it) {
      const el = this.doc.createElement('div');
      el.className = `tot-label ${kind}`;
      const pill = this.doc.createElement('div');
      pill.className = 'tot-pill';
      const dot = this.doc.createElement('span');
      dot.className = 'tot-dot';
      const tx = this.doc.createElement('span');
      tx.className = 'tot-text';
      const cnt = this.doc.createElement('span');
      cnt.className = 'tot-count';
      pill.append(dot, tx, cnt);
      el.appendChild(pill);
      el.style.opacity = '0';
      const obj = new CSS2DObject(el);
      obj.center.set(0.5, 1);
      this.scene.add(obj);
      it = { key, el, obj, tx, cnt, kind: null, text: null, count: -1, priority, w: 0, alpha: 0, flags: '' };
      this.items.set(key, it);
    }
    if (it.kind !== kind) { it.kind = kind; it.flags = ''; it.el.className = `tot-label ${kind}`; it.w = 0; }
    if (it.text !== text) { it.text = text; it.tx.textContent = text; it.w = 0; }
    if (it.count !== count) {
      it.count = count;
      it.cnt.textContent = count > 0 ? String(count) : '';
      it.cnt.style.display = count > 0 ? '' : 'none';
      it.w = 0;
    }
    it.obj.position.set(x, y, z);
    it.priority = priority;
    return it;
  }

  setFlags(key, hover, selected) {
    const it = this.items.get(key);
    if (!it) return;
    const f = `${hover ? 'h' : ''}${selected ? 's' : ''}`;
    if (f === it.flags) return;
    it.flags = f;
    it.el.className = `tot-label ${it.kind}${hover ? ' hover' : ''}${selected ? ' selected' : ''}`;
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
      const [near, far] = isThought ? [16, 26] : it.kind === 'ghost' ? [20, 34] : [42, 70];
      let alpha = dist <= near ? 1 : dist >= far ? 0 : 1 - (dist - near) / (far - near);
      if (it.kind === 'ghost') alpha *= 0.9;
      if (focused) alpha = 1;
      if (!it.w && it.obj.visible) it.w = it.el.offsetWidth || 0;
      const w = it.w || (it.text ? it.text.length * 7 + 26 : 60);
      list.push({
        it, on, alpha,
        x: (_v.x * 0.5 + 0.5) * W,
        y: (-_v.y * 0.5 + 0.5) * H - 12,
        w, h: it.kind === 'ghost' || isThought ? 18 : 24,
        priority: (focused ? 1e6 : 0) + it.priority - dist * 2,
      });
    }
    const cand = list.filter((l) => l.on && l.alpha > 0.02);
    const show = cullOverlaps(cand);
    const shown = new Set();
    cand.forEach((l, i) => { if (show.has(i)) shown.add(l.it); });
    for (const l of list) {
      const vis = shown.has(l.it);
      const a = vis ? l.alpha : 0;
      if (!l.on) { l.it.obj.visible = false; l.it.alpha = 0; l.it.el.style.opacity = '0'; continue; }
      l.it.obj.visible = true;
      if (Math.abs(a - l.it.alpha) > 0.02) {
        l.it.alpha = a;
        l.it.el.style.opacity = a.toFixed(2);
      }
    }
  }

  dispose() {
    for (const k of [...this.items.keys()]) this.remove(k);
    this.renderer.domElement.remove();
  }
}
