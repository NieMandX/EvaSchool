import { geoGraticule } from 'd3-geo';
import earcut, { deviation } from 'earcut';
import { feature, mesh } from 'topojson-client';

const RAD = Math.PI / 180;
const COAST_LIMIT = 1 - Math.cos(.35 * RAD);
const SURFACE_LIMIT = 1 - Math.cos(1.45 * RAD);
const GRID_LIMIT = 1 - Math.cos(RAD);
const continentFields = {
  eurasia: 'landEurasia',
  africa: 'landAfrica',
  'north-america': 'landNorthAmerica',
  'south-america': 'landSouthAmerica',
  oceania: 'landOceania',
  antarctica: 'landAntarctica',
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sum = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const normalize = a => {
  const n = Math.hypot(...a);
  if (!n) throw new Error('Cannot place an antipodal edge on the globe.');
  return [a[0] / n, a[1] / n, a[2] / n];
};
const midpoint = (a, b) => normalize(sum(a, b));
const edgeKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;

function unitVector([longitude, latitude]) {
  if (Math.abs(latitude) === 90) return [0, 0, Math.sign(latitude)];
  const lon = (longitude === 180 ? -180 : longitude) * RAD;
  const lat = latitude * RAD;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

function polygons(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error(`Unsupported globe polygon type: ${geometry?.type}`);
}

function gnomonicPlane(ring) {
  const center = normalize(ring.reduce(sum, [0, 0, 0]));
  const east = normalize(cross(Math.abs(center[2]) > .9 ? [0, 1, 0] : [0, 0, 1], center));
  const north = cross(center, east);
  return {
    project(point) {
      // Great-circle arcs become straight lines in each polygon's open hemisphere.
      const depth = dot(center, point);
      if (depth <= 0) throw new Error('Globe polygon does not fit a single open hemisphere.');
      return [dot(east, point) / depth, dot(north, point) / depth];
    },
    unproject([x, y]) {
      return normalize(center.map((value, i) => value + x * east[i] + y * north[i]));
    },
  };
}

function planarArea(ring, xy) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = xy.get(ring[i]);
    const [bx, by] = xy.get(ring[(i + 1) % ring.length]);
    area += ax * by - ay * bx;
  }
  return area / 2;
}

function planarContains(ring, xy, [x, y]) {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = xy.get(ring[i]);
    const [bx, by] = xy.get(ring[(i + 1) % ring.length]);
    if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) inside = !inside;
  }
  return inside;
}

function triangulate(rings, xy) {
  const order = [];
  const holes = [];
  for (const ring of rings) {
    if (order.length) holes.push(order.length);
    order.push(...ring);
  }
  const points = order.flatMap(index => xy.get(index));
  const indices = earcut(points, holes);
  return { triangles: indices.map(index => order[index]), error: deviation(points, holes, 2, indices) };
}

