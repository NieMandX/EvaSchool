import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { geoBounds, geoContains } from 'd3-geo';
import { feature } from 'topojson-client';
import { createCountryIndex, tileLineVertices } from '../src/globe-geography.js';

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

test('geographic line tiles upload one pair per segment without joining separate ways', () => {
  const vertices = tileLineVertices([{
    data: { type: 'MultiLineString', coordinates: [[[0, 0], [90, 0], [0, 90]], [[180, 0], [0, -90]]] },
  }, { data: null }]);
  const rounded = Array.from(vertices, value => Math.round(value) || 0);
  assert.deepEqual(rounded, [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1]);
});
