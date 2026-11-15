// A very small, slowly turning picture of each built station's article, floating above it.
// Shared geometry; one texture per station; clicking it is Pick { kind: 'article', title }.
import * as THREE from 'three';

export const CARD_W = 0.34;
export const CARD_H = 0.26;
export const CARD_LIFT = 1.45;       // above the station's ground, clear of the name label and passengers
export const CARD_PICK_R = 0.3;      // generous invisible hit proxy
const FRAME = 0.02;

/** Where a card is at game-clock t: bobbing and turning about the vertical axis. Pure. */
export function cardPose(station, t, phase = 0) {
  return { x: station.x, y: station.y + CARD_LIFT + Math.sin(t * 1.3 + phase) * 0.035, z: station.z, yaw: t * 0.55 + phase };
}

/** Crop a w x h picture to cover the card: texture repeat/offset. Pure. */
export function coverCrop(w, h, aspect = CARD_W / CARD_H) {
  if (!(w > 0) || !(h > 0)) return { rx: 1, ry: 1, ox: 0, oy: 0 };
  const a = w / h;
  if (a > aspect) { const rx = aspect / a; return { rx, ry: 1, ox: (1 - rx) / 2, oy: 0 }; }
  const ry = a / aspect;
  return { rx: 1, ry, ox: 0, oy: (1 - ry) / 2 };
}

const LETTER_COLORS = ['#c4553b', '#3f6f8f', '#5d7d4a', '#8c5a9a', '#b8862f', '#4a5568'];

/** The article's initial letter, for stations without a picture. Pure. */
export function cardInitial(title) {
  const m = String(title || '?').trim().match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : '?';
}

function browserLetterTexture(title) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = Math.round(128 * CARD_H / CARD_W);
  const g = c.getContext('2d');
  let h = 0; for (const ch of String(title)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  g.fillStyle = LETTER_COLORS[h % LETTER_COLORS.length];
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fffdf6';
  g.font = `700 ${Math.round(c.height * 0.7)}px Georgia, serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(cardInitial(title), c.width / 2, c.height / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function browserLoad(url, ok, fail) {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(url, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; ok(tex); }, undefined, fail);
}

export class ArticleCards {
  /** @param {{parent: THREE.Object3D, loadTexture?: Function, letterTexture?: Function}} o */
  constructor({ parent, loadTexture, letterTexture }) {
    this.group = new THREE.Group();
    this.group.name = 'article-cards';
    parent.add(this.group);
    this.loadTexture = loadTexture || browserLoad;
    this.letterTexture = letterTexture || browserLetterTexture;
    this.geom = new THREE.PlaneGeometry(CARD_W, CARD_H);
    this.frameGeom = new THREE.PlaneGeometry(CARD_W + FRAME * 2, CARD_H + FRAME * 2);
    this.frameMat = new THREE.MeshBasicMaterial({ color: '#fffdf6', side: THREE.DoubleSide, toneMapped: false });
    this.cards = new Map(); // title -> {group, mat, tex, url, born, phase, x, y, z}
    this.time = 0;
    this._picks = [];
  }

  _make(title, url) {
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
    const front = new THREE.Mesh(this.geom, mat);
    const back = new THREE.Mesh(this.geom, mat);
    front.position.z = 0.003;
    back.position.z = -0.003; back.rotation.y = Math.PI;
    const frame = new THREE.Mesh(this.frameGeom, this.frameMat);
    const group = new THREE.Group();
    group.add(frame, front, back);
    group.visible = false;
    this.group.add(group);
    let h = 0; for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const card = { title, group, mat, tex: null, url, born: this.time, phase: (h % 628) / 100, x: 0, y: 0, z: 0, dead: false };
    this._setTexture(card, this.letterTexture(title)); // shown at once; replaced if the picture arrives
    if (url) {
      this.loadTexture(url, (tex) => {
        if (card.dead || card.url !== url) { tex.dispose(); return; }
        const img = tex.image;
        const w = img && (img.naturalWidth || img.width), hgt = img && (img.naturalHeight || img.height);
        const c = coverCrop(w, hgt);
        tex.repeat.set(c.rx, c.ry); tex.offset.set(c.ox, c.oy);
        this._setTexture(card, tex);
      }, () => {});
    }
    return card;
  }

  _setTexture(card, tex) {
    if (card.tex) card.tex.dispose();
    card.tex = tex;
    card.mat.map = tex;
    card.mat.needsUpdate = true;
  }

  _remove(title) {
    const c = this.cards.get(title);
    if (!c) return;
    c.dead = true;
    this.group.remove(c.group);
    c.mat.dispose();
    if (c.tex) c.tex.dispose();
    this.cards.delete(title);
  }

  /** @param built Map title -> {x,y,z,born} (StationsView.built); @param state GameState */
  update(dt, built, state) {
    this.time += dt;
    const st = state && state.stations;
    for (const [title, s] of built) {
      const info = st && typeof st.get === 'function' ? st.get(title) : null;
      const url = info && info.article && typeof info.article.thumbnail === 'string' && info.article.thumbnail ? info.article.thumbnail : null;
      let c = this.cards.get(title);
      if (c && c.url !== url) { this._remove(title); c = null; }
      if (!c) { c = this._make(title, url); this.cards.set(title, c); }
      if (s.born != null) { c.group.visible = false; continue; } // station still rising
      const pose = cardPose(s, this.time, c.phase);
      const k = Math.max(0.001, Math.min(1, (this.time - c.born) / 0.5));
      c.group.visible = true;
      c.group.position.set(pose.x, pose.y, pose.z);
      c.group.rotation.y = pose.yaw;
      c.group.scale.setScalar(k * (2 - k)); // ease out
      c.x = pose.x; c.y = pose.y; c.z = pose.z;
    }
    for (const title of [...this.cards.keys()]) if (!built.has(title)) this._remove(title);
  }

  /** Hit proxies, reused each call (do not keep). */
  pickables() {
    this._picks.length = 0;
    for (const c of this.cards.values()) if (c.group.visible) this._picks.push({ kind: 'article', title: c.title, x: c.x, y: c.y, z: c.z, r: CARD_PICK_R });
    return this._picks;
  }

  dispose() {
    for (const t of [...this.cards.keys()]) this._remove(t);
    this.geom.dispose(); this.frameGeom.dispose(); this.frameMat.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