function splitCrossings(ring, xy, addPoint) {
  const edges = ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length], splits: [{ index: a, t: 0 }] }));
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const [ax, ay] = xy.get(edge.a);
    const [bx, by] = xy.get(edge.b);
    for (let j = i + 2; j < edges.length; j++) {
      const other = edges[j];
      const [cx, cy] = xy.get(other.a);
      const [dx, dy] = xy.get(other.b);
      const denominator = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
      if (denominator === 0) continue;
      const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denominator;
      const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denominator;
      if (t <= 1e-10 || t >= 1 - 1e-10 || u <= 1e-10 || u >= 1 - 1e-10) continue;
      const point = [ax + t * (bx - ax), ay + t * (by - ay)];
      const index = addPoint(point);
      xy.set(index, point);
      edge.splits.push({ index, t });
      other.splits.push({ index, t: u });
      crossings++;
    }
  }
  if (!crossings) return [ring];

  // Walk the bounded faces of the few self-crossing source outlines. Face
  // boundaries follow original segments exactly, including new intersection points.
  const adjacency = new Map();
  function connect(a, b) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  }
  for (const edge of edges) {
    const ordered = edge.splits.sort((a, b) => a.t - b.t).map(({ index }) => index);
    ordered.push(edge.b);
    for (let i = 1; i < ordered.length; i++) {
      connect(ordered[i - 1], ordered[i]);
      connect(ordered[i], ordered[i - 1]);
    }
  }
  const neighbors = new Map([...adjacency].map(([index, adjacent]) => {
    const [x, y] = xy.get(index);
    const angle = other => Math.atan2(xy.get(other)[1] - y, xy.get(other)[0] - x);
    return [index, [...adjacent].sort((a, b) => angle(a) - angle(b))];
  }));
  const seen = new Set();
  const faces = [];
  for (const [first, adjacent] of neighbors) {
    for (const second of adjacent) {
      if (seen.has(`${first}>${second}`)) continue;
      const face = [];
      let a = first;
      let b = second;
      do {
        const direction = `${a}>${b}`;
        if (seen.has(direction)) throw new Error('Cannot trace self-crossing globe outline.');
        seen.add(direction);
        face.push(a);
        const next = neighbors.get(b);
        [a, b] = [b, next[(next.indexOf(a) + next.length - 1) % next.length]];
      } while (a !== first || b !== second);
      if (face.length < 3 || planarArea(face, xy) <= 0) continue;
      const { triangles } = triangulate([face], xy);
      const corners = triangles.slice(0, 3).map(index => xy.get(index));
      if (corners.length !== 3) continue;
      const point = [0, 1].map(axis => (corners[0][axis] + corners[1][axis] + corners[2][axis]) / 3);
      if (planarContains(ring, xy, point)) faces.push(face);
    }
  }
  return faces;
}

