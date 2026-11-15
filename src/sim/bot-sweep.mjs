// Runs the balance bot over several seeds and both strategies; prints a compact summary.
//   node src/sim/bot-sweep.mjs [--seeds 6] [--world fake|real]
import { runBot } from './bot.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const seeds = Number(opt('seeds', 6));
const worldKind = opt('world', 'fake');
const at = (rows, m) => rows.find((r) => Math.abs(r.min - m) < 0.01);
const fmt = (r) => (r ? `${r.money.toFixed(0)}/${r.net >= 0 ? '+' : ''}${r.net.toFixed(0)}` : '-');
for (const strategy of (opt('strategies', 'play,idle,lazy')).split(',')) {
  console.log(`\n${strategy}: seed | end | money/net at 4, 10, 16, 20, 26, 30, 36 min | stations delivered lost`);
  const ends = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const r = await runBot({ seed, strategy, minutes: 45, worldKind, print: false });
    ends.push(r.phase === 'over' ? r.endMinute : 99);
    const cols = [4, 10, 16, 20, 26, 30, 36].map((m) => fmt(at(r.rows, m)).padStart(10)).join(' ');
    if (!argv.includes('--summary')) console.log(`  ${String(seed).padStart(2)} | ${(r.phase === 'over' ? 'bust ' : 'alive ') + r.endMinute.toFixed(1).padStart(4)} | ${cols} | ${r.stations} ${r.delivered} ${r.lost}`);
  }
  ends.sort((a, b) => a - b);
  const n = ends.length;
  console.log(`  summary: median end ${ends[n >> 1].toFixed(1)} min | bust before 12: ${ends.filter((e) => e < 12).length}/${n} | alive at 20: ${ends.filter((e) => e >= 20).length}/${n} | at 30: ${ends.filter((e) => e >= 30).length}/${n} | at 35: ${ends.filter((e) => e >= 35).length}/${n} | at 45: ${ends.filter((e) => e >= 45).length}/${n}`);
}
