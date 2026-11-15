// Lines panel (bottom), line-drawing mode banner, and the ride-along bar.
import { TRAIN_TYPES } from '../config.js';
import { h, clear, setText, setClass, setDisabled } from './dom.js';
import { fmtMoney, trainPrice, chainText, canAppendStop } from './format.js';

export function createLines(ctx) {
  const { game, renderer, state } = ctx;
  let collapsed = false;
  let live = { buys: [], pax: [], rides: [] }; // per-tick refs, rebuilt with the cards
  let flashTimer = 0;

  // ---------------------------------------------------------- panel shell

  const newBtn = h('button', { class: 'tot-btn tot-btn-primary', type: 'button', text: '+ New line', onClick: () => enterMode(null) });
  const toggle = h('button', { class: 'tot-iconbtn', type: 'button', title: 'Collapse', text: '–', onClick: () => {
    collapsed = !collapsed;
    el.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? '+' : '–';
    toggle.title = collapsed ? 'Expand' : 'Collapse';
  } });
  const row = h('div', { class: 'tot-lines-row' });
  const el = h(
    'section',
    { class: 'tot-panel tot-lines' },
    h('div', { class: 'tot-panel-head' }, h('h2', { text: 'Lines' }), newBtn, toggle),
    row,
  );

  // ---------------------------------------------------------- mode banner

  const bannerTitle = h('strong');
  const bannerChain = h('div', { class: 'tot-chain' });
  const bannerNote = h('div', { class: 'tot-note bad', hidden: true });
  const undoBtn = h('button', { class: 'tot-btn tot-btn-small', type: 'button', text: 'Undo', onClick: undo });
  const doneBtn = h('button', { class: 'tot-btn tot-btn-small tot-btn-primary', type: 'button', text: 'Done', onClick: done });
  const cancelBtn = h('button', { class: 'tot-btn tot-btn-small', type: 'button', text: 'Cancel (Esc)', onClick: () => exitMode() });
  const banner = h(
    'div',
    { class: 'tot-panel tot-banner', hidden: true },
    h('div', { class: 'tot-banner-head' }, bannerTitle, h('span', { text: 'Click stations in order, then Done.' })),
    bannerChain, bannerNote,
    h('div', { class: 'tot-banner-actions' }, undoBtn, cancelBtn, doneBtn),
  );
  let noteTimer = 0;

  function note(text) {
    bannerNote.textContent = text;
    bannerNote.hidden = !text;
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => note(''), 5000);
  }

  function drawBanner() {
    const m = ctx.mode;
    banner.hidden = !m;
    if (!m) return;
    const line = m.editId != null ? state.lines.find((l) => l.id === m.editId) : null;
    setText(bannerTitle, line ? `Editing ${line.name}.` : 'Drawing a new line.');
    setText(bannerChain, m.stops.length ? chainText(m.stops) : 'No stops yet');
    bannerChain.title = chainText(m.stops);
    setDisabled(undoBtn, !m.stops.length);
    setDisabled(doneBtn, m.stops.length < 2);
  }

  function enterMode(line) {
    ctx.stopRide();
    ctx.setMode({ type: 'line', editId: line ? line.id : null, stops: line ? line.stations.slice() : [] });
    note('');
    drawBanner();
    syncSelectionRing();
    drawNewBtn();
  }

  function exitMode() {
    ctx.setMode(null);
    note('');
    renderer.setSelection(null);
    drawBanner();
    drawNewBtn();
  }

  function syncSelectionRing() {
    const m = ctx.mode;
    renderer.setSelection(m && m.stops.length ? m.stops[m.stops.length - 1] : null);
  }

  function drawNewBtn() {
    setDisabled(newBtn, !!ctx.mode);
  }

  function addStop(title) {
    const m = ctx.mode;
    if (!m) return;
    const ok = canAppendStop(m.stops, title, state, (a, b) => !!game.trackBetween(a, b));
    if (!ok.ok) {
      note(ok.reason);
      return;
    }
    note('');
    m.stops.push(title);
    drawBanner();
    syncSelectionRing();
  }

  function undo() {
    const m = ctx.mode;
    if (!m || !m.stops.length) return;
    m.stops.pop();
    note('');
    drawBanner();
    syncSelectionRing();
  }

  function done() {
    const m = ctx.mode;
    if (!m) return;
    if (m.stops.length < 2) {
      note('A line needs at least two stations.');
      return;
    }
    const res = m.editId == null ? game.createLine(m.stops.slice()) : game.setLineStations(m.editId, m.stops.slice());
    if (!ctx.report(res)) return;
    exitMode();
    refresh();
  }

  // ---------------------------------------------------------- ride bar

  const rideText = h('span');
  const rideBar = h(
    'div',
    { class: 'tot-panel tot-ridebar', hidden: true },
    h('span', { class: 'tot-eyebrow', text: 'Riding' }),
    rideText,
    h('button', { class: 'tot-btn tot-btn-small', type: 'button', text: 'Stop riding', onClick: () => ctx.stopRide() }),
  );

  function trainLabel(t) {
    const type = TRAIN_TYPES[t.typeId];
    return `${type ? type.name : t.typeId} #${t.id}`;
  }

  function paxText(t) {
    const type = TRAIN_TYPES[t.typeId];
    return `${t.passengers.length}${type ? '/' + type.capacity : ''}`;
  }

  function drawRide() {
    const t = ctx.riding != null ? state.trains.find((x) => x.id === ctx.riding) : null;
    rideBar.hidden = !t;
    if (t) setText(rideText, `${trainLabel(t)} · ${paxText(t)} aboard`);
  }

  // ---------------------------------------------------------- line cards

  function lineCard(line) {
    const buyWrap = h('div', { class: 'tot-buys' });
    for (const id of state.unlockedTrainTypes) {
      const type = TRAIN_TYPES[id];
      if (!type) continue;
      const price = h('span', { class: 'tot-price' });
      const btn = h('button', {
        class: 'tot-btn tot-btn-small tot-buy', type: 'button',
        title: `${type.name}: carries ${type.capacity}, speed ${type.speed}, upkeep ${fmtMoney(type.upkeepPerMin)}/min before inflation`,
        onClick: () => {
          ctx.report(game.buyTrain(id, line.id));
          refresh();
        },
      }, `+ ${type.name} `, price);
      buyWrap.append(btn);
      live.buys.push({ btn, price, cost: type.cost });
    }

    const trains = h('ul', { class: 'tot-trains' });
    for (const tid of line.trainIds) {
      const t = state.trains.find((x) => x.id === tid);
      if (!t) continue;
      const pax = h('span', { class: 'tot-pax' });
      const rideBtn = h('button', { class: 'tot-btn tot-btn-small', type: 'button', onClick: () => (ctx.riding === t.id ? ctx.stopRide() : ctx.startRide(t.id)) });
      const li = h('li', { class: 'tot-train', 'data-train': String(t.id) },
        h('span', { class: 'tot-train-name', text: trainLabel(t) }),
        pax,
        rideBtn,
        h('button', { class: 'tot-btn tot-btn-small', type: 'button', text: 'Sell', title: 'Sell this train for a partial refund', onClick: () => {
          if (ctx.riding === t.id) ctx.stopRide();
          ctx.report(game.sellTrain(t.id));
          refresh();
        } }),
      );
      trains.append(li);
      live.pax.push({ pax, id: t.id });
      live.rides.push({ btn: rideBtn, id: t.id });
    }
    if (!trains.children.length) trains.append(h('li', { class: 'tot-train-none', text: 'No trains yet' }));

    const del = h('button', { class: 'tot-btn tot-btn-small', type: 'button', text: 'Delete', title: 'Delete this line and sell its trains' });
    let armed = 0;
    del.addEventListener('click', () => {
      if (!armed) {
        del.textContent = 'Sure?';
        del.classList.add('armed');
        armed = setTimeout(() => {
          armed = 0;
          del.textContent = 'Delete';
          del.classList.remove('armed');
        }, 3000);
        return;
      }
      clearTimeout(armed);
      armed = 0;
      if (line.trainIds.includes(ctx.riding)) ctx.stopRide();
      ctx.report(game.deleteLine(line.id));
      refresh();
    });

    const card = h(
      'article',
      { class: 'tot-line', 'data-line': String(line.id) },
      h('div', { class: 'tot-line-head' },
        h('span', { class: 'tot-swatch', style: `background:${/^#[0-9a-f]{3,8}$/i.test(line.color) ? line.color : '#888'}` }),
        h('strong', { class: 'tot-line-name', text: line.name }),
        h('button', { class: 'tot-btn tot-btn-small', type: 'button', text: 'Edit', title: 'Redraw this line’s stops', onClick: () => enterMode(line) }),
        del,
      ),
      h('div', { class: 'tot-chain', text: chainText(line.stations), title: chainText(line.stations) }),
      trains,
      buyWrap,
    );
    card.addEventListener('mouseenter', () => renderer.setLineHighlight(line.id));
    card.addEventListener('mouseleave', () => renderer.setLineHighlight(null));
    return card;
  }

  /** Rebuild the line cards. Called on linesChanged / trainsChanged / unlocks and after actions. */
  function refresh() {
    renderer.setLineHighlight(null);
    live = { buys: [], pax: [], rides: [] };
    // A followed train that no longer exists releases the camera.
    if (ctx.riding != null && !state.trains.some((t) => t.id === ctx.riding)) ctx.stopRide();
    clear(row);
    if (!state.lines.length) {
      row.append(h('div', { class: 'tot-empty', text: 'No lines yet. Build track between two stations, then press New line and click them in order.' }));
    }
    for (const line of state.lines) row.append(lineCard(line));
    drawRide();
    drawBanner();
    update();
  }

  /** Per-tick: prices, affordability, passenger counts, ride buttons. */
  function update() {
    const infl = state.inflation;
    for (const b of live.buys) {
      const price = trainPrice(b.cost, infl);
      setText(b.price, fmtMoney(price));
      const poor = state.money < price;
      setClass(b.btn, 'poor', poor);
      setDisabled(b.btn, poor);
    }
    for (const p of live.pax) {
      const t = state.trains.find((x) => x.id === p.id);
      if (t) setText(p.pax, paxText(t));
    }
    for (const r of live.rides) {
      const on = ctx.riding === r.id;
      setText(r.btn, on ? 'Stop riding' : 'Ride');
      setClass(r.btn, 'on', on);
    }
    drawRide();
  }

  /** A train was clicked on the map: flash its row in the panel. */
  function flashTrain(id) {
    const li = row.querySelector(`[data-train="${Number(id)}"]`);
    if (!li) return;
    collapsed = false;
    el.classList.remove('collapsed');
    li.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    li.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => li.classList.remove('flash'), 1600);
  }

  /** Esc: cancel line mode. Returns whether it did something. */
  function cancel() {
    if (!ctx.mode) return false;
    exitMode();
    return true;
  }

  ctx.bus.on('riding', update);

  return { el, banner, rideBar, refresh, update, addStop, note, flashTrain, cancel };
}
