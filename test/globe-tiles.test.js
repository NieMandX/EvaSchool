import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlobeTiles } from '../src/globe-tiles.js';
import { viewCap } from '../src/map-geometry.js';

const cap = (lon, lat, radius) => viewCap(lon, lat, radius, 50, 50, 100, 100);
const settle = () => new Promise(resolve => setImmediate(resolve));
const ids = tiles => tiles.visible().map(({ tile }) => tile.id);

function deferredSource() {
  const requests = [];
  const loadTile = (tile, { signal }) => new Promise((resolve, reject) => {
    // Deliberately ignore abort. A stalled request should still count against concurrency.
    requests.push({ tile, signal, resolve, reject });
  });
  return { requests, loadTile };
}

test('geographic addresses cover both sides of the antimeridian', async () => {
  const tiles = createGlobeTiles({
    loadTile: tile => tile.id, maxZoom: 4, tilePixels: 100, maxTiles: 160, maxCache: 250,
  });
  tiles.update(cap(179.9, .1, 10000), 10000);
  await settle();
  const eastern = tiles.visible().find(({ tile }) => tile.id === '4/15/7');
  const western = tiles.visible().find(({ tile }) => tile.id === '4/0/8');
  assert.deepEqual(eastern?.tile.bounds, { west: 157.5, south: 0, east: 180, north: 11.25 });
  assert.deepEqual(western?.tile.bounds, { west: -180, south: -11.25, east: -157.5, north: 0 });
  assert(tiles.visible().every(({ tile }) => tile.x < 2 || tile.x > 13));
  const before = tiles.visible();
  tiles.update(cap(-179.9, .1, 10000), 10000);
  assert.equal(tiles.visible(), before);
  tiles.dispose();
});

test('a parent remains until visible children are ready and offscreen siblings are never requested', async () => {
  const { requests, loadTile } = deferredSource();
  const changes = [];
  const tiles = createGlobeTiles({ loadTile, maxZoom: 1, onChange: visible => changes.push(visible) });
  tiles.update(cap(-90, 0, 150), 150);
  await settle();
  assert.equal(requests.length, 1);
  requests[0].resolve('world');
  await settle();
  const parent = tiles.visible();
  assert.deepEqual(ids(tiles), ['0/0/0']);
  tiles.update(cap(-90, 0, 600), 600);
  await settle();
  assert.deepEqual(requests.map(({ tile }) => tile.id), ['0/0/0', '1/0/0', '1/0/1']);

  for (const request of requests.slice(1, -1)) request.resolve(request.tile.id);
  await settle();
  assert.equal(tiles.visible(), parent);
  assert.equal(changes.length, 1);
  requests.at(-1).resolve(null);
  await settle();
  assert.deepEqual(ids(tiles), ['1/0/0', '1/0/1']);
  assert.equal(tiles.visible().at(-1).data, null);
  assert.equal(changes.length, 2);
  tiles.dispose();
});

test('failed requests keep the ancestor and retry after the tile leaves and re-enters the plan', async () => {
  const attempts = [];
  const tiles = createGlobeTiles({ maxZoom: 1, loadTile(tile) {
    const first = !attempts.includes(tile.id);
    attempts.push(tile.id);
    if (tile.id === '1/0/0' && first) throw new Error('temporarily unavailable');
    return tile.id;
  } });
  const largeView = cap(0, 0, 600);
  tiles.update(largeView, 600);
  await settle();
  assert.deepEqual(ids(tiles), ['0/0/0']);
  tiles.update(largeView, 600);
  await settle();
  assert.equal(attempts.length, 5);
  tiles.update(cap(0, 0, 150), 150);
  tiles.update(largeView, 600);
  await settle();
  assert.equal(attempts.at(-1), '1/0/0');
  assert.equal(attempts.length, 6);
  assert.deepEqual(ids(tiles), ['1/0/0', '1/1/0', '1/0/1', '1/1/1']);
  tiles.dispose();
});

test('one leaf can refine without siblings and each ancestor counts toward the cache limit', async () => {
  const requests = [];
  const tiles = createGlobeTiles({ tilePixels: 1, maxZoom: 24, maxTiles: 1, maxCache: 9, loadTile(tile) {
    requests.push(tile);
    return tile.id;
  } });
  const radius = 100000;
  const start = cap(-82, 37, radius);
  tiles.update(start, radius);
  await settle();
  const initial = ids(tiles);
  assert.deepEqual(requests.map(tile => tile.z), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(initial.length, 1);
  assert(initial[0].startsWith('8/'));

  tiles.update(cap(0, 0, radius), radius);
  await settle();
  assert.equal(requests.length, 9);
  assert.deepEqual(ids(tiles), ['0/0/0']);

  tiles.update(cap(98, -37, radius), radius);
  assert.deepEqual(ids(tiles), ['0/0/0']);
  await settle();
  assert.equal(requests.length, 17);
  tiles.update(start, radius);
  assert.deepEqual(ids(tiles), ['0/0/0']);
  await settle();
  assert.equal(requests.length, 25);
  assert.deepEqual(ids(tiles), initial);
  tiles.dispose();
});

test('cancelled requests that ignore abort stay within concurrency until they settle', async () => {
  const { requests, loadTile } = deferredSource();
  const changes = [];
  const tiles = createGlobeTiles({ loadTile, onChange: visible => changes.push(visible),
    tilePixels: 1, maxZoom: 2, maxTiles: 7, maxConcurrent: 2 });
  const radius = 1000;
  tiles.update(cap(-90, 45, radius), radius);
  await settle();
  assert.equal(requests.length, 2);
  requests[0].resolve('world');
  requests[1].resolve('northwest');
  await settle();
  assert.equal(requests.length, 4);
  assert(requests.slice(-2).every(({ tile }) => tile.z === 2 && tile.x < 2 && tile.y < 2));

  tiles.update(cap(90, -45, radius), radius);
  assert.deepEqual(ids(tiles), ['0/0/0']);
  await settle();
  assert(requests.slice(-2).every(({ signal }) => signal.aborted));
  assert.equal(requests.length, 4);
  requests[2].resolve('stale');
  await settle();
  assert.equal(requests.length, 5);
  assert.equal(requests.at(-1).signal.aborted, false);
  assert(tiles.visible().every(({ data }) => data !== 'stale'));
  const notifications = changes.length;
  tiles.dispose();
  assert(requests.at(-1).signal.aborted);
  requests[3].resolve('stale');
  requests[4].resolve('stale');
  tiles.update(cap(0, 0, radius), radius);
  await settle();
  assert.equal(requests.length, 5);
  assert.equal(changes.length, notifications);
  assert.deepEqual(tiles.visible(), []);
});
