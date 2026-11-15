// Tiny DOM helpers. Text always goes in as text nodes / textContent, never as HTML.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(el, kids);
  return el;
}

export function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) {
  el.textContent = '';
  return el;
}

/** Set text only when it changed, so per-tick refreshes do not touch the DOM needlessly. */
export function setText(node, s) {
  if (node._t !== s) {
    node.textContent = s;
    node._t = s;
  }
}

export function setClass(node, name, on) {
  if (node.classList.contains(name) !== !!on) node.classList.toggle(name, !!on);
}

export function setDisabled(node, on) {
  if (node.disabled !== !!on) node.disabled = !!on;
}

export function setWidth(node, frac) {
  const w = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
  if (node._w !== w) {
    node.style.width = w;
    node._w = w;
  }
}

export function createBus() {
  const m = new Map();
  return {
    on(name, fn) {
      if (!m.has(name)) m.set(name, new Set());
      m.get(name).add(fn);
      return () => m.get(name).delete(fn);
    },
    emit(name, payload) {
      const s = m.get(name);
      if (s) for (const fn of [...s]) fn(payload);
    },
  };
}

/** A small round-ish thumbnail <img> that removes itself if it fails to load. */
export function thumbImg(src, cls) {
  const img = h('img', { class: cls, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.remove());
  img.src = src;
  return img;
}
