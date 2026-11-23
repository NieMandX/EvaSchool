import { projectGlobePoint } from './globe-camera.js';

const RAD = Math.PI / 180;
const EDGE_FADE = 23;
const SIDE_GUTTER = 4;
const LABEL_GAP = 5;
const MIN_FRONT = .222; // The outer few degrees are too compressed for readable type.

const oceans = [
  {
    lines: ['ТИХИЙ', 'ОКЕАН'],
    anchors: [
      [137, 20], [138, 12], [142, 12], [145, 20], [149, 16],
      [166, -8], [-155, 19], [-132, -23], [-165, 39], [-101, -25], [-151, -43], [177, 39], [175, -36],
    ],
  },
  {
    lines: ['АТЛАНТИЧЕСКИЙ', 'ОКЕАН'],
    anchors: [[-38, 29], [-25, 2], [-26, -28], [-32, 48], [-47, 12], [-36, -41], [-15, -46]],
  },
  {
    lines: ['ИНДИЙСКИЙ', 'ОКЕАН'],
    anchors: [[77, -21], [75, -39], [91, -13], [65, -3], [83, -30], [54, -32], [90, -42]],
  },
  {
    lines: ['СЕВЕРНЫЙ', 'ЛЕДОВИТЫЙ ОКЕАН'],
    anchors: [[23, 82], [95, 82], [-151, 80], [-16, 84], [-92, 86], [161, 81], [52, 85], [-160, 84], [150, 88]],
  },
  {
    lines: ['ЮЖНЫЙ', 'ОКЕАН'],
    anchors: [[3, -62], [89, -62], [164, -62], [-106, -62], [-39, -62], [-158, -63], [-66, -61], [43, -62], [120, -62]],
  },
];

function direction([lon, lat]) {
  const theta = lon * RAD;
  const phi = lat * RAD;
  const cosPhi = Math.cos(phi);
  return [Math.cos(theta) * cosPhi, Math.sin(theta) * cosPhi, Math.sin(phi)];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = value => Math.max(0, Math.min(1, value));
const smooth = value => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

function clearance(a, b) {
  return Math.max(
    Math.max(a.left - b.right, b.left - a.right),
    Math.max(a.top - b.bottom, b.top - a.bottom),
  );
}

function waterLine(isWater, x, y, line) {
  if (!isWater(x, y)) return false;

  // Sample outside the glyphs and along wider names to leave room at the coast.
  const left = x - line.halfWidth;
  const right = x + line.halfWidth;
  const top = y - line.ascent;
  const bottom = y + line.descent;
  if (!isWater(left, top) || !isWater(right, top) || !isWater(left, bottom) || !isWater(right, bottom)) {
    return false;
  }
  return !line.wide || (isWater(x - line.halfWidth * .5, y) && isWater(x + line.halfWidth * .5, y));
}

function measureLabel(label, size) {
  const rows = label.rows.map((node, index) => {
    const width = node.getBoundingClientRect().width;
    return {
      dy: (index ? 1 : -1) * size * .61,
      halfWidth: width / 2 + 2,
      ascent: size * .47 + 2,
      descent: size * .47 + 2,
      wide: width > size * 5,
    };
  });
  return {
    rows,
    halfWidth: Math.max(...rows.map(line => line.halfWidth)),
    above: Math.max(...rows.map(line => line.ascent - line.dy)),
    below: Math.max(...rows.map(line => line.descent + line.dy)),
  };
}

export function createOceanLabels(layer, isWater) {
  const labels = oceans.map(({ lines, anchors }) => {
    const node = document.createElement('span');
    node.className = 'ocean-label';
    const rows = lines.map(text => {
      const row = document.createElement('span');
      row.textContent = text;
      node.append(row);
      return row;
    });
    layer.append(node);
    return { node, rows, anchors: anchors.map(coords => ({ coords, direction: direction(coords) })) };
  });
  let cachedSize = null;
  let lastView = null;

  function clearMetrics() {
    cachedSize = null;
    lastView = null;
  }

  function draw({ camera, view, radius, width, mapTop, mapBottom, enabled }) {
    if (!enabled) {
      layer.style.visibility = 'hidden';
      lastView = null;
      return;
    }
    const { x, y, radius: naturalRadius } = view;
    const size = Math.min(15, Math.max(10, naturalRadius * .046));
    if (cachedSize !== size) {
      layer.style.fontSize = size + 'px';
      for (const label of labels) label.metrics = measureLabel(label, size);
      cachedSize = size;
    }
    const signature = [camera.lon, camera.lat, x, y, radius, width, mapTop, mapBottom];
    if (lastView && signature.every((value, index) => value === lastView[index])) return;
    lastView = signature;
    layer.style.visibility = 'visible';

    const front = direction([camera.lon, camera.lat]);
    const placements = [];
    for (const label of labels) {
      const { rows, halfWidth, above, below } = label.metrics;
      const place = (anchor, facing) => {
        if (facing <= MIN_FRONT) return false;
        const point = projectGlobePoint(camera, anchor.coords, view);
        if (!point) return false;
        const { x: px, y: py } = point;
        const left = px - halfWidth;
        const right = px + halfWidth;
        const top = py - above;
        const bottom = py + below;
        const rim = radius - Math.hypot(Math.max(Math.abs(left - x), Math.abs(right - x)),
          Math.max(Math.abs(top - y), Math.abs(bottom - y)));
        let edge = Math.min(rim - 2, left - SIDE_GUTTER, width - right - SIDE_GUTTER,
          top - mapTop, mapBottom - bottom);
        if (edge <= 0) return false;

        const rect = { left, right, top, bottom };
        for (const previous of placements) edge = Math.min(edge, clearance(rect, previous) - LABEL_GAP);
        if (edge <= 0 || !rows.every(line => waterLine(isWater, px, py + line.dy, line))) return false;

        const opacity = .91 * smooth(edge / EDGE_FADE) * smooth((facing - MIN_FRONT) / .23);
        label.node.style.opacity = opacity;
        label.node.style.transform = `translate(${px}px,${py}px) translate(-50%,-50%)`;
        placements.push(rect);
        label.preferred = anchor;
        return true;
      };

      if (label.preferred && place(label.preferred, dot(front, label.preferred.direction))) continue;

      // An established anchor stays active while its label still fits over water.
      const alternatives = label.anchors
        .filter(anchor => anchor !== label.preferred)
        .map(anchor => ({ anchor, facing: dot(front, anchor.direction) }))
        .filter(({ facing }) => facing > MIN_FRONT)
        .sort((a, b) => b.facing - a.facing);
      if (!alternatives.some(({ anchor, facing }) => place(anchor, facing))) label.node.style.opacity = 0;
    }
  }

  return { draw, clearMetrics };
}
