import { geoBounds, geoContains, geoStream } from 'd3-geo';

const CELL = 10;
const COLUMNS = 360 / CELL;
const ROWS = 180 / CELL;
const RAD = Math.PI / 180;

const column = lon => Math.max(0, Math.min(COLUMNS - 1, Math.floor((lon + 180) / CELL)));
const row = lat => Math.max(0, Math.min(ROWS - 1, Math.floor((lat + 90) / CELL)));

export function createCountryIndex(countries) {
  const cells = Array.from({ length: COLUMNS * ROWS }, () => []);
  for (const country of countries) {
    const [[west, south], [east, north]] = geoBounds(country);
    const ranges = west <= east ? [[west, east]] : [[west, 180], [-180, east]];
    for (let y = row(south); y <= row(north); y++) {
      for (const [start, end] of ranges) {
        for (let x = column(start); x <= column(end); x++) cells[y * COLUMNS + x].push(country);
      }
    }
  }
  return coordinates => {
    const [lon, lat] = coordinates;
    const candidates = cells[row(lat) * COLUMNS + column(lon)];
    return candidates.find(country => geoContains(country, coordinates)) ?? null;
  };
}

// Accents are composited in draw order. Undo the displayed transform of each
// country before testing the sphere, including pixels just outside its rim.
export function pickVisibleCountry(point, center, accents, surfaceCountryAt) {
  if (!accents.length) return surfaceCountryAt(point);
  for (let i = accents.length - 1; i >= 0; i--) {
    const { id, scale, offsetX, offsetY } = accents[i];
    const original = {
      x: center.x + (point.x - center.x - offsetX) / scale,
      y: center.y + (point.y - center.y - offsetY) / scale,
    };
    const hit = surfaceCountryAt(original);
    if (hit?.id === id) return hit;
  }
  const base = surfaceCountryAt(point);
  return base && accents.some(accent => accent.id === base.id && accent.cutOpacity === 1) ? null : base;
}

export function tileLineVertices(entries) {
  const positions = [];
  let line = false;
  let previous = null;
  const sink = {
    point(lon, lat) {
      if (!line) return;
      const parallel = Math.cos(lat * RAD);
      const next = [parallel * Math.cos(lon * RAD), parallel * Math.sin(lon * RAD), Math.sin(lat * RAD)];
      if (previous) positions.push(...previous, ...next);
      previous = next;
    },
    lineStart() { line = true; },
    lineEnd() { line = false; previous = null; },
    polygonStart() {},
    polygonEnd() {},
    sphere() {},
  };
  for (const { data } of entries) if (data) geoStream(data, sink);
  return new Float32Array(positions);
}
