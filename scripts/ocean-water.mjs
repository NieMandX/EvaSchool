import { geoBounds } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import { createCountryIndex } from '../src/globe-geography.js';
import { EDGE, LAND, WATER, WATER_COLUMNS, WATER_ROWS } from '../src/ocean-water.js';

const STEP = 360 / WATER_COLUMNS;
const EPSILON = 1e-8;

export function buildOceanWaterGrid(atlas) {
  const cells = new Uint8Array(WATER_COLUMNS * WATER_ROWS);
  const countries = atlas.objects.countries;
  const countryAt = createCountryIndex(feature(atlas, countries).features);
  const lines = mesh(atlas, countries).coordinates;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      // Spherical bounds include latitude extrema between vertices of a great-circle arc.
      const [[west, south], [east, north]] = geoBounds({ type: 'LineString', coordinates: [line[i - 1], line[i]] });
      const crossesPole = north >= 90 - EPSILON || south <= -90 + EPSILON;
      const x0 = crossesPole ? 0 : Math.floor((180 + west - EPSILON) / STEP);
      const x1 = crossesPole ? WATER_COLUMNS - 1 : Math.floor((180 + east + (east < west ? 360 : 0) + EPSILON) / STEP);
      const y0 = Math.max(0, Math.floor((90 + south - EPSILON) / STEP));
      const y1 = Math.min(WATER_ROWS - 1, Math.floor((90 + north + EPSILON) / STEP));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) cells[y * WATER_COLUMNS + (x + WATER_COLUMNS) % WATER_COLUMNS] = EDGE;
      }
    }
  }

  // Land/water cannot change inside a connected component of edge-free cells.
  // Sample one interior point, then flood fill that component, also across the date line.
  const queue = new Int32Array(cells.length);
  for (let start = 0; start < cells.length; start++) {
    if (cells[start]) continue;
    const lon = (start % WATER_COLUMNS + .5) * STEP - 180;
    const lat = (Math.floor(start / WATER_COLUMNS) + .5) * STEP - 90;
    const material = countryAt([lon, lat]) ? LAND : WATER;
    let tail = 0;
    function visit(cell) {
      if (cells[cell] === 0) {
        cells[cell] = material;
        queue[tail++] = cell;
      }
    }
    visit(start);
    for (let head = 0; head < tail; head++) {
      const cell = queue[head];
      const x = cell % WATER_COLUMNS;
      visit(x === 0 ? cell + WATER_COLUMNS - 1 : cell - 1);
      visit(x === WATER_COLUMNS - 1 ? cell - WATER_COLUMNS + 1 : cell + 1);
      if (cell >= WATER_COLUMNS) visit(cell - WATER_COLUMNS);
      if (cell < cells.length - WATER_COLUMNS) visit(cell + WATER_COLUMNS);
    }
  }
  const runs = [];
  for (let i = 0; i < cells.length;) {
    let end = i + 1;
    while (end < cells.length && end - i < 64 && cells[end] === cells[i]) end++;
    runs.push(((end - i - 1) << 2) | cells[i]);
    i = end;
  }
  return Buffer.from(runs).toString('base64');
}
