// Runs the balance bot over several seeds and strategies; prints a compact summary.
//   node src/sim/bot-sweep.mjs [--seeds 6] [--world fake|real] [--strategies careful,play,lazy,idle] [--final auto|freight|bullet]
//                              [--summary] [--set ECON.fareBase=50 ...]
import { runBot } from './bot.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const seeds = Number(opt('seeds', 6));
const worldKind = opt('world', 'fake');
const final = opt('final', 'auto');
const at = (rows, m) => rows.find((r) => Math.abs(r.min - m) < 0.01);
const fmt = (r) => (r ? `${r.money.toFixed(0)}/${r.net >= 0 ? '+' : ''}${r.net.toFixed(0)}` : '-');
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const levelTotals = {};
for (const strategy of (opt('strategies', 'careful,play,lazy,idle')).split(',')) {
  console.log(`\n${strategy}: seed | end | money/net at 4, 10, 16, 20, 26, 30, 36 min | stations delivered lost | goals | rep low after 4 min | gold low in first 5 min`);
  const ends = [];
  const all = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const r = await runBot({ seed, strategy, minutes: 45, worldKind, final, print: false });
    all.push(r);
    ends.push(r.phase === 'over' ? r.endMinute : 99);
    const lt = (levelTotals[strategy] ||= { 0: 0, 1: 0, 2: 0, freight: 0, bullet: 0 });
    for (const k of Object.keys(lt)) lt[k] += r.levels[k];
    const cols = [4, 10, 16, 20, 26, 30, 36].map((m) => fmt(at(r.rows, m)).padStart(10)).join(' ');
    if (!argv.includes('--summary')) {
      console.log(`  ${String(seed).padStart(2)} | ${(r.phase === 'over' ? 'bust ' : 'alive ') + r.endMinute.toFixed(1).padStart(4)} | ${cols} | ${r.stations} ${r.delivered} ${r.lost} | ${r.stats.goals} | ${r.stats.minRepAfter4.toFixed(2)} | ${r.stats.minMoneyFirst5.toFixed(0)}`);
    }
  }
  ends.sort((a, b) => a - b);
  const n = ends.length;
  console.log(`  summary: median end ${ends[n >> 1].toFixed(1)} min | bust before 12: ${ends.filter((e) => e < 12).length}/${n} | alive at 20: ${ends.filter((e) => e >= 20).length}/${n} | at 30: ${ends.filter((e) => e >= 30).length}/${n} | at 35: ${ends.filter((e) => e >= 35).length}/${n} | at 45: ${ends.filter((e) => e >= 45).length}/${n}`);
  const lt = levelTotals[strategy];
  console.log(`  tracks ended at: bare ${lt[0]}, local ${lt[1]}, express ${lt[2]}, freight ${lt.freight}, bullet ${lt.bullet}`);
  const fin = all.flatMap((r) => r.stats.finals);
  const fr = fin.filter((x) => x.typeId === 'freight');
  const bu = fin.filter((x) => x.typeId === 'bullet');
  console.log(`  final trains bought: freight ${fr.length} (avg peak queue ${avg(fr.map((x) => x.peakQueue)).toFixed(1)}), bullet ${bu.length} (avg peak queue ${avg(bu.map((x) => x.peakQueue)).toFixed(1)})`);
  console.log(`  goals done (median) ${median(all.map((r) => r.stats.goals))}, goal gold ${avg(all.map((r) => r.stats.goalGold)).toFixed(0)}, route bonus gold ${avg(all.map((r) => r.stats.bonusGold)).toFixed(0)}, built-station share of spawns ${(100 * avg(all.map((r) => r.stats.spawnedBuilt / Math.max(1, r.stats.spawned)))).toFixed(0)}%, lowest rep after 4 min ${Math.min(...all.map((r) => r.stats.minRepAfter4)).toFixed(2)}, lowest gold in first 5 min ${Math.min(...all.map((r) => r.stats.minMoneyFirst5)).toFixed(0)}`);
}
