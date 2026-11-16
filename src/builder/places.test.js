import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaces, START } from './places.js';

test('places: new places link back to where they came from, joins are mutual, forgetting undoes it', () => {
  const p = createPlaces(5);
  assert.deepEqual(p.links(START), []);
  const a = p.create(START);
  const b = p.create(a);
  assert.notEqual(a, b);
  assert.deepEqual(p.links(START), [a]);
  assert.deepEqual(p.links(a).sort(), [START, b].sort());
  assert.ok(p.join(START, b));
  assert.ok(p.links(b).includes(START) && p.links(START).includes(b));
  assert.equal(p.join(START, 'nowhere'), false);
  p.forget(b);
  assert.deepEqual(p.links(START), [a]);
  assert.deepEqual(p.links(a), [START]);
  p.forget(START); // the start never goes
  assert.deepEqual(p.links(a), [START]);
});

test('places: speaks the wiki contract', async () => {
  const p = createPlaces(3);
  const start = await p.randomStart();
  assert.equal(start.title, START);
  assert.equal(start.thumbnail, null);
  const a = p.create(START);
  const art = await p.getArticle(a);
  assert.deepEqual(art.links, [START]);
  assert.deepEqual(art.leadLinks, art.links);
  const stubs = await p.getStubs([a, 'not a place']);
  assert.equal(stubs.size, 1);
  assert.ok(stubs.get(a).popularity > 0 && stubs.get(a).popularity < 1);
  await assert.rejects(() => p.getArticle('nowhere'));
});
