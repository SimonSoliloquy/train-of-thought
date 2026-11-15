// Built track meshes (one merged mesh per Track, drawn in arc-length order so it can
// animate "laying itself"), the route preview ribbon, and the glow on tracks that
// have an affordable upgrade.
import * as THREE from 'three';
import { buildTrack, buildRibbon, vertexCountAt, resample, gradeSegments } from './track.js';
import { sampleRoute } from './rail.js';
import { Network } from './lanes.js';

export class TracksView {
  constructor({ parent, materials, terrain, fx }) {
    this.group = new THREE.Group();
    this.group.name = 'tracks';
    this.previewGroup = new THREE.Group();
    this.previewGroup.name = 'route-preview';
    this.highlightGroup = new THREE.Group();
    this.highlightGroup.name = 'upgrade-glow';
    parent.add(this.group, this.previewGroup, this.highlightGroup);
    this.materials = materials;
    this.terrain = terrain;
    this.fx = fx || null;
    this.tracks = new Map(); // id -> rec
    this.preview = [];
    this.glows = new Map(); // track id -> {mesh, material, strength, target, hovered}
    this.time = 0;
    this.groundAt = (x, z) => terrain.groundAt(x, z);
    this.naturalAt = (x, z) => (terrain.naturalAt ? terrain.naturalAt(x, z) : terrain.groundAt(x, z));
    this.dirty = new Set(); // track ids whose geometry must follow a changed surface
    this.network = new Network(); // every drawn track's centreline: lanes, crossings
  }

  _geometry(route, id) {
    return buildTrack(route, { groundAt: this.groundAt, naturalAt: this.naturalAt, network: this.network, id });
  }

  _grade(rec) {
    if (this.terrain.setTrackGrade) this.terrain.setTrackGrade(rec.id, gradeSegments(rec.track.route, this.naturalAt, { network: this.network, id: rec.id }));
  }

  /** Tracks near box (other than skip) must follow a track that was added or removed there: regrade and refit them. */
  _neighboursChanged(box, skip) {
    for (const rec of this.tracks.values()) {
      if (rec.id === skip) continue;
      const b = rec.box;
      if (b.maxX < box.minX || b.minX > box.maxX || b.maxZ < box.minZ || b.minZ > box.maxZ) continue;
      this._grade(rec);
      this.dirty.add(rec.id);
    }
  }

  /** The land changed inside box: refit piers, walls and portals of the tracks there. */
  terrainChanged(box) {
    for (const rec of this.tracks.values()) {
      const b = rec.box;
      if (!b || b.maxX < box.minX || b.minX > box.maxX || b.maxZ < box.minZ || b.minZ > box.maxZ) continue;
      this.dirty.add(rec.id);
    }
  }

  _refit(rec) {
    const built = this._geometry(rec.track.route, rec.id);
    rec.mesh.geometry.dispose();
    rec.mesh.geometry = built.builder.toGeometry();
    rec.marks = built.marks;
    rec.total = built.builder.vertexCount;
    rec.portals = built.portals;
    rec.buried = built.buried;
  }

  /**
   * Whether arc length s along a track lies inside its tunnel (the same stretches the track
   * mesh leaves out), or null when the track is not drawn.
   */
  buriedAt(id, s) {
    const rec = this.tracks.get(id);
    if (!rec || !rec.buried) return null;
    for (const [a, b] of rec.buried) if (s >= a && s <= b) return true;
    return false;
  }

  has(id) { return this.tracks.has(id); }

