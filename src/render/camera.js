// Camera: MapControls orbit with damping and limits, smooth glides (focus), and a
// ride-along chase camera that hands back to free orbit with a glide.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

export const CAM = {
  minDistance: 4.5,
  maxDistance: 70,
  minPolar: 0.22,
  maxPolar: 1.18,
  startDistance: 17,
  startPolar: 0.88,
  startAzimuth: 0.55,
  focusDistance: 11,
};

function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

const _sph = new THREE.Spherical();
const _sph2 = new THREE.Spherical();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/**
 * How far `from` must rise so that the land stays at least `clear` below the line from it to
 * `to` (and below `from` itself). Raising `from` by d lifts the point at u along the line by
 * d * (1 - u). Pure.
 */
export function sightLift(from, to, groundAt, clear = 0.3) {
  let need = 0;
  for (const u of [0, 0.12, 0.25, 0.4, 0.55, 0.7, 0.82]) {
    const x = from.x + (to.x - from.x) * u, y = from.y + (to.y - from.y) * u, z = from.z + (to.z - from.z) * u;
    const g = groundAt(x, z);
    if (!Number.isFinite(g)) continue;
    const deficit = g + clear * (1 - u) - y;
    if (deficit > 0) need = Math.max(need, deficit / (1 - u));
  }
  return need;
}

