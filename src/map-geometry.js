// A spherical cap lets the projection skip shapes wholly behind or outside the
// visible part of the globe. Shorter great-circle arcs stay inside caps < 90°.
const RAD = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function direction(lon, lat) {
  const longitude = lon * RAD;
  const latitude = lat * RAD;
  const cos = Math.cos(latitude);
  return [cos * Math.cos(longitude), cos * Math.sin(longitude), Math.sin(latitude)];
}

function bound(rings) {
  const points = rings.flatMap(ring => ring.map(([lon, lat]) => direction(lon, lat)));
  const center = [0, 0, 0];
  for (const point of points) {
    center[0] += point[0];
    center[1] += point[1];
    center[2] += point[2];
  }
  const length = Math.hypot(...center);
  if (!length) return null;
  for (let axis = 0; axis < 3; axis++) center[axis] /= length;
  let cosine = 1;
  for (const point of points) cosine = Math.min(cosine, dot(center, point));
  return cosine > 0 ? { center, cosine, sine: Math.sqrt(1 - cosine ** 2) } : null;
}

export function mapParts(geometry) {
  const polygon = geometry.type === 'MultiPolygon';
  const parts = geometry.coordinates.map(coordinates => ({
    shape: { type: polygon ? 'Polygon' : 'LineString', coordinates },
    cap: bound(polygon ? coordinates : [coordinates]),
  }));
  return { parts, collection: { type: 'GeometryCollection', geometries: [] } };
}

export function viewCap(lon, lat, radius, x, y, width, height) {
  const sine = Math.min(1, Math.hypot(Math.max(x, width - x) + 3, Math.max(y, height - y) + 3) / radius);
  return { center: direction(lon, lat), cosine: Math.sqrt(1 - sine ** 2), sine };
}

export function visibleParts({ parts, collection }, view) {
  collection.geometries.length = 0;
  for (const { shape, cap } of parts) {
    const intersects = !cap || dot(cap.center, view.center) + .0001 >= cap.cosine * view.cosine - cap.sine * view.sine;
    if (intersects) collection.geometries.push(shape);
  }
  return collection;
}
