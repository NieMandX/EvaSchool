import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createGlobeMesh } from '../scripts/globe-mesh.mjs';
import { batchContinent } from '../scripts/globe-batches.mjs';
import { createLandVisibility } from '../src/globe-visibility.js';

const atlas = JSON.parse(readFileSync(new URL('../src/assets/countries.json', import.meta.url), 'utf8'));
const source = createGlobeMesh(atlas).continents;
const spatial = source.map(batchContinent);

function triangles(indices) {
  const ordered = [];
  for (let i = 0; i < indices.length; i += 3) {
    ordered.push(indices[i] * 65536 ** 2 + indices[i + 1] * 65536 + indices[i + 2]);
  }
  return ordered.sort((a, b) => a - b);
}

test('spatial batches preserve every original triangle, vertex and winding', () => {
  for (const [i, part] of spatial.entries()) {
    assert.equal(part.vertices, source[i].vertices);
    assert.deepEqual(triangles(part.indices), triangles(source[i].indices));
    assert.equal(part.batches.at(-1)[0], part.indices.length);
  }
});

test('every omitted triangle lies outside a common clip plane, including at the horizon and screen edges', () => {
  const select = createLandVisibility(spatial);
  for (const [lon, lat, x, y, radius, width, height] of [
    [87, 18, 519.5, 296, 280, 1039, 620],
    [87, 18, 721, 189, 1260, 1039, 620],
    [-179, 89, 96, 95, 624, 390, 844],
    [180, -88.9, 81, 437, 626, 390, 844],
    [0, 0, 194, 403, 200, 390, 844],
  ]) {
    const visible = select(lon, lat, x, y, radius, width, height);
    const a = lon * Math.PI / 180, b = lat * Math.PI / 180;
    const east = [-Math.sin(a), Math.cos(a), 0];
    const north = [-Math.cos(a) * Math.sin(b), -Math.sin(a) * Math.sin(b), Math.cos(b)];
    const front = [Math.cos(a) * Math.cos(b), Math.sin(a) * Math.cos(b), Math.sin(b)];
    let skipped = 0;
    for (const [i, { indices, vertices }] of spatial.entries()) {
      const spans = visible[i];
      const outside = new Uint8Array(vertices.length / 3);
      for (let j = 0; j < outside.length; j++) {
        const dot = axis => vertices[j * 3] * axis[0] + vertices[j * 3 + 1] * axis[1] + vertices[j * 3 + 2] * axis[2];
        const px = x + radius * dot(east), py = y - radius * dot(north);
        outside[j] = (dot(front) < 0 ? 1 : 0) | (px < -2 ? 2 : 0) | (px > width + 2 ? 4 : 0)
          | (py < -2 ? 8 : 0) | (py > height + 2 ? 16 : 0);
      }
      let span = 0;
      for (let j = 0; j < indices.length; j += 3) {
        if (span < spans.length && j >= spans[span] + spans[span + 1]) span += 2;
        if (span < spans.length && j >= spans[span]) continue;
        assert.ok(outside[indices[j]] & outside[indices[j + 1]] & outside[indices[j + 2]]);
        skipped++;
      }
    }
    assert.ok(skipped > 1000);
  }
});
