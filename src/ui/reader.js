// The article reader: a centred panel over a dimmed map. Opens only for Pick { kind: 'article' }.
// Closed by Esc (index.js) or a click outside the panel. There is no close button.
import { h, clear, thumbImg } from './dom.js';
import { safeThumb, safeArticleUrl } from './format.js';

export function createReader(ctx) {
  const { state } = ctx;
  const el = h('div', { class: 'tot-reader', hidden: true });
  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });

  function open(title) {
    const st = state.stations.get(title);
    if (!st || !st.article) return;
    const a = st.article;
    clear(el);
    const photo = h('div', { class: 'tot-reader-photo' });
    const src = safeThumb(a.thumbnail);
    if (src) {
      const img = thumbImg(src, 'tot-reader-img');
      img.addEventListener('error', () => photo.classList.add('empty'));
      photo.append(img);
    } else photo.classList.add('empty');
    const url = safeArticleUrl(a.url);
    el.append(h('article', { class: 'tot-panel tot-reader-panel', role: 'dialog', 'aria-label': a.title },
      photo,
      h('div', { class: 'tot-reader-body' },
        h('h2', { text: a.title }),
        a.description ? h('p', { class: 'tot-reader-desc', text: a.description }) : null,
        a.summary ? h('p', { class: 'tot-reader-text', text: a.summary }) : null,
        url ? h('a', { class: 'tot-reader-link', href: url, target: '_blank', rel: 'noopener', text: 'Read on Wikipedia' }) : null)));
    el.hidden = false;
    el.scrollTop = 0;
  }

  function close() {
    if (el.hidden) return false;
    el.hidden = true;
    clear(el);
    return true;
  }

  return { el, open, close, get isOpen() { return !el.hidden; } };
}
