// Words for gold and tickets in one place, so no view prints "$". All pure.

/** "326 gold": every amount the view draws. */
export function gold(n) {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  return `${v.toLocaleString('en-US')} gold`;
}

/**
 * What a signpost says about the tickets. A ticket's destination wins ("Ticket · +650 gold", the
 * highest reward if several), then an unbuilt starting point ("Ticket start").
 * @returns {{kind:'to'|'from', text:string, reward?:number}|null}
 */
export function ticketBadge(title, tickets) {
  if (!title || !Array.isArray(tickets) || !tickets.length) return null;
  let to = null, from = false;
  for (const t of tickets) {
    if (!t) continue;
    if (t.to === title && (!to || t.reward > to.reward)) to = t;
    if (t.from === title) from = true;
  }
  if (to) return { kind: 'to', reward: to.reward, text: `Ticket · +${gold(to.reward)}` };
  if (from) return { kind: 'from', text: 'Ticket start' };
  return null;
}
