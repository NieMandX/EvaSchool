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

function measureLabel(ctx, lines, size) {
  const offsets = [-size * .61, size * .61];
  const rows = lines.map((text, i) => {
    const metric = ctx.measureText(text);
    return {
      text,
      dy: offsets[i],
      halfWidth: Math.max(metric.width / 2, metric.actualBoundingBoxLeft || 0, metric.actualBoundingBoxRight || 0) + 2,
      ascent: (metric.actualBoundingBoxAscent ?? size * .45) + 2,
      descent: (metric.actualBoundingBoxDescent ?? size * .45) + 2,
      wide: metric.width > size * 5,
    };
  });
  return {
    rows,
    halfWidth: Math.max(...rows.map(line => line.halfWidth)),
    above: Math.max(...rows.map(line => line.ascent - line.dy)),
    below: Math.max(...rows.map(line => line.descent + line.dy)),
  };
}

/** Places one projected label per ocean. isWater receives unscaled canvas CSS pixels. */
export function createOceanLabels(isWater) {
  const labels = oceans.map(({ lines, anchors }) => ({
    lines,
    anchors: anchors.map(coords => ({ coords, direction: direction(coords) })),
    preferred: null,
    metrics: null,
  }));
  let cachedSize = null;
  let lastView = null;
  let placements = [];

  function clearMetrics() {
    cachedSize = null;
    lastView = null;
  }

  function draw(ctx, view) {
    const { projection, center, x, y, radius, naturalRadius, width, mapTop, mapBottom } = view;
    const size = Math.min(15, Math.max(10, naturalRadius * .046));
    ctx.save();
    ctx.font = `750 ${size}px Manrope, system-ui, sans-serif`;
    ctx.fillStyle = '#23434f';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (cachedSize !== size) {
      for (const label of labels) label.metrics = measureLabel(ctx, label.lines, size);
      cachedSize = size;
      lastView = null;
    }

    // The same pose can render twice during resize or settling. Hover does not
    // invalidate these placements, since lifted countries do not move the coast.
    const signature = [projection, center[0], center[1], projection.rotate?.()[2], x, y, radius, width, mapTop, mapBottom];
    if (!lastView || signature.some((value, index) => value !== lastView[index])) {
      lastView = signature;
      const front = direction(center);
      placements = [];

      for (const label of labels) {
        const { rows, halfWidth, above, below } = label.metrics;
        const place = (anchor, facing) => {
          if (facing <= MIN_FRONT) return false;
          const [px, py] = projection(anchor.coords);
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
          for (const previous of placements) {
            edge = Math.min(edge, clearance(rect, previous.rect) - LABEL_GAP);
          }
          if (edge <= 0 || !rows.every(line => waterLine(isWater, px, py + line.dy, line))) return false;

          const opacity = .91 * smooth(edge / EDGE_FADE) * smooth((facing - MIN_FRONT) / .23);
          placements.push({ x: px, y: py, rows, rect, opacity });
          label.preferred = anchor;
          return true;
        };

        if (label.preferred && place(label.preferred, dot(front, label.preferred.direction))) continue;

        // Fallbacks are only considered when the established anchor no longer
        // fits. This keeps readable labels from switching sides while dragging.
        const alternatives = label.anchors
          .filter(anchor => anchor !== label.preferred)
          .map(anchor => ({ anchor, facing: dot(front, anchor.direction) }))
          .filter(({ facing }) => facing > MIN_FRONT)
          .sort((a, b) => b.facing - a.facing);
        alternatives.some(({ anchor, facing }) => place(anchor, facing));
      }
    }

    for (const { x: px, y: py, rows, opacity } of placements) {
      ctx.globalAlpha = opacity;
      for (const line of rows) ctx.fillText(line.text, px, py + line.dy);
    }
    ctx.restore();
  }

  return { draw, clearMetrics };
}
