import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLattice, key, parse } from './lattice.js';

test('lattice: links are mutual, never to itself, the same for a seed, and never fewer than two', async () => {
  const a = createLattice(7);
  const b = createLattice(7);
  const c = createLattice(8);
  let differs = false;
  let total = 0;
  for (let i = -12; i <= 12; i++) {
    for (let j = -12; j <= 12; j++) {
      const t = key(i, j);
      const l = a.links(t);
      total += l.length;
      assert.ok(l.length >= 2 && l.length <= 6, `${t} has ${l.length} links`);
      assert.equal(new Set(l).size, l.length);
      assert.ok(!l.includes(t));
      assert.deepEqual(l, b.links(t));
      if (l.join('|') !== c.links(t).join('|')) differs = true;
      for (const n of l) assert.ok(a.links(n).includes(t), `${t} -> ${n} is not mutual`);
    }
  }
  assert.ok(differs, 'another seed gives another network');
  const mean = total / 625;
  assert.ok(mean > 3 && mean < 5, `mean links ${mean}`);
});

test('lattice: speaks the wiki contract', async () => {
  const w = createLattice(3);
  const start = await w.randomStart();
  assert.equal(start.title, '0,0');
  assert.equal(start.kind, 'article');
  assert.equal(start.thumbnail, null);
  assert.deepEqual(start.leadLinks, start.links);
  const stubs = await w.getStubs([...start.links, 'not a place']);
  assert.equal(stubs.size, start.links.length);
  for (const s of stubs.values()) assert.ok(s.popularity > 0 && s.popularity < 1);
  await assert.rejects(() => w.getArticle('nowhere'));
  assert.deepEqual(parse('3,-4'), { i: 3, j: -4 });
  assert.equal(parse('x'), null);
});