  add(track, animate) {
    if (!track || track.id == null || this.tracks.has(track.id) || !track.route || !Array.isArray(track.route.points) || track.route.points.length < 2) return;
    // grade the land under the line first, so piers and walls meet the final surface
    this.network.set(track.id, track.route);
    if (this.terrain.setTrackGrade) this.terrain.setTrackGrade(track.id, gradeSegments(track.route, this.naturalAt, { network: this.network, id: track.id }));
    const built = this._geometry(track.route, track.id);
    const geom = built.builder.toGeometry();
    const mesh = new THREE.Mesh(geom, this.materials.track);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `track-${track.id}`;
    const total = built.builder.vertexCount;
    const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const p of track.route.points) { box.minX = Math.min(box.minX, p.x); box.maxX = Math.max(box.maxX, p.x); box.minZ = Math.min(box.minZ, p.z); box.maxZ = Math.max(box.maxZ, p.z); }
    box.minX -= 1; box.maxX += 1; box.minZ -= 1; box.maxZ += 1;
    const rec = { id: track.id, track, mesh, box, portals: built.portals, buried: built.buried, marks: built.marks, total, length: built.length, t: animate ? 0 : 1, dur: Math.min(1.8, Math.max(0.7, built.length * 0.09)) };
    this.dirty.delete(track.id);
    if (animate) geom.setDrawRange(0, 0);
    this.group.add(mesh);
    this.tracks.set(track.id, rec);
    // clear props off the line (not over tunnels: the mountain keeps its trees)
    const circles = [];
    for (const p of resample(track.route, 0.22)) if (p.kind !== 'tunnel') circles.push({ x: p.x, z: p.z, r: 0.45 });
    this.terrain.block(circles);
    this._neighboursChanged(box, track.id);
  }

  remove(id) {
    const rec = this.tracks.get(id);
    if (!rec) return;
    this.network.delete(id);
    this.group.remove(rec.mesh);
    rec.mesh.geometry.dispose();
    this.tracks.delete(id);
    this._dropGlow(id);
    if (this.terrain.setTrackGrade) this.terrain.setTrackGrade(id, null);
    this._neighboursChanged(rec.box, id);
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

  /**
   * Glow along tracks: wanted = Map(trackId -> {hovered:boolean}). Tracks not listed fade out.
   */
  setGlow(wanted) {
    for (const [id, w] of wanted) {
      const rec = this.tracks.get(id);
      if (!rec) continue;
      let g = this.glows.get(id);
      if (!g) {
        const material = new THREE.MeshBasicMaterial({
          color: new THREE.Color('#ffc94a'), transparent: true, opacity: 0, depthWrite: false,
          blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
        });
        const bld = buildRibbon(rec.track.route, { width: 0.56, lift: 0.04, groundAt: this.groundAt, mode: 'highlight' });
        const mesh = new THREE.Mesh(bld.toGeometry(), material);
        mesh.renderOrder = 9;
        mesh.frustumCulled = false;
        this.highlightGroup.add(mesh);
        g = { mesh, material, strength: 0 };
        this.glows.set(id, g);
      }
      g.target = 1;
      g.hovered = !!w.hovered;
    }
    for (const [id, g] of this.glows) if (!wanted.has(id)) { g.target = 0; g.hovered = false; }
  }

  _dropGlow(id) {
    const g = this.glows.get(id);
    if (!g) return;
    this.highlightGroup.remove(g.mesh);
    g.mesh.geometry.dispose();
    g.material.dispose();
    this.glows.delete(id);
  }

  update(dt) {
    this.time += dt;
    for (const id of this.dirty) {
      const rec = this.tracks.get(id);
      if (!rec) { this.dirty.delete(id); continue; }
      if (rec.t < 1) continue; // refit once it has finished laying itself
      this._refit(rec);
      this.dirty.delete(id);
    }
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
    const pulse2 = 0.5 + 0.5 * Math.sin(this.time * 2.6);
    for (const [id, g] of this.glows) {
      g.strength += ((g.target || 0) - g.strength) * Math.min(1, dt * 5);
      if (g.strength < 0.01 && !g.target) { this._dropGlow(id); continue; }
      const base = g.hovered ? 0.7 + 0.2 * pulse2 : 0.14 + 0.18 * pulse2;
      g.material.opacity = base * g.strength;
    }
  }

  dispose() {
    for (const id of [...this.tracks.keys()]) this.remove(id);
    this.setPreview(null);
    for (const id of [...this.glows.keys()]) this._dropGlow(id);
    for (const g of [this.group, this.previewGroup, this.highlightGroup]) if (g.parent) g.parent.remove(g);
  }
}