export class CameraRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    const c = new MapControls(camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.085;
    c.screenSpacePanning = false;
    c.minDistance = CAM.minDistance;
    c.maxDistance = CAM.maxDistance;
    c.minPolarAngle = CAM.minPolar;
    c.maxPolarAngle = CAM.maxPolar;
    c.zoomToCursor = true;
    c.zoomSpeed = 1.1;
    c.rotateSpeed = 0.6;
    c.panSpeed = 1.0;
    this.controls = c;
    this.glide = null;
    this.followId = null;
    this.chase = null; // smoothed chase state
    this.userActive = false;
    this.groundY = 0;
    _sph.set(CAM.startDistance, CAM.startPolar, CAM.startAzimuth);
    c.target.set(0, 0, 0);
    camera.position.copy(_v.setFromSpherical(_sph));
    camera.lookAt(c.target);
    c.update();
    this._onStart = () => {
      this.userActive = true;
      if (this.glide && !this.glide.locked) this.glide = null;
    };
    this._onEnd = () => { this.userActive = false; };
    c.addEventListener('start', this._onStart);
    c.addEventListener('end', this._onEnd);
  }

  get target() { return this.controls.target; }
  get distance() { return this.camera.position.distanceTo(this.controls.target); }

  /** Glide target + camera to look at p from the current direction (optionally new distance). */
  glideTo(p, distance = null, dur = 0.9, polar = null) {
    const c = this.controls;
    const fromT = c.target.clone();
    _sph.setFromVector3(_v.copy(this.camera.position).sub(c.target));
    const from = { r: _sph.radius, phi: _sph.phi, theta: _sph.theta };
    const toPhi = polar != null ? polar : Math.min(CAM.maxPolar, Math.max(CAM.minPolar, from.phi));
    const to = { r: distance != null ? distance : from.r, phi: toPhi, theta: from.theta };
    this.glide = { fromT, toT: new THREE.Vector3(p.x, p.y, p.z), from, to, t: 0, dur, locked: false };
    this.controls.enabled = false;
  }

  focus(p) {
    this.stopFollow(false);
    this.glideTo(p, Math.min(this.distance, CAM.focusDistance), 1.0);
  }

  follow(id) {
    if (id == null) { this.stopFollow(true); return; }
    this.followId = id;
    this.glide = null;
    this.chase = null;
    this.controls.enabled = false;
  }

  /** Leave the chase camera; glide back to a comfortable orbit around the point ahead. */
  stopFollow(glide = true) {
    if (this.followId == null) return;
    this.followId = null;
    const look = this.chase ? this.chase.look.clone() : this.controls.target.clone();
    this.chase = null;
    if (glide) {
      // set the orbit target to what we were looking at, then glide out to a nicer tilt
      this.controls.target.copy(look);
      this.glideTo(look, Math.max(CAM.focusDistance, this.distance), 0.9, 0.85);
    } else {
      this.controls.target.copy(look);
      this.controls.enabled = true;
    }
  }

  /**
   * @param {number} dt
   * @param {{head:(id)=>object|null, groundAt:(x,z)=>number, bounds:object}} env
   */
  update(dt, env) {
    const cam = this.camera, c = this.controls;
    if (this.followId != null) {
      const h = env.head ? env.head(this.followId) : null;
      if (!h) { this.stopFollow(true); }
      else {
        let fx = h.dx, fz = h.dz;
        const fl = Math.hypot(fx, fz) || 1;
        fx /= fl; fz /= fl;
        const desiredPos = _v.set(h.x - fx * 2.6, h.y + 1.25, h.z - fz * 2.6);
        if (env.groundAt) {
          // ride over cliffs and mountains instead of through them
          let gmax = -Infinity;
          for (let k = 0; k <= 4; k++) {
            const u = k / 4;
            gmax = Math.max(gmax, env.groundAt(h.x - fx * 2.6 * u, h.z - fz * 2.6 * u));
          }
          if (h.inTunnel) gmax = Math.max(gmax, env.groundAt(h.x, h.z));
          desiredPos.y = Math.max(desiredPos.y, gmax + 0.9);
        }
        const desiredLook = _v2.set(h.x + fx * 3.0, h.y + 0.15, h.z + fz * 3.0);
        // in a valley or gorge, keep a clear line from the camera to the train
        if (env.groundAt && !h.inTunnel) desiredPos.y += sightLift(desiredPos, _v3.set(h.x, h.y + 0.2, h.z), env.groundAt, 0.25);
        if (!this.chase) this.chase = { pos: cam.position.clone(), look: c.target.clone(), blend: 0 };
        const ch = this.chase;
        ch.blend = Math.min(1, ch.blend + dt * 0.9);
        const k = 1 - Math.exp(-dt * (2 + ch.blend * 4));
        ch.pos.lerp(desiredPos, k);
        ch.look.lerp(desiredLook, Math.min(1, k * 1.4));
        // never dip under the terrain
        const g = env.groundAt ? env.groundAt(ch.pos.x, ch.pos.z) : 0;
        if (ch.pos.y < g + 0.35) ch.pos.y = g + 0.35;
        cam.position.copy(ch.pos);
        cam.lookAt(ch.look);
        return;
      }
    }
    if (this.glide) {
      const gl = this.glide;
      gl.t += dt / gl.dur;
      const e = easeInOut(Math.min(1, gl.t));
      c.target.lerpVectors(gl.fromT, gl.toT, e);
      let dTheta = gl.to.theta - gl.from.theta;
      while (dTheta > Math.PI) dTheta -= Math.PI * 2;
      while (dTheta < -Math.PI) dTheta += Math.PI * 2;
      _sph2.set(
        gl.from.r + (gl.to.r - gl.from.r) * e,
        gl.from.phi + (gl.to.phi - gl.from.phi) * e,
        gl.from.theta + dTheta * e,
      );
      cam.position.copy(c.target).add(_v.setFromSpherical(_sph2));
      cam.lookAt(c.target);
      if (gl.t >= 1) {
        this.glide = null;
        c.enabled = true;
        c.update();
      }
      return;
    }
    c.enabled = true;
    c.update(dt);
    // keep the target on the ground (move camera along) and inside the revealed land
    const t = c.target;
    const b = env.bounds;
    let dx = 0, dz = 0;
    if (b && !b.empty) {
      const m = 4;
      const cx = Math.min(b.maxX + m, Math.max(b.minX - m, t.x));
      const cz = Math.min(b.maxZ + m, Math.max(b.minZ - m, t.z));
      dx = (cx - t.x) * Math.min(1, dt * 6);
      dz = (cz - t.z) * Math.min(1, dt * 6);
    }
    const g = env.groundAt ? env.groundAt(t.x, t.z) : 0;
    this.groundY += (Math.max(0, g) - this.groundY) * Math.min(1, dt * 3);
    const dy = this.groundY - t.y;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-6) {
      t.x += dx; t.y += dy; t.z += dz;
      cam.position.x += dx; cam.position.y += dy; cam.position.z += dz;
    }
    this._keepClear(env, Math.min(1, dt * 10));
  }

  /** Lift the orbit camera out of hills: above the land under it, with a clear view of the target. */
  _keepClear(env, k) {
    if (!env || !env.groundAt) return;
    const cam = this.camera;
    const need = sightLift(cam.position, this.controls.target, env.groundAt, 0.35);
    if (need > 0) {
      const g = env.groundAt(cam.position.x, cam.position.z);
      const hard = Number.isFinite(g) ? Math.max(0, g + 0.5 - cam.position.y) : 0;
      cam.position.y += Math.max(hard, need * k);
    }
  }

  dispose() {
    this.controls.removeEventListener('start', this._onStart);
    this.controls.removeEventListener('end', this._onEnd);
    this.controls.dispose();
  }
}
