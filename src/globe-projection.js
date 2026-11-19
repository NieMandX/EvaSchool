import { geoArea } from 'd3-geo';

const RAD = Math.PI / 180;
const TAU = 2 * Math.PI;
const MAX_EDGE = RAD; // Preserve all source vertices and sample long geodesics once.
const MIN_EDGE_COSINE = Math.cos(MAX_EDGE);
const LIMB_EPSILON = 1e-10;
const LIMB_DEPTH_BIAS = 1e-8;

function unitVector([longitude, latitude]) {
  const lon = longitude * RAD;
  const lat = latitude * RAD;
  const parallel = Math.cos(lat);
  return [parallel * Math.cos(lon), parallel * Math.sin(lon), Math.sin(lat)];
}

function prepareRing(points, closed) {
  const count = points.length - (closed ? 1 : 0);
  const vertices = points.slice(0, count).map(unitVector);
  const vectors = [];
  for (let i = 0; i < count; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % count];
    vectors.push(...a);
    if (!closed && i === count - 1) break;
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (dot >= MIN_EDGE_COSINE) continue;
    const angle = Math.acos(Math.max(-1, dot));
    const segments = Math.ceil(angle / MAX_EDGE);
    const sine = Math.sin(angle);
    if (sine < LIMB_EPSILON) return null;
    for (let step = 1; step < segments; step++) {
      const portion = step / segments;
      const left = Math.sin((1 - portion) * angle) / sine;
      const right = Math.sin(portion * angle) / sine;
      vectors.push(left * a[0] + right * b[0], left * a[1] + right * b[1], left * a[2] + right * b[2]);
    }
  }
  return {
    vectors: Float64Array.from(vectors),
    projected: new Float64Array(vectors.length),
    hidden: -1,
    visible: 0,
  };
}

export function prepareMapPart(shape) {
  const polygon = shape.type === 'Polygon';
  // A closed outer ring wholly behind the limb cannot enclose this hemisphere.
  if (polygon && geoArea({ type: 'Polygon', coordinates: [shape.coordinates[0]] }) >= TAU) return null;
  const rings = (polygon ? shape.coordinates : [shape.coordinates]).map(ring => prepareRing(ring, polygon));
  return rings.every(Boolean) ? { polygon, rings } : null;
}

function intersect(points, a, b, radius) {
  const za = points[a + 2];
  const zb = points[b + 2];
  const fraction = za / (za - zb);
  const px = points[a] + (points[b] - points[a]) * fraction;
  const py = points[a + 1] + (points[b + 1] - points[a + 1]) * fraction;
  const scale = radius / Math.hypot(px, py);
  return { x: px * scale, y: py * scale, angle: Math.atan2(py, px) };
}

function appendRing(path, points) {
  path.moveTo(points[0], points[1]);
  for (let i = 3; i < points.length; i += 3) path.lineTo(points[i], points[i + 1]);
  path.closePath();
}

function appendLine(path, points, radius) {
  if (!points.length) return;
  if (points[2] >= 0) path.moveTo(points[0], points[1]);
  for (let i = 3; i < points.length; i += 3) {
    const before = points[i - 1] >= 0;
    const inside = points[i + 2] >= 0;
    if (before !== inside) {
      const crossing = intersect(points, i - 3, i, radius);
      if (before) path.lineTo(crossing.x, crossing.y);
      else path.moveTo(crossing.x, crossing.y);
    }
    if (inside) path.lineTo(points[i], points[i + 1]);
  }
}

function collectChains(ring, radius, chains) {
  const points = ring.projected;
  let previous = ring.hidden;
  let chain;
  // Starting behind the globe lets a ring cross the input seam without splitting a chain.
  for (let offset = 3; offset <= points.length; offset += 3) {
    const index = (ring.hidden + offset) % points.length;
    const before = points[previous + 2] >= 0;
    const inside = points[index + 2] >= 0;
    if (inside && !before) {
      chain = { points, first: index, start: intersect(points, previous, index, radius) };
    } else if (before && !inside) {
      chain.last = previous;
      chain.end = intersect(points, previous, index, radius);
      chains.push(chain);
    }
    previous = index;
  }
}

