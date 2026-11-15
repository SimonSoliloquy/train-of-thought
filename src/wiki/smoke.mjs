// Live smoke test against English Wikipedia. Usage: node src/wiki/smoke.mjs [--skip-random]
import { createWiki } from './index.js';
import { WIKI } from '../config.js';

const wiki = createWiki();
const skipRandom = process.argv.includes('--skip-random');
let lastRequests = 0;

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const n = wiki.stats.requests - lastRequests;
    lastRequests = wiki.stats.requests;
    console.log(`\n== ${label}: ${Date.now() - t0} ms, ${n} requests, ${wiki.stats.retries} retries so far`);
    return out;
  } catch (e) {
    console.log(`\n== ${label}: FAILED after ${Date.now() - t0} ms: ${e.message}`);
    lastRequests = wiki.stats.requests;
    return null;
  }
}

function show(a) {
  console.log(`${a.title} [${a.kind}] pop=${a.popularity} desc="${a.description}"`);
  console.log(`  summary(${a.summary.length}ch): ${a.summary.slice(0, 160)}${a.summary.length > 160 ? '...' : ''}`);
  console.log(`  thumb: ${a.thumbnail ? a.thumbnail.slice(0, 70) + '...' : null}  url: ${a.url}`);
  console.log(`  leadLinks(${a.leadLinks.length}): ${a.leadLinks.join(' | ')}`);
  console.log(`  links: ${a.links.length}  superset=${a.leadLinks.every((t) => a.links.includes(t))}  self=${a.links.includes(a.title)}  dupes=${new Set(a.links).size !== a.links.length}  max=${WIKI.maxLinks}`);
}

if (!skipRandom) {
  const start = await timed('randomStart', () => wiki.randomStart());
  if (start) show(start);
}

for (const title of ['United States', 'Ohm\'s law', 'Mercury']) {
  const a = await timed(`getArticle("${title}")`, () => wiki.getArticle(title));
  if (a) show(a);
}
await timed('getArticle("USA") alias, should be cached', () => wiki.getArticle('USA'));
await timed('getArticle(missing) should reject', async () => {
  try {
    await wiki.getArticle('Zzyzx qwertyuiop nonexistent');
  } catch (e) {
    console.log('  rejected as expected:', e.message);
    return;
  }
  throw new Error('did not reject');
});

const mixed = [
  'USA', 'UK', 'Barack_Obama', 'albert einstein', 'Mercury', 'List of countries by population (United Nations)', 'Timeline of the universe',
  'Python', 'Paris', 'Tokyo', 'Moon', 'Sun', 'DNA', 'Jazz', 'Chess', 'Coffee', 'Bicycle', 'Eiffel Tower', 'Nile', 'Oxygen',
  'Zzyzx qwertyuiop nonexistent', 'NYC', 'Big Apple', 'Roman Empire', 'Photosynthesis', 'Mount Everest', 'Antarctica', 'Vikings',
  'World War 2', 'WWII', 'Mars', 'Earth', 'Venus', 'Jupiter', 'Saturn', 'Neptune', 'Pluto', 'Gold', 'Silver', 'Iron', 'Copper',
  'Sahara', 'Amazon River', 'Danube', 'Rhine', 'Alps', 'Himalayas', 'Andes', 'Rocky Mountains', 'Great Barrier Reef', 'Taj Mahal',
  'Colosseum', 'Stonehenge', 'Machu Picchu', 'Angkor Wat', 'Petra', 'Hagia Sophia', 'Big Ben',
];
const stubs = await timed(`getStubs(${mixed.length} mixed titles)`, () => wiki.getStubs(mixed));
if (stubs) {
  const missing = mixed.filter((t) => !stubs.has(t));
  console.log(`  returned ${stubs.size}/${mixed.length}; omitted: ${missing.join(', ')}`);
  for (const t of ['USA', 'UK', 'Barack_Obama', 'albert einstein', 'Mercury', 'List of countries by population (United Nations)', 'NYC', 'WWII', 'Jazz', 'Petra']) {
    const s = stubs.get(t);
    console.log(`  ${t} -> ${s ? `${s.title} [${s.kind}] pop=${s.popularity} "${s.description}"` : '(omitted)'}`);
  }
}
await timed('getStubs again (cached)', () => wiki.getStubs(mixed));
console.log('\nTOTAL', wiki.stats);
