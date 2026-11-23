const TRIANGLES_PER_BATCH = 2500;

// Partition only the index stream. Vertex positions, triangle winding and
// country masks are untouched; each mesh still fits a WebGL 1 Uint16 index buffer.
export function batchContinent({ vertices, indices }) {
  if (!(indices instanceof Uint16Array)) throw new RangeError('Continent mesh exceeds the WebGL 1 index range.');
  const triangleCount = indices.length / 3;
  const order = Array.from({ length: triangleCount }, (_, index) => index);
  const centers = new Float32Array(indices.length);
  const sorted = new Uint16Array(indices.length);
  const batches = [];
  let written = 0;
  for (let i = 0; i < indices.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      centers[i + axis] = (vertices[3 * indices[i] + axis] + vertices[3 * indices[i + 1] + axis]
        + vertices[3 * indices[i + 2] + axis]) / 3;
    }
  }
  function split(triangles) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const leaf = triangles.length <= TRIANGLES_PER_BATCH;
    for (const tri of triangles) {
      if (leaf) {
        for (let j = 0; j < 3; j++) {
          const start = indices[tri * 3 + j] * 3;
          for (let axis = 0; axis < 3; axis++) {
            lo[axis] = Math.min(lo[axis], vertices[start + axis]);
            hi[axis] = Math.max(hi[axis], vertices[start + axis]);
          }
        }
      } else {
        for (let axis = 0; axis < 3; axis++) {
          lo[axis] = Math.min(lo[axis], centers[tri * 3 + axis]);
          hi[axis] = Math.max(hi[axis], centers[tri * 3 + axis]);
        }
      }
    }
    if (!leaf) {
      let axis = 0;
      for (let i = 1; i < 3; i++) if (hi[i] - lo[i] > hi[axis] - lo[axis]) axis = i;
      triangles.sort((a, b) => centers[a * 3 + axis] - centers[b * 3 + axis]);
      const mid = Math.floor(triangles.length / 2);
      split(triangles.slice(0, mid));
      split(triangles.slice(mid));
      return;
    }
    // Preserve the original order inside each spatial batch for vertex reuse.
    triangles.sort((a, b) => a - b);
    for (const tri of triangles) {
      for (let j = 0; j < 3; j++) {
        sorted[written++] = indices[3 * tri + j];
      }
    }
    const center = lo.map((min, axis) => (min + hi[axis]) / 2);
    const halfSize = lo.map((min, axis) => (hi[axis] - min) / 2 + 2e-6);
    batches.push([written, ...center, ...halfSize]);
  }
  split(order);
  return { vertices, indices: sorted, batches };
}