function joinChains(chains) {
  const crossings = [];
  for (const chain of chains) {
    crossings.push({ angle: chain.start.angle, entry: true, chain });
    crossings.push({ angle: chain.end.angle, entry: false, chain });
  }
  crossings.sort((a, b) => a.angle - b.angle);
  for (let i = 0; i < crossings.length; i++) {
    const here = crossings[i];
    const next = crossings[(i + 1) % crossings.length];
    const sweep = next.angle - here.angle + (i === crossings.length - 1 ? TAU : 0);
    if (here.entry === next.entry || sweep < LIMB_EPSILON) return false;
    // The interior is on the right of every directed coast, including hole rings.
    // Each exit therefore closes clockwise around the limb to the next entry.
    if (!here.entry) {
      here.chain.next = next.chain;
      here.chain.sweep = sweep;
    }
  }
  return true;
}

function appendChains(path, chains, radius) {
  for (const first of chains) {
    if (first.drawn) continue;
    path.moveTo(first.start.x, first.start.y);
    let chain = first;
    do {
      const points = chain.points;
      let index = chain.first;
      while (true) {
        path.lineTo(points[index], points[index + 1]);
        if (index === chain.last) break;
        index = (index + 3) % points.length;
      }
      path.lineTo(chain.end.x, chain.end.y);
      path.arc(0, 0, radius, chain.end.angle, chain.end.angle + chain.sweep);
      chain.drawn = true;
      chain = chain.next;
    } while (chain !== first);
    path.closePath();
  }
}

export function createGlobeProjector(longitude, latitude, radius) {
  const lon = longitude * RAD;
  const lat = latitude * RAD;
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const rightX = -sinLon * radius;
  const rightY = cosLon * radius;
  const downX = sinLat * cosLon * radius;
  const downY = sinLat * sinLon * radius;
  const downZ = -cosLat * radius;
  const frontX = cosLat * cosLon;
  const frontY = cosLat * sinLon;

  function project(ring) {
    const { vectors, projected } = ring;
    let hidden = -1;
    let visible = 0;
    for (let i = 0; i < vectors.length; i += 3) {
      const x = vectors[i];
      const y = vectors[i + 1];
      const z = vectors[i + 2];
      const depth = frontX * x + frontY * y + sinLat * z;
      projected[i] = rightX * x + rightY * y;
      projected[i + 1] = downX * x + downY * y + downZ * z;
      // Treat an exact tangent as just visible to keep horizon crossings distinct.
      const clipDepth = Math.abs(depth) < LIMB_EPSILON ? LIMB_DEPTH_BIAS : depth;
      projected[i + 2] = clipDepth;
      if (clipDepth >= 0) visible++;
      else hidden = i;
    }
    ring.hidden = hidden;
    ring.visible = visible;
  }

  return {
    append(path, part) {
      if (!part) return false;
      const { polygon, rings } = part;
      if (!polygon) {
        project(rings[0]);
        if (rings[0].visible) appendLine(path, rings[0].projected, radius);
        return true;
      }
      const outer = rings[0];
      project(outer);
      if (rings.length === 1) {
        if (!outer.visible) return true;
        if (outer.hidden < 0) {
          appendRing(path, outer.projected);
          return true;
        }
      }
      for (let i = 1; i < rings.length; i++) project(rings[i]);
      if (!outer.visible) return rings.every(ring => !ring.visible);

      const chains = [];
      for (const ring of rings) {
        if (ring.hidden < 0 || !ring.visible) continue;
        collectChains(ring, radius, chains);
      }
      // Let the general D3 clipper handle coincident horizon crossings.
      if (chains.length && !joinChains(chains)) return false;
      for (const ring of rings) {
        if (ring.hidden < 0 && ring.visible) appendRing(path, ring.projected);
      }
      appendChains(path, chains, radius);
      return true;
    },
  };
}
