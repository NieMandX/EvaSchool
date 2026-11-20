const RAD = Math.PI / 180;

function tileNode(z, x, y, view) {
  const columns = 2 ** z;
  const width = 360 / columns;
  const height = 180 / columns;
  const west = x * width - 180;
  const north = 90 - y * height;
  const south = north - height;
  const east = west + width;
  let span = 2;
  if (z) {
    const southCos = Math.cos(south * RAD);
    const northCos = Math.cos(north * RAD);
    // Maximize the dot product over the whole geographic rectangle. The
    // closest longitude is the view longitude or one of the tile edges.
    const horizontal = west <= view.lon && view.lon <= east ? view.parallel : Math.max(
      view.parallel * Math.cos((west - view.lon) * RAD), view.parallel * Math.cos((east - view.lon) * RAD),
    );
    const nearestLatitude = Math.atan2(view.vertical, horizontal) / RAD;
    const dot = south <= nearestLatitude && nearestLatitude <= north ? Math.hypot(horizontal, view.vertical) : Math.max(
      horizontal * southCos + view.vertical * Math.sin(south * RAD),
      horizontal * northCos + view.vertical * Math.sin(north * RAD),
    );
    if (dot + 1e-14 < view.cosine) return null;

    // The tile fits in a cap centered on its midpoint whose furthest corner
    // is on the edge closer to the equator. Its diameter bounds the projection.
    const haversine = Math.sin(height * RAD / 4) ** 2 +
      Math.cos((north + south) * RAD / 2) * Math.max(southCos, northCos) * Math.sin(width * RAD / 4) ** 2;
    span = 4 * Math.sqrt(haversine * (1 - haversine));
  }
  const bounds = { west, south, east, north };
  const tile = { id: `${z}/${x}/${y}`, z, x, y, bounds };
  return { tile, span, children: null };
}

function tilePlan(cap, radius, { minZoom, maxZoom, tilePixels, maxTiles, maxCache }) {
  const [x, y, vertical] = cap.center;
  const view = { lon: Math.atan2(y, x) / RAD, parallel: Math.hypot(x, y), vertical, cosine: cap.cosine };
  const root = tileNode(0, 0, 0);
  const wanted = new Map([[root.tile.id, root.tile]]);
  const candidates = [];
  let leaves = 1;

  function consider(node) {
    const { z } = node.tile;
    if (z < maxZoom && (z < minZoom || node.span * radius > tilePixels)) candidates.push(node);
  }

  consider(root);
  while (candidates.length && wanted.size < maxCache) {
    // Refining the largest projected tile first also prioritizes coarser requests.
    let biggest = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].span > candidates[biggest].span) biggest = i;
    }
    const parent = candidates.splice(biggest, 1)[0];
    const { z, x, y } = parent.tile;
    const children = [];
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const child = tileNode(z + 1, 2 * x + dx, 2 * y + dy, view);
        if (child) children.push(child);
      }
    }
    if (!children.length || leaves + children.length - 1 > maxTiles || wanted.size + children.length > maxCache) continue;
    parent.children = children;
    leaves += children.length - 1;
    for (const child of children) {
      wanted.set(child.tile.id, child.tile);
      consider(child);
    }
  }
  return { root, wanted };
}

/**
 * Geographic XYZ tiles. z=0 is one world tile, x increases eastward from
 * -180°, y increases southward from 90°. Bounds are in degrees. This grid
 * differs from Web Mercator XYZ and from the two-root EPSG:4326 tile matrix.
 *
 * loadTile(tile, { signal }) returns data or a promise. Null may represent
 * an empty tile. Data must cover that tile on its own at the given level.
 * update(cap, radius) takes map-geometry's viewCap and a radius in CSS pixels.
 * tilePixels is the target projected diameter in CSS pixels. minZoom is a
 * refinement goal. maxZoom, maxTiles (visible leaves), maxCache (retained
 * results and planned nodes), and maxConcurrent (unsettled requests) are
 * hard limits. Ancestors stay available until all visible children load.
 *
 * onChange(visible) fires when the entries returned by visible() change.
 * A failed request is retried after the tile leaves and re-enters the plan.
 * An obsolete request is aborted and occupies its slot until it settles.
 */
export function createGlobeTiles({
  loadTile, onChange = () => {}, minZoom = 0, maxZoom = 8,
  tilePixels = 384, maxTiles = 32, maxCache = 96, maxConcurrent = 4,
}) {
  if (typeof loadTile !== 'function') throw new TypeError('loadTile must be a function');
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom < 0 || maxZoom < minZoom || maxZoom > 24 ||
      !Number.isFinite(tilePixels) || tilePixels <= 0 ||
      ![maxTiles, maxCache, maxConcurrent].every(value => Number.isInteger(value) && value > 0)) {
    throw new RangeError('Invalid globe tile limits');
  }

  const limits = { minZoom, maxZoom, tilePixels, maxTiles, maxCache };
  const cache = new Map();
  const pending = new Map();
  const failed = new Set();
  let root = null;
  let wanted = new Map();
  let visible = [];
  let disposed = false;
  let notify = false;

  function collect(node, output) {
    if (node.children?.every(child => cache.has(child.tile.id))) {
      for (const child of node.children) collect(child, output);
    } else {
      const result = cache.get(node.tile.id);
      if (result) output.push(result);
    }
  }

  function publish() {
    const next = [];
    if (root) collect(root, next);
    if (next.length === visible.length && next.every((entry, index) => entry === visible[index])) return;
    visible = next;
    if (notify) return;
    notify = true;
    Promise.resolve().then(() => {
      notify = false;
      if (!disposed) onChange(visible);
    });
  }

  function retain(tile, data) {
    if (cache.size === maxCache) {
      for (const id of cache.keys()) {
        if (wanted.has(id)) continue;
        cache.delete(id);
        break;
      }
    }
    cache.set(tile.id, { tile, data });
  }

  function start(tile) {
    const controller = new AbortController();
    const { signal } = controller;
    pending.set(tile.id, controller);
    function settle(loaded, data) {
      pending.delete(tile.id);
      if (disposed) return;
      if (!signal.aborted && wanted.has(tile.id)) {
        if (loaded) retain(tile, data);
        else failed.add(tile.id);
        publish();
      }
      pump();
    }
    Promise.resolve().then(() => {
      if (!signal.aborted) return loadTile(tile, { signal });
    }).then(data => settle(true, data), () => settle(false));
  }

  function pump() {
    for (const [id, tile] of wanted) {
      if (pending.size >= maxConcurrent) break;
      if (!cache.has(id) && !pending.has(id) && !failed.has(id)) start(tile);
    }
  }

  return {
    update(cap, radius) {
      if (disposed) return;
      const before = wanted;
      if (cap && Number.isFinite(radius) && radius > 0) {
        ({ root, wanted } = tilePlan(cap, radius, limits));
      } else {
        root = null;
        wanted = new Map();
      }
      for (const id of before.keys()) {
        if (wanted.has(id)) continue;
        pending.get(id)?.abort();
        failed.delete(id);
        const entry = cache.get(id);
        if (entry) {
          // The active view kept this entry hot even if it was loaded long ago.
          cache.delete(id);
          cache.set(id, entry);
        }
      }
      publish();
      pump();
    },
    visible: () => visible,
    dispose() {
      disposed = true;
      root = null;
      wanted.clear();
      for (const controller of pending.values()) controller.abort();
      pending.clear();
      cache.clear();
      failed.clear();
      visible = [];
    },
  };
}
