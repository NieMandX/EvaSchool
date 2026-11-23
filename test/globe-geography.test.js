import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { geoBounds, geoContains } from 'd3-geo';
import { feature } from 'topojson-client';
import { createCountryIndex, pickVisibleCountry, tileLineVertices } from '../src/globe-geography.js';
import { globeCoordinates } from '../src/globe-camera.js';

const atlas = JSON.parse(readFileSync(new URL('../src/assets/countries.json', import.meta.url), 'utf8'));
const countries = feature(atlas, atlas.objects.countries).features;

test('the country grid preserves picking across the antimeridian and near the poles', () => {
  const find = createCountryIndex(countries);
  const regions = countries.map(country => ({ country, bounds: geoBounds(country) }));

  for (let lat = -89; lat < 90; lat += 7) {
    for (let lon = -180; lon < 180; lon += 7) {
      const expected = regions.find(({ country, bounds: [[west, south], [east, north]] }) => {
        if (lat < south || lat > north) return false;
        const inside = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
        return inside && geoContains(country, [lon, lat]);
      });
      assert.equal(find([lon, lat]), expected?.country ?? null, `[${lon}, ${lat}]`);
    }
  }
});

test('the raised Hokkaido coastline remains selectable on the sea side of its original outline', () => {
  const index = createCountryIndex(countries);
  const camera = { lon: 87, lat: 18, zoom: 1 };
  const view = { x: 390, y: 350, radius: 300 };
  const at = point => {
    const coords = globeCoordinates(camera, point, view);
    return coords && index(coords);
  };
  const pixel = { x: view.x + 177, y: view.y - 166 };
  const japan = { id: '392', offsetX: 0, offsetY: 0, scale: 1 + 4.0359 / view.radius, cutOpacity: 1 };
  assert.equal(at(pixel), null);
  assert.equal(pickVisibleCountry(pixel, view, [japan], at)?.id, japan.id);
});

test('picking respects draw order, the cut footprint, partial transitions and the original rim', () => {
  const left = { id: 'left' }, right = { id: 'right' };
  const at = ({ x }) => x >= 0 && x < 10 ? left : x >= 10 && x < 20 ? right : null;
  const view = { x: 10, y: 10 };
  const moved = { id: left.id, offsetX: 10, offsetY: 0, scale: 1, cutOpacity: 1 };
  const top = { id: right.id, offsetX: 4, offsetY: 3, scale: 1.1, cutOpacity: 1 };
  const pick = (x, stack) => pickVisibleCountry({ x, y: 10 }, view, stack, at);
  assert.equal(pick(15, [moved, top]), right);
  assert.equal(pick(15, [top, moved]), left);
  assert.equal(pick(23, [moved, top]), right);
  assert.equal(pick(4, [moved]), null);
  assert.equal(pick(4, [{ ...moved, cutOpacity: .5 }]), left);
  const still = { ...moved, offsetX: 0, cutOpacity: 0 };
  assert.equal(pick(4, [still]), left);
  assert.equal(pick(15, [still]), right);
});

test('geographic line tiles upload one pair per segment without joining separate ways', () => {
  const vertices = tileLineVertices([{
    data: { type: 'MultiLineString', coordinates: [[[0, 0], [90, 0], [0, 90]], [[180, 0], [0, -90]]] },
  }, { data: null }]);
  const rounded = Array.from(vertices, value => Math.round(value) || 0);
  assert.deepEqual(rounded, [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1]);
});
