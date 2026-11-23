import { batchContinent } from './globe-batches.mjs';

export function globeMeshModule({ continents, countries, borders, grid }) {
  const chunks = [];
  let offset = 0;

  function write(array) {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const padding = (array.BYTES_PER_ELEMENT - offset % array.BYTES_PER_ELEMENT) % array.BYTES_PER_ELEMENT;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      offset += padding;
    }
    const range = [offset, array.length];
    offset += bytes.length;
    chunks.push(bytes);
    return range;
  }

  function geometry({ vertices, indices }) {
    if (!(indices instanceof Uint16Array)) throw new RangeError('Globe mesh groups must fit WebGL 1 16-bit indices.');
    return [write(vertices), write(indices)];
  }

  const manifest = {
    continents: continents.map(part => {
      const spatial = batchContinent(part);
      return [part.field, geometry(spatial), spatial.batches];
    }),
    countries: [...countries].map(([id, part]) => [id, geometry(part), part.faces, part.borders]),
    borders: write(borders),
    grid: write(grid),
  };
  const encoded = Buffer.concat(chunks, offset).toString('base64');
  return `
    let mesh;
    export function loadGlobeMesh() {
      if (mesh) return mesh;
      const encoded = atob(${JSON.stringify(encoded)});
      const bytes = new Uint8Array(encoded.length);
      for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
      const manifest = ${JSON.stringify(manifest)};
      function positions([offset, count]) {
        return new Float32Array(bytes.buffer, offset, count);
      }
      function geometry([vertices, indices]) {
        return { vertices: positions(vertices), indices: new Uint16Array(bytes.buffer, ...indices) };
      }
      mesh = {
        continents: manifest.continents.map(([field, part, batches]) => ({ field, ...geometry(part), batches })),
        countries: new Map(manifest.countries.map(([id, part, faces, borders]) => [id, { ...geometry(part), faces, borders }])),
        borders: positions(manifest.borders),
        grid: positions(manifest.grid),
      };
      return mesh;
    }
  `;
}
