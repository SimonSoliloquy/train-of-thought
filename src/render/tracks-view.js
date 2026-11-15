// Built track meshes (one merged mesh per Track, drawn in arc-length order so it can
// animate "laying itself"), route preview ribbons, and line highlight ribbons.
import * as THREE from 'three';
import { buildTrack, buildRibbon, vertexCountAt, resample } from './track.js';
import { sampleRoute } from './rail.js';

export class TracksView {
  constructor({ parent, materials, terrain, fx }) {
    this.group = new THREE.Group();
    this.group.name = 'tracks';
    this.previewGroup = new THREE.Group();
    this.previewGroup.name = 'route-preview';
    this.highlightGroup = new THREE.Group();
    this.highlightGroup.name = 'line-highlight';
    parent.add(this.group, this.previewGroup, this.highlightGroup);
    this.materials = materials;
    this.terrain = terrain;
    this.fx = fx || null;
    this.tracks = new Map(); // id -> rec
    this.preview = [];
    this.highlight = { lineId: null, key: '', meshes: [], material: null };
    this.time = 0;
    this.groundAt = (x, z) => terrain.groundAt(x, z);
  }

  has(id) { return this.tracks.has(id); }

  add(track, animate) {
    if (!track || track.id == null || this.tracks.has(track.id) || !track.route || !Array.isArray(track.route.points) || track.route.points.length < 2) return;
    const built = buildTrack(track.route, { groundAt: this.groundAt });
    const geom = built.builder.toGeometry();
    const mesh = new THREE.Mesh(geom, this.materials.track);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `track-${track.id}`;
    const total = built.builder.vertexCount;
    const rec = { id: track.id, track, mesh, marks: built.marks, total, length: built.length, t: animate ? 0 : 1, dur: Math.min(1.8, Math.max(0.7, built.length * 0.09)) };
    if (animate) geom.setDrawRange(0, 0);
    this.group.add(mesh);
    this.tracks.set(track.id, rec);
    // clear props off the line (not over tunnels: the mountain keeps its trees)
    const circles = [];
    for (const p of resample(track.route, 0.22)) if (p.kind !== 'tunnel') circles.push({ x: p.x, z: p.z, r: 0.3 });
    this.terrain.block(circles);
  }

  remove(id) {
    const rec = this.tracks.get(id);
    if (!rec) return;
    this.group.remove(rec.mesh);
    rec.mesh.geometry.dispose();
    this.tracks.delete(id);
  }

  /** Reconcile with game.state.tracks. */
  sync(tracks, animate) {
    const seen = new Set();
    for (const t of tracks || []) {
      if (!t) continue;
      seen.add(t.id);
      if (!this.tracks.has(t.id)) this.add(t, animate);
    }
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.remove(id);
  }

  setPreview(routes, activeStyle) {
    for (const p of this.preview) { this.previewGroup.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); }
    this.preview = [];
    if (!Array.isArray(routes)) return;
    const valid = routes.filter((r) => r && Array.isArray(r.points) && r.points.length >= 2);
    const active = activeStyle || (valid[0] && valid[0].style);
    // draw dim ones first so the active ribbon sits on top
    const sorted = valid.slice().sort((a, b) => (a.style === active) - (b.style === active));
    sorted.forEach((route, i) => {
      const isActive = route.style === active;
      const bld = buildRibbon(route, { width: isActive ? 0.3 : 0.2, lift: isActive ? 0.16 : 0.12, groundAt: this.groundAt, mode: 'preview', chevrons: isActive });
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: isActive ? 0.92 : 0.32, depthWrite: false,
        toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(bld.toGeometry(), mat);
      mesh.renderOrder = 10 + i;
      mesh.frustumCulled = false;
      this.previewGroup.add(mesh);
      this.preview.push({ mesh, active: isActive, route });
    });
  }

  setHighlight(lineId, state) {
    const lines = (state && state.lines) || [];
    const tracks = (state && state.tracks) || [];
    const line = lineId == null ? null : lines.find((l) => l.id === lineId);
    const ids = [];
    if (line && Array.isArray(line.stations)) {
      for (let i = 0; i + 1 < line.stations.length; i++) {
        const a = line.stations[i], b = line.stations[i + 1];
        const tr = tracks.find((t) => (t.from === a && t.to === b) || (t.from === b && t.to === a));
        if (tr) ids.push(tr.id);
      }
    }
    const key = line ? `${line.id}|${line.color}|${ids.join(',')}` : '';
    const h = this.highlight;
    h.lineId = lineId;
    if (key === h.key) return;
    h.key = key;
    for (const m of h.meshes) { this.highlightGroup.remove(m); m.geometry.dispose(); }
    h.meshes = [];
    if (h.material) { h.material.dispose(); h.material = null; }
    if (!line) return;
    h.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(line.color || '#ffffff'), transparent: true, opacity: 0.6, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
    });
    for (const id of ids) {
      const tr = tracks.find((t) => t.id === id);
      const bld = buildRibbon(tr.route, { width: 0.5, lift: 0.045, groundAt: this.groundAt, mode: 'highlight' });
      const mesh = new THREE.Mesh(bld.toGeometry(), h.material);
      mesh.renderOrder = 9;
      mesh.frustumCulled = false;
      this.highlightGroup.add(mesh);
      h.meshes.push(mesh);
    }
  }

  update(dt) {
    this.time += dt;
    for (const rec of this.tracks.values()) {
      if (rec.t >= 1) continue;
      rec.t = Math.min(1, rec.t + dt / rec.dur);
      const e = 1 - Math.pow(1 - rec.t, 2);
      const s = e * rec.length;
      rec.mesh.geometry.setDrawRange(0, rec.t >= 1 ? Infinity : vertexCountAt(rec.marks, s));
      if (this.fx && rec.t < 1) {
        const p = sampleRoute(rec.track.route, e);
        this.fx(p.x, p.y, p.z, p.kind);
      }
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 3.2);
    for (const p of this.preview) p.mesh.material.opacity = p.active ? 0.72 + 0.24 * pulse : 0.3;
    if (this.highlight.material) this.highlight.material.opacity = 0.42 + 0.3 * (0.5 + 0.5 * Math.sin(this.time * 2.4));
  }

  dispose() {
    for (const id of [...this.tracks.keys()]) this.remove(id);
    this.setPreview(null);
    this.setHighlight(null, null);
    for (const g of [this.group, this.previewGroup, this.highlightGroup]) if (g.parent) g.parent.remove(g);
  }
}