function createBuilder() {
  const vertices = [];
  const indices = [];
  const vertexIds = new Map();
  const midpoints = new Map();

  function addVertex(point) {
    const key = point.join(',');
    const existing = vertexIds.get(key);
    if (existing !== undefined) return existing;
    const index = vertices.length;
    vertices.push(point);
    vertexIds.set(key, index);
    return index;
  }

  function refine(triangle, boundaries, chains) {
    const stack = [triangle];
    while (stack.length) {
      const points = stack.pop();
      let split = -1;
      let length = 1;
      for (let i = 0; i < 3; i++) {
        const a = points[i];
        const b = points[(i + 1) % 3];
        const key = edgeKey(a, b);
        const chain = chains.get(key);
        if (chain) {
          // Earcut may remove collinear vertices. Put them back on the original edge.
          const third = points[(i + 2) % 3];
          const ordered = chain[0] === a ? chain : [...chain].reverse();
          for (let j = 1; j < ordered.length; j++) stack.push([ordered[j - 1], ordered[j], third]);
          split = -2;
          break;
        }
        const ratio = (1 - dot(vertices[a], vertices[b])) / (boundaries.has(key) ? COAST_LIMIT : SURFACE_LIMIT);
        if (ratio > length) {
          length = ratio;
          split = i;
        }
      }
      if (split === -2) continue;
      if (split < 0) {
        indices.push(...points);
        continue;
      }
      const a = points[split];
      const b = points[(split + 1) % 3];
      const third = points[(split + 2) % 3];
      const key = edgeKey(a, b);
      let middle = midpoints.get(key);
      if (middle === undefined) {
        middle = addVertex(midpoint(vertices[a], vertices[b]));
        midpoints.set(key, middle);
      }
      if (boundaries.has(key)) {
        boundaries.add(edgeKey(a, middle));
        boundaries.add(edgeKey(middle, b));
      }
      stack.push([a, middle, third], [middle, b, third]);
    }
  }

  function addTriangles(triangles, rings) {
    const used = new Set(triangles);
    const boundaries = new Set();
    const chains = new Map();
    for (const ring of rings) {
      const start = ring.findIndex(index => used.has(index));
      if (start < 0) continue;
      let chain = [ring[start]];
      for (let offset = 1; offset <= ring.length; offset++) {
        const index = ring[(start + offset) % ring.length];
        boundaries.add(edgeKey(chain.at(-1), index));
        chain.push(index);
        if (used.has(index)) {
          if (chain.length > 2) chains.set(edgeKey(chain[0], index), chain);
          chain = [index];
        }
      }
    }
    for (let i = 0; i < triangles.length; i += 3) {
      const [a, b, c] = triangles.slice(i, i + 3);
      const orientation = dot(vertices[a], cross(vertices[b], vertices[c]));
      refine(orientation < 0 ? [a, c, b] : [a, b, c], boundaries, chains);
    }
  }

  function addPolygon(polygon) {
    const rings = polygon.map(ring => {
      const points = [];
      for (const coordinate of ring.slice(0, -1)) {
        const id = addVertex(unitVector(coordinate));
        if (points.at(-1) !== id) points.push(id);
      }
      if (points[0] === points.at(-1)) points.pop();
      return points;
    }).filter(ring => ring.length >= 3);
    if (!rings.length) return;
    const plane = gnomonicPlane(rings.flat().map(index => vertices[index]));
    const xy = new Map(rings.flat().map(index => [index, plane.project(vertices[index])]));
    // The atlas's Antarctica country puts its pole hole before the outer ring.
    rings.sort((a, b) => Math.abs(planarArea(b, xy)) - Math.abs(planarArea(a, xy)));
    const { triangles, error } = triangulate(rings, xy);
    if (error <= 1e-7) {
      addTriangles(triangles, rings);
      return;
    }

    const [outer, ...holes] = rings;
    const faces = splitCrossings(outer, xy, point => addVertex(plane.unproject(point)));
    for (const face of faces) {
      const enclosed = holes.filter(ring => planarContains(face, xy, xy.get(ring[0])));
      const polygonFaces = [face, ...enclosed];
      const tessellation = triangulate(polygonFaces, xy);
      if (tessellation.error > 1e-7) throw new Error(`Globe triangulation area differs by ${tessellation.error}.`);
      addTriangles(tessellation.triangles, polygonFaces);
    }
  }

  return {
    addPolygon,
    finish() {
      return {
        vertices: Float32Array.from(vertices.flat()),
        indices: vertices.length > 65_536 ? Uint32Array.from(indices) : Uint16Array.from(indices),
      };
    },
  };
}

function subdivideLines(geometry, limit = COAST_LIMIT) {
  const coordinates = [];
  function append(a, b) {
    const length = 1 - dot(a, b);
    if (length < 1e-15) return;
    if (length <= limit) {
      coordinates.push(...a, ...b);
      return;
    }
    const middle = midpoint(a, b);
    append(a, middle);
    append(middle, b);
  }
  for (const line of geometry.coordinates) {
    for (let i = 1; i < line.length; i++) append(unitVector(line[i - 1]), unitVector(line[i]));
  }
  return Float32Array.from(coordinates);
}

export function createGlobeMesh(atlas) {
  const continents = Object.entries(continentFields).map(([name, field]) => {
    const builder = createBuilder();
    for (const polygon of polygons(feature(atlas, atlas.objects[name]).geometry)) builder.addPolygon(polygon);
    return { field, ...builder.finish() };
  });
  const countryBuilders = new Map();
  for (const { id, geometry } of feature(atlas, atlas.objects.countries).features) {
    const key = String(id);
    if (!countryBuilders.has(key)) countryBuilders.set(key, createBuilder());
    for (const polygon of polygons(geometry)) countryBuilders.get(key).addPolygon(polygon);
  }
  const countries = new Map([...countryBuilders].map(([id, builder]) => [id, builder.finish()]));
  const borders = subdivideLines(mesh(atlas, atlas.objects.countries, (a, b) => a !== b && a.id !== b.id));
  const grid = subdivideLines(geoGraticule().step([15, 15]).stepMajor([90, 90]).precision(5)(), GRID_LIMIT);
  return { continents, countries, borders, grid };
}
