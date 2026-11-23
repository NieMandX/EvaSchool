import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { feature, mesh } from 'topojson-client';
import { buildOceanWaterGrid } from '../scripts/ocean-water.mjs';
import { createCountryIndex } from '../src/globe-geography.js';
import { createWaterLookup } from '../src/ocean-water.js';

test('ocean labels use a lookup inland and offshore, and exact spherical picking along edges', () => {
  const atlas = JSON.parse(readFileSync(new URL('../src/assets/countries.json', import.meta.url), 'utf8'));
  const countries = atlas.objects.countries;
  const exact = createCountryIndex(feature(atlas, countries).features);
  let fallbacks = 0;
  const water = createWaterLookup(buildOceanWaterGrid(atlas), point => {
    fallbacks++;
    return exact(point);
  });
  assert.equal(water([-140, 0]), true);
  assert.equal(water([19, 24]), false);
  assert.equal(fallbacks, 0);

  const coastlines = mesh(atlas, countries, (a, b) => a === b).coordinates;
  for (const line of coastlines.slice(0, 100)) {
    const point = line[Math.floor(line.length / 2)];
    assert.equal(water(point), !exact(point));
  }
  assert.equal(fallbacks, Math.min(100, coastlines.length));

  for (let lat = -89.9; lat <= 90; lat += 4.73) {
    for (let lon = -179.9; lon <= 180; lon += 5.91) {
      assert.equal(water([lon, lat]), !exact([lon, lat]), `At ${lon}, ${lat}`);
    }
  }
  for (const lon of [-180, 0, 180]) {
    for (const lat of [-90, -89.9, 66, 89.9, 90]) {
      assert.equal(water([lon, lat]), !exact([lon, lat]));
    }
  }
});
