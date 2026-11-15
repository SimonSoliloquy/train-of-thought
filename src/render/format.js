// Words for gold and tickets in one place, so no view prints "$". All pure.

/** "326 gold": every amount the view draws. */
export function gold(n) {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  return `${v.toLocaleString('en-US')} gold`;
}

/**
 * What a signpost says about the tickets. Signposts do not give away where a ticket leads: the
 * player finds that by reading the articles. The one exception is a signpost a paid surveyor has
 * finished pointing at ("Surveyor: build here next").
 * @returns {{kind:'hint', text:string}|null}
 */
export function ticketBadge(title, tickets) {
  if (!title || !Array.isArray(tickets) || !tickets.length) return null;
  for (const t of tickets) {
    if (t && t.hint && t.hint.to === title) return { kind: 'hint', text: 'Surveyor: build here next' };
  }
  return null;
}
