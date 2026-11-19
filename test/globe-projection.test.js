import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { geoContains, geoOrthographic, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import { createGlobeProjector, prepareMapPart } from '../src/globe-projection.js';

class SamplePath {
  rings = [];

  moveTo(x, y) {
    this.rings.push([[x, y]]);
  }

  lineTo(x, y) {
    this.rings.at(-1).push([x, y]);
  }

  closePath() {
    const ring = this.rings.at(-1);
    ring.push(ring[0]);
  }

  arc(x, y, radius, start, end) {
    const segments = Math.max(1, Math.ceil((end - start) / .01));
    for (let i = 1; i <= segments; i++) {
      const angle = start + (end - start) * (i / segments);
      this.lineTo(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
    }
  }

  contains([x, y]) {
    let winding = 0;
    for (const ring of this.rings) {
      for (let i = 1; i < ring.length; i++) {
        const [ax, ay] = ring[i - 1];
        const [bx, by] = ring[i];
        if ((ay > y) === (by > y)) continue;
        if (ax + (bx - ax) * (y - ay) / (by - ay) > x) winding += by > ay ? 1 : -1;
      }
    }
    return winding !== 0;
  }
}

test('the projector keeps source border vertices on their orthographic positions', () => {
  const coordinates = [[175, 6], [-179, 4], [-176, 3], [-173, 2]];
  const part = prepareMapPart({ type: 'LineString', coordinates });
  const camera = createGlobeProjector(178, 5, 280);
  const reference = geoOrthographic().translate([0, 0]).scale(280).rotate([-178, -5, 0]);
  const path = new SamplePath();
  assert.ok(camera.append(path, part));
  for (const coordinate of coordinates) {
    const [x, y] = reference(coordinate);
    assert.ok(path.rings[0].some(([px, py]) => Math.hypot(x - px, y - py) < 1e-8));
  }
});

test('an island touching the horizon stays a thin sliver', () => {
  const part = prepareMapPart({
    type: 'Polygon',
    coordinates: [[[89, -1], [89, 1], [90, .5], [91, -1], [89, -1]]],
  });
  const path = new SamplePath();
  assert.ok(createGlobeProjector(0, 0, 500).append(path, part));
  assert.equal(path.rings.length, 1);
  assert.ok(path.rings[0].every(([x]) => x > 499));
});

test('continent fills agree with spherical containment across the limb, poles and antimeridian', () => {
  const atlas = JSON.parse(readFileSync(new URL('../src/assets/countries.json', import.meta.url), 'utf8'));
  const layers = Object.entries(atlas.objects)
    .filter(([id]) => id !== 'land' && id !== 'countries')
    .map(([id, object]) => {
      const shapes = feature(atlas, object).geometry.coordinates.map(coordinates => ({ type: 'Polygon', coordinates }));
      return { id, shapes, compiled: shapes.map(prepareMapPart), geometry: { type: 'GeometryCollection', geometries: shapes } };
    });

  const radius = 237;
  for (const [lon, lat] of [[87, 18], [-90, 0], [178, 12], [-179, -31], [5, 89], [120, -89], [30, 0]]) {
    const camera = createGlobeProjector(lon, lat, radius);
    const reference = geoOrthographic().clipAngle(90).translate([0, 0]).scale(radius).rotate([-lon, -lat, 0]);
    const samples = [];
    for (const fraction of [.12, .36, .59, .78, .93, .985]) {
      for (let i = 0; i < 13; i++) {
        const angle = i * (2 * Math.PI / 13) + fraction * 1.3;
        const point = [Math.cos(angle) * radius * fraction, Math.sin(angle) * radius * fraction];
        samples.push({ point, coordinate: reference.invert(point) });
      }
    }

    for (const { id, shapes, compiled, geometry } of layers) {
      const path = new SamplePath();
      const fallback = geoPath(reference, path);
      for (let i = 0; i < compiled.length; i++) {
        if (!camera.append(path, compiled[i])) fallback(shapes[i]);
      }
      for (const { point, coordinate } of samples) {
        assert.equal(path.contains(point), geoContains(geometry, coordinate), `${id} at ${coordinate} from ${lon}, ${lat}`);
      }
    }
  }
});
