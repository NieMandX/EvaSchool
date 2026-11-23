import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { geoArea, geoContains } from 'd3-geo';
import { feature } from 'topojson-client';
import { createGlobeMesh } from '../scripts/globe-mesh.mjs';

const atlas = JSON.parse(readFileSync(new URL('../src/assets/countries.json', import.meta.url)));
const globe = createGlobeMesh(atlas);
const countryFeatures = feature(atlas, atlas.objects.countries).features;
const RAD = Math.PI / 180;
const SUFFIX = { eurasia: 'Eurasia', africa: 'Africa', 'north-america': 'NorthAmerica',
  'south-america': 'SouthAmerica', oceania: 'Oceania', antarctica: 'Antarctica' };

const dot = ([ax, ay, az], [bx, by, bz]) => ax * bx + ay * by + az * bz;
const cross = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
const edgeKey = (a, b) => 65_536 * Math.min(a, b) + Math.max(a, b);

function unitPoints(vertices) {
  return Array.from({ length: vertices.length / 3 }, (_, index) => {
    const coordinates = [...vertices.subarray(index * 3, index * 3 + 3)];
    const length = Math.hypot(...coordinates);
    assert.ok(Math.abs(length - 1) < 1e-6);
    return coordinates.map(value => value / length);
  });
}

function sourcePoint([longitude, latitude]) {
  if (Math.abs(latitude) === 90) return `0,0,${Math.sign(latitude)}`;
  const lon = (longitude === 180 ? -180 : longitude) * RAD;
  const lat = latitude * RAD;
  const cos = Math.cos(lat);
  return Float32Array.of(cos * Math.cos(lon), cos * Math.sin(lon), Math.sin(lat)).join(',');
}

function checkOriginalVertices(mesh, geometries) {
  const present = new Set();
  for (let i = 0; i < mesh.vertices.length; i += 3) present.add(mesh.vertices.subarray(i, i + 3).join(','));
  for (const geometry of geometries) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const coordinate of polygons.flat(2)) assert.ok(present.has(sourcePoint(coordinate)), `${coordinate} is retained`);
  }
}

function inspectTriangles({ vertices, indices }) {
  assert.ok(indices instanceof Uint16Array);
  assert.ok(indices.length && indices.length % 3 === 0);
  const points = unitPoints(vertices);
  const visited = new Set();
  const edges = new Map();
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.subarray(i, i + 3);
    const normal = dot(points[a], cross(points[b], points[c]));
    assert.ok(normal >= 0, 'triangle faces outward');
    area += 2 * Math.atan2(normal, 1 + dot(points[a], points[b]) + dot(points[b], points[c]) + dot(points[c], points[a]));
    for (const point of [a, b, c]) visited.add(point);
    for (const edge of [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)]) edges.set(edge, (edges.get(edge) ?? 0) + 1);
  }
  assert.equal(visited.size, points.length);
  for (const [edge, sides] of edges) {
    assert.ok(sides === 1 || sides === 2, 'no edge links more than two triangles');
    const a = points[Math.floor(edge / 65_536)];
    const b = points[edge % 65_536];
    assert.ok(dot(a, b) >= Math.cos((sides === 1 ? .351 : 1.451) * RAD));
  }
  return area;
}

test('GPU continent triangles preserve spherical areas and match at subdivided edges', () => {
  for (const [name, suffix] of Object.entries(SUFFIX)) {
    const mesh = globe.continents.find(({ field }) => field === `land${suffix}`);
    assert.ok(mesh);
    const original = feature(atlas, atlas.objects[name]);
    assert.ok(Math.abs(inspectTriangles(mesh) - geoArea(original)) < 1e-8, name);
    checkOriginalVertices(mesh, [original.geometry]);
  }
});

test('every country mask keeps its original footprint, including the Antarctica pole hole', () => {
  const areas = new Map();
  for (const shape of countryFeatures) areas.set(shape.id, (areas.get(shape.id) ?? 0) + geoArea(shape));
  assert.deepEqual(new Set(globe.countries.keys()), new Set(areas.keys()));
  for (const [id, mesh] of globe.countries) {
    // The Italian source ring crosses itself. The mesh fills both lobes;
    // D3's area integral subtracts the reversed lobe.
    const tolerance = id === '380' ? 1e-6 : 1e-8;
    assert.ok(Math.abs(inspectTriangles(mesh) - areas.get(id)) < tolerance, id);
    checkOriginalVertices(mesh, countryFeatures.filter(shape => shape.id === id).map(shape => shape.geometry));
  }
});

test('border and graticule segments follow great circles with bounded spacing', () => {
  for (const [buffer, maximumAngle] of [[globe.borders, .351], [globe.grid, 1.001]]) {
    const points = unitPoints(buffer);
    assert.ok(points.length && points.length % 2 === 0);
    for (let i = 0; i < points.length; i += 2) assert.ok(dot(points[i], points[i + 1]) >= Math.cos(maximumAngle * RAD));
  }
});

test('country fade ranges preserve continental tints and reference only shared borders', () => {
  const owners = new Uint8Array(globe.borders.length / 6);
  const land = Object.keys(SUFFIX).map(name => feature(atlas, atlas.objects[name]));
  for (const [id, country] of globe.countries) {
    let consumed = 0;
    for (const [continent, start, length] of country.faces) {
      assert.equal(start, consumed);
      consumed += length;
      // A triangle interior avoids ambiguous lookups directly on shared borders.
      const center = [0, 0, 0];
      for (const index of country.indices.subarray(start, start + 3)) {
        for (let i = 0; i < 3; i++) center[i] += country.vertices[index * 3 + i];
      }
      const [x, y, z] = center;
      assert.ok(geoContains(land[continent], [Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD]), id);
    }
    assert.equal(consumed, country.indices.length);
    const local = new Set();
    for (const [start, length] of country.borders) {
      assert.ok(start >= 0 && start + length <= owners.length);
      for (let i = start; i < start + length; i++) {
        assert.ok(!local.has(i));
        local.add(i);
        owners[i]++;
      }
    }
  }
  assert.ok(owners.every(count => count === 2));
  assert.deepEqual(globe.countries.get('250').faces.map(([i]) => globe.continents[i].field),
    ['landEurasia', 'landSouthAmerica']);
});
