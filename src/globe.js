import { geoBounds, geoContains, geoDistance, geoGraticule, geoOrthographic, geoPath } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import atlas from './assets/countries.json';
import { mapParts, viewCap, visibleParts } from './map-geometry.js';
import {
  anchorGlobe, globeCoordinates, globePoint, moveGlobe, projectGlobePoint,
  recordGlobeMotion, releaseGlobeMotion, wrapLongitude,
} from './globe-camera.js';
import { boundPath, createGlobeProjector, prepareMapPart } from './globe-projection.js';
import { createGlobeRenderer } from './globe-renderer.js';
import { createGlobeTiles } from './globe-tiles.js';
import { createOceanLabels } from './ocean-labels.js';

const MIN_ZOOM = 0.85;
const MAX_ZOOM = 4.5;
const MAX_PIXELS = 2_100_000;
const DEG = 180 / Math.PI;
const countries = feature(atlas, atlas.objects.countries).features;
const byId = new Map();
for (const country of countries) {
  const group = byId.get(country.id);
  if (group) group.features.push(country);
  else byId.set(country.id, { type: 'FeatureCollection', features: [country] });
}
const hitRegions = countries.map(country => ({ country, bounds: geoBounds(country) }));

const continentFields = {
  eurasia: 'landEurasia',
  africa: 'landAfrica',
  'north-america': 'landNorthAmerica',
  'south-america': 'landSouthAmerica',
  oceania: 'landOceania',
  antarctica: 'landAntarctica',
};

const preparedParts = new WeakMap();
function prepareMapGeometry(geometry) {
  const result = mapParts(geometry);
  for (const { shape } of result.parts) preparedParts.set(shape, prepareMapPart(shape));
  return result;
}

const continents = Object.entries(continentFields).map(([id, field]) => ({
  field, geometry: prepareMapGeometry(feature(atlas, atlas.objects[id]).geometry),
}));
// Shared national borders only. Coastlines are defined by the land fill and its shadow.
const borders = prepareMapGeometry(mesh(atlas, atlas.objects.countries, (a, b) => a !== b && a.id !== b.id));
const grid = geoGraticule().step([15, 15]).stepMajor([90, 90]).precision(5)();
const preparedCountries = new WeakMap();

function countryPolygons(country) {
  const cached = preparedCountries.get(country);
  if (cached) return cached;
  const features = country.type === 'FeatureCollection' ? country.features : [country];
  const polygons = features.flatMap(({ geometry }) => geometry.type === 'MultiPolygon'
    ? geometry.coordinates.map(coordinates => ({ type: 'Polygon', coordinates }))
    : [geometry]);
  for (const shape of polygons) {
    if (!preparedParts.has(shape)) preparedParts.set(shape, prepareMapPart(shape));
  }
  preparedCountries.set(country, polygons);
  return polygons;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const easeOut = fraction => 1 - (1 - fraction) ** 3;
const smoothStep = fraction => fraction * fraction * (3 - 2 * fraction);
const BORDER_TOLERANCE = 1.8;
const BORDER_SETTLE = 65;
const PINCH_MIN_SPAN = 12;

const paperFace = [[253, 252, 248], [249, 248, 243]];
const faceColor = (paper, green, tint) =>
  `rgb(${paper.map((channel, i) => Math.round(channel + (green[i] - channel) * tint)).join(', ')})`;
const rgbChannels = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const withAlpha = (hex, alpha) => hex + Math.round(clamp(alpha, 0, 255)).toString(16).padStart(2, '0');
const homePose = ({ homeLon, homeLat, homeZoom }) => ({ lon: homeLon, lat: homeLat, zoom: homeZoom });

function paintColors(settings) {
  const shoreAlpha = Math.round(255 * settings.shoreOpacity / 100);
  return {
    correct: [rgbChannels(settings.correctLight), rgbChannels(settings.correctDark)],
    grid: withAlpha('#325c6d', 255 * settings.gridOpacity / 100),
    border: withAlpha(settings.borderColor, 255 * settings.borderOpacity / 100),
    shore: withAlpha(settings.shoreColor, shoreAlpha),
    acceleratedShore: [...rgbChannels(settings.shoreColor), shoreAlpha].map(channel => channel / 255),
    accentAmbient: withAlpha('#153645', 92 * settings.hoverShadow / 100),
    accentNear: withAlpha('#183740', 46 * settings.hoverShadow / 100),
  };
}

const accents = {
  hover: '#f9f8f3',
  wrong: '#e4c8bc',
  reveal: '#ecd7aa',
};

export function createGlobe({ stage, canvas, overlay, input, onSelect, settings: initialSettings, tileSource }) {
  const base = canvas.getContext('2d');
  const top = overlay.getContext('2d');
  const terrainCanvas = document.createElement('canvas');
  const terrain = terrainCanvas.getContext('2d');
  const projection = geoOrthographic().clipAngle(90);
  const maxZoom = clamp(tileSource?.maxCameraZoom ?? MAX_ZOOM, MAX_ZOOM, 2 ** 20);
  const contourProjection = geoOrthographic().clipAngle(90).translate([0, 0]).precision(.38 / MAX_ZOOM);
  const contourPath = geoPath(contourProjection);
  const detailPath = tileSource && geoPath(projection.precision(.35));
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let settings = { ...initialSettings };
  let colors = paintColors(settings);
  const camera = { ...homePose(settings), offsetX: 0, offsetY: 0 };
  const view = { x: 0, y: 0, radius: 1 };
  const pointers = new Map();
  let width = 0;
  let height = 0;
  let ratio = 1;
  let x = 0;
  let y = 0;
  let homeX = 0;
  let homeY = 0;
  let maxOffsetX = 0;
  let maxOffsetY = 0;
  let radius = 1;
  let naturalRadius = 1;
  let mapTop = 0;
  let mapBottom = 0;
  let frame = 0;
  let cameraDirty = true;
  let waterDirty = true;
  let terrainDirty = true;
  let overlayDirty = true;
  let zoomTarget = camera.zoom;
  let zoomAnchor = null;
  let lastFrame = null;
  let motion = null;
  let pointer = null;
  let pointerMoved = false;
  let gesture = null;
  let pinchDirty = false;
  let hover = null;
  let pendingHover = null;
  let pressDepth = 0;
  const hoverLifts = new Map();
  let highlight = null;
  let acceptsGuess = true;
  let keyboard = false;
  let projected = null;
  let accentPaths = new WeakMap();
  let lastTick = -Infinity;
  let lastHit = null;
  let paints;
  let shoreMask = null;
  let apertureMask = null;
  let shoreDirty = true;
  let frameObserver = null;
  let detail = null;
  const tiles = tileSource && createGlobeTiles({
    ...tileSource,
    onChange(entries) {
      if (detail?.entries === entries) return;
      terrainDirty = true;
      schedule();
    },
  });
  stage.dataset.renderer = 'canvas';
  const renderer = createGlobeRenderer(canvas, name => {
    stage.dataset.renderer = name;
    shoreMask = apertureMask = null;
    resizeShadow();
    terrainDirty = overlayDirty = true;
    schedule();
  });
  const oceanLabels = createOceanLabels((px, py) =>
    !terrain.isPointInPath(projected.land, (px - x) / camera.zoom, (py - y) / camera.zoom));

  function findCountry(point) {
    if (lastHit?.x === point.x && lastHit.y === point.y) return lastHit.country;
    const country = countryAt(point);
    lastHit = { x: point.x, y: point.y, country };
    return country;
  }

  function countryAt(point) {
    if (point.y < mapTop - 9 || point.y > mapBottom) return null;
    const coordinates = globeCoordinates(camera, point, view);
    if (!coordinates) return null;
    const [lon, lat] = coordinates;
    for (const { country, bounds: [[west, south], [east, north]] } of hitRegions) {
      if (lat < south || lat > north) continue;
      const inside = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
      if (inside && geoContains(country, coordinates)) return country;
    }
    return null;
  }

  function updateProjection() {
    radius = naturalRadius * camera.zoom;
    projection.rotate([-camera.lon, -camera.lat, 0]).scale(radius).translate([x, y]);
    lastHit = null;
  }

  function projectPath(shape) {
    const path = new Path2D();
    contourPath.context(path)(shape);
    return path;
  }

  function projectParts(shapes, projector, path = new Path2D()) {
    for (const shape of shapes) {
      if (!projector.append(path, preparedParts.get(shape))) contourPath.context(path)(shape);
    }
    return path;
  }

  function projectMap() {
    const { lon, lat, zoom } = camera;
    if (projected?.lon === lon && projected.lat === lat && zoom >= projected.minimumZoom) return;
    // Project at a fixed scale and reuse the same paths throughout a zoom.
    // The clip extent covers a little more than the currently visible view.
    const minimumZoom = Math.max(MIN_ZOOM, Math.floor(zoom) - .15);
    const coverage = viewCap(lon, lat, naturalRadius * minimumZoom, homeX + maxOffsetX, homeY + maxOffsetY,
      width + 2 * maxOffsetX, height + 2 * maxOffsetY);
    const clip = [
      [(-3 - homeX - maxOffsetX) / minimumZoom, (-3 - homeY - maxOffsetY) / minimumZoom],
      [(width + 3 - homeX + maxOffsetX) / minimumZoom, (height + 3 - homeY + maxOffsetY) / minimumZoom],
    ];
    const [[left, top], [right, bottom]] = clip;
    const discFits = left <= -naturalRadius && top <= -naturalRadius && right >= naturalRadius && bottom >= naturalRadius;
    contourProjection
      .rotate([-lon, -lat, 0])
      .scale(naturalRadius)
      .clipExtent(discFits ? null : clip);
    const projector = createGlobeProjector(lon, lat, naturalRadius);
    const land = new Path2D();
    const faces = continents.flatMap(({ field, geometry }) => {
      const visible = visibleParts(geometry, coverage);
      if (!visible.geometries.length) return [];
      const path = projectParts(visible.geometries, projector);
      land.addPath(path);
      return [{ field, path }];
    });
    const outlines = projectParts(visibleParts(borders, coverage).geometries, projector);
    projected = {
      lon, lat, minimumZoom, projector, land, waterMask: null,
      continents: faces,
      outlines,
      grid: projectPath(grid),
    };
    accentPaths = new WeakMap();
  }

  function updatePaints() {
    const sea = base.createRadialGradient(x - radius * .34, y - radius * .43, radius * .07, x, y, radius * 1.12);
    sea.addColorStop(0, settings.waterLight);
    sea.addColorStop(.63, settings.waterMid);
    sea.addColorStop(1, settings.waterDark);
    paints = { sea, radius, x, y };
  }

  function drawWater() {
    base.clearRect(0, 0, width, height);
    if (paints?.radius !== radius || paints.x !== x || paints.y !== y) updatePaints();

    // Keep the contact shadow independent of the fluctuating geographic paths.
    const shadowY = y + radius * .984;
    if (shadowY < height + 30) {
      base.save();
      base.translate(x + radius * .08, shadowY);
      base.scale(radius * .87, Math.max(10, radius * .09));
      const shadow = base.createRadialGradient(0, 0, 0, 0, 0, 1);
      shadow.addColorStop(0, '#29465442');
      shadow.addColorStop(1, '#29465400');
      base.fillStyle = shadow;
      base.fillRect(-1, -1, 2, 2);
      base.restore();
    }

    base.save();
    base.beginPath();
    base.arc(x, y, radius, 0, Math.PI * 2);
    base.fillStyle = paints.sea;
    base.fill();
    base.clip();

    base.save();
    base.translate(x, y);
    base.scale(camera.zoom, camera.zoom);
    base.lineJoin = 'round';
    base.lineCap = 'round';
    base.lineWidth = .64 / camera.zoom;
    if (settings.gridOpacity) {
      base.strokeStyle = colors.grid;
      base.setLineDash([3.4 / camera.zoom, 3.3 / camera.zoom]);
      base.stroke(projected.grid);
    }
    base.restore();
    terrain.save();
    terrain.resetTransform();
    oceanLabels.draw(base, {
      projection, center: [camera.lon, camera.lat],
      x, y, radius, naturalRadius, width, mapTop, mapBottom,
    });
    terrain.restore();
    base.restore();

    base.beginPath();
    base.arc(x, y, radius, 0, Math.PI * 2);
    base.lineWidth = .8;
    base.strokeStyle = '#42657174';
    base.stroke();
  }

  function drawTerrain() {
    terrain.clearRect(0, 0, width, height);
    terrain.save();
    terrain.beginPath();
    terrain.arc(x, y, radius, 0, Math.PI * 2);
    terrain.clip();
    terrain.translate(x, y);
    terrain.scale(camera.zoom, camera.zoom);

    // Embed relief in this layer on Canvas 2D so a lifted country can clear it.
    terrain.save();
    terrain.fillStyle = settings.landEurasia;
    if (!renderer.active && settings.shoreOpacity) {
      terrain.shadowColor = colors.shore;
      terrain.shadowBlur = settings.shoreBlur * ratio;
      terrain.shadowOffsetY = settings.shoreLift * ratio;
    }
    terrain.fill(projected.land);
    terrain.restore();

    for (const { field, path } of projected.continents) {
      terrain.fillStyle = settings[field];
      terrain.fill(path);
    }
    if (settings.borderWidth && settings.borderOpacity) {
      terrain.lineCap = 'round';
      terrain.lineJoin = 'round';
      terrain.lineWidth = settings.borderWidth / camera.zoom;
      terrain.strokeStyle = colors.border;
      terrain.stroke(projected.outlines);
    }
    terrain.restore();
    if (tiles) drawDetail();
  }

  function drawDetail() {
    const entries = tiles.visible();
    if (!entries.length) return;
    if (detail?.entries !== entries) {
      const path = new Path2D();
      detailPath.context(path);
      for (const { data } of entries) {
        if (data) detailPath(data);
      }
      detail = { entries, path };
    }
    terrain.save();
    terrain.lineCap = terrain.lineJoin = 'round';
    terrain.lineWidth = 1;
    terrain.strokeStyle = colors.border;
    terrain.stroke(detail.path);
    terrain.restore();
  }

  function makeShadowMask() {
    const surface = document.createElement('canvas');
    const scale = Math.min(.5, 750 / Math.max(width, height));
    surface.width = Math.max(1, Math.round(width * scale));
    surface.height = Math.max(1, Math.round(height * scale));
    const context = surface.getContext('2d');
    context.setTransform(surface.width / width, 0, 0, surface.height / height, 0, 0);
    return context;
  }

  function resizeShadow() {
    const active = renderer.active;
    if (!active || !width || !height) return;
    const scale = Math.min(ratio, 1);
    if (!active.driver.resize(Math.round(width * scale), Math.round(height * scale), scale)) {
      active.fail();
      return;
    }
    shoreMask = makeShadowMask();
    apertureMask = null;
    shoreDirty = true;
  }

  function drawAcceleratedShadow(active, cuts) {
    if (shoreDirty) {
      shoreMask.clearRect(0, 0, width, height);
      shoreMask.save();
      shoreMask.translate(x, y);
      shoreMask.scale(camera.zoom, camera.zoom);
      shoreMask.fill(projected.land);
      shoreMask.restore();
    }
    if (cuts.length) {
      apertureMask ??= makeShadowMask();
      apertureMask.clearRect(0, 0, width, height);
      applyTerrainCuts(apertureMask, cuts, true);
    }
    const rendered = active.driver.draw({
      landMask: shoreDirty ? shoreMask.canvas : null,
      cutMask: cuts.length ? apertureMask.canvas : null,
      x, y, radius,
      lift: settings.shoreLift,
      blur: settings.shoreBlur,
      color: colors.acceleratedShore,
    });
    shoreDirty = false;
    if (!rendered) {
      active.fail();
      drawTerrain();
    }
  }

  function liftLevel(lift, time) {
    if (reducedMotion.matches || !settings.hoverDuration) return lift.to;
    const fraction = clamp((time - lift.start) / settings.hoverDuration, 0, 1);
    return lift.from + (lift.to - lift.from) * smoothStep(fraction);
  }

  function countrySilhouette(country) {
    let silhouette = accentPaths.get(country);
    if (!silhouette) {
      const path = new Path2D();
      const bounded = boundPath(path);
      projectParts(countryPolygons(country), projected.projector, bounded);
      const { left, top: topEdge, right, bottom } = bounded.bounds;
      if (!Number.isFinite(right)) return;
      const centerX = (left + right) / 2;
      const centerY = (topEdge + bottom) / 2;
      // On an orthographic sphere these are the screen components of its unit normal.
      const normalLength = Math.max(naturalRadius, Math.hypot(centerX, centerY));
      silhouette = {
        path,
        centerX, centerY,
        normalX: centerX / normalLength,
        normalY: centerY / normalLength,
        topEdge,
        bottom,
        span: Math.max(right - left, bottom - topEdge),
      };
      accentPaths.set(country, silhouette);
    }
    return silhouette;
  }

  function drawAccent(country, type, level, elevation = level, tint = 0) {
    if (level <= 0) return;
    const silhouette = countrySilhouette(country);
    if (!silhouette) return;
    const { path, centerX, centerY, normalX, normalY, topEdge, bottom, span } = silhouette;
    const still = reducedMotion.matches;
    if (still) elevation = 0;
    const screenSpan = span * camera.zoom;
    const lift = clamp(2.2 + Math.sqrt(screenSpan) * .17, 2.8, 5) * elevation * settings.hoverLift / 100;
    // At 100%, each vertex lies on a concentric sphere with the lifted radius.
    const growth = 1 + lift / radius * settings.hoverGrowth / 100;
    top.save();
    top.globalAlpha = level;
    top.translate(x + centerX * camera.zoom + lift * normalX, y + centerY * camera.zoom + lift * normalY);
    top.scale(camera.zoom * growth, camera.zoom * growth);
    top.translate(-centerX, -centerY);

    if (still && type === 'hover') {
      top.fillStyle = '#dbe9e7';
    } else if ((type === 'hover' || type === 'correct') && bottom > topEdge) {
      const face = top.createLinearGradient(0, topEdge, 0, bottom);
      face.addColorStop(0, faceColor(paperFace[0], colors.correct[0], tint));
      face.addColorStop(1, faceColor(paperFace[1], colors.correct[1], tint));
      top.fillStyle = face;
    } else {
      top.fillStyle = type === 'correct' ? settings.correctDark : accents[type];
    }

    if (!still && settings.hoverShadow) {
      // A wide ambient shadow lifts the silhouette. The closer shadow gives it depth.
      top.shadowColor = colors.accentAmbient;
      top.shadowBlur = clamp(6.5 + Math.sqrt(screenSpan) * .26, 8, 12) * ratio;
      top.shadowOffsetY = 1.25 * elevation * ratio;
      top.fill(path);
      top.shadowColor = colors.accentNear;
      top.shadowBlur = 3.6 * ratio;
      top.shadowOffsetY = 1.8 * elevation * ratio;
    }
    top.fill(path);
    top.restore();
  }

  function correctElevation(fraction, start) {
    if (fraction === 1) return 1;
    const angle = fraction * 3 * Math.PI;
    const bounce = settings.correctBounce / 100;
    const settle = (start - 1) * Math.exp(-6 * fraction);
    return 1 + settle * (1 + bounce * (Math.cos(angle) - 1))
      + bounce * .48 * Math.exp(-5 * fraction) * Math.sin(angle);
  }

  function terrainCuts(selected) {
    if (reducedMotion.matches) return [];
    const cuts = [];
    const collect = (country, level) => {
      if (level <= 0) return;
      const silhouette = countrySilhouette(country);
      if (silhouette) cuts.push({ path: silhouette.path, opacity: smoothStep(Math.min(1, level / .68)) });
    };
    if (highlight) collect(highlight.country, selected);
    for (const [country, lift] of hoverLifts) {
      if (country.id !== highlight?.id) collect(country, lift.level);
    }
    return cuts;
  }

  function applyTerrainCuts(context, cuts, includeShadow) {
    context.save();
    context.translate(x, y);
    context.scale(camera.zoom, camera.zoom);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.fillStyle = '#000';
    context.strokeStyle = '#000';

    // The wider cut clears the original coast shadow on the water side.
    if (includeShadow) {
      if (!projected.waterMask) {
        const edge = naturalRadius + 2;
        const waterMask = new Path2D();
        waterMask.rect(-edge, -edge, edge * 2, edge * 2);
        waterMask.addPath(projected.land);
        projected.waterMask = waterMask;
      }
      context.save();
      context.clip(projected.waterMask, 'evenodd');
      const shadowReach = settings.shoreLift + settings.shoreBlur * 1.25;
      context.lineWidth = 2 * Math.max(13, shadowReach) / camera.zoom;
      for (const { path, opacity } of cuts) {
        context.globalAlpha = opacity;
        context.stroke(path);
      }
      context.restore();
    }

    context.lineWidth = Math.max(1.5, 2 * settings.borderWidth) / camera.zoom;
    for (const { path, opacity } of cuts) {
      context.globalAlpha = opacity;
      context.fill(path);
      context.stroke(path);
    }
    context.restore();
  }

  function tick(time, duration) {
    if (time - lastTick < 95 || document.hidden || navigator.userActivation?.hasBeenActive === false) return;
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(duration);
      lastTick = time;
    }
  }

  function nearBorder(country, point) {
    const silhouette = countrySilhouette(country);
    if (!silhouette) return false;
    // Test the geographic outline at screen-pixel tolerance, without the visual lift.
    top.save();
    top.resetTransform();
    top.lineJoin = 'round';
    top.lineWidth = 2 * BORDER_TOLERANCE / camera.zoom;
    const near = top.isPointInStroke(silhouette.path, (point.x - x) / camera.zoom, (point.y - y) / camera.zoom);
    top.restore();
    return near;
  }

  function setLift(country, to, time) {
    const previous = hoverLifts.get(country);
    const from = previous ? liftLevel(previous, time) : 0;
    hoverLifts.set(country, { from, to, start: time });
  }

  function updateHover(time, suspended) {
    const moved = pointerMoved;
    pointerMoved = false;
    if (suspended) {
      pendingHover = null;
      if (!hoverLifts.size && !hover) return;
      hoverLifts.clear();
      hover = null;
      overlay.removeAttribute('data-country');
      overlayDirty = true;
      return;
    }

    const point = keyboard ? { x: homeX, y: homeY } : gesture?.start ?? pointer;
    const country = acceptsGuess && point ? findCountry(point) : null;
    if (country === hover) {
      pendingHover = null;
      return;
    }

    let giveFeedback = moved;
    if (point && hover && !gesture && !keyboard && acceptsGuess && nearBorder(hover, point)) {
      if (!pendingHover || pendingHover.country !== country) {
        pendingHover = { country, start: time, moved };
      }
      pendingHover.moved ||= moved;
      if (time - pendingHover.start < BORDER_SETTLE) return;
      giveFeedback = pendingHover.moved;
    }
    pendingHover = null;
    if (hover) setLift(hover, 0, time);
    if (country) setLift(country, 1, time);
    hover = country;
    overlay.toggleAttribute('data-country', Boolean(hover));
    if (country && giveFeedback && !gesture) tick(time, 6);
    overlayDirty = true;
  }

  function drawSelection(time, moving, elapsed) {
    updateHover(time, moving || gesture?.dragged);
    const depth = hover && gesture && !reducedMotion.matches ? .58 : 0;
    const difference = (pressDepth - depth) * Math.exp(-elapsed / 26);
    const nextDepth = !hover || reducedMotion.matches || Math.abs(difference) < .006
      ? depth
      : depth + difference;
    if (pressDepth !== nextDepth) overlayDirty = true;
    pressDepth = nextDepth;
    const correct = highlight?.type === 'correct';
    const progress = correct && !reducedMotion.matches && settings.correctDuration
      ? clamp((time - highlight.start) / settings.correctDuration, 0, 1)
      : 1;
    const selected = correct
      ? highlight.from + (1 - highlight.from) * easeOut(Math.min(1, progress / .32))
      : highlight ? liftLevel(highlight, time) : 1;
    const stillPressing = pressDepth !== depth;
    let animating = selected < 1 || progress < 1 || stillPressing;
    for (const [country, lift] of hoverLifts) {
      lift.level = liftLevel(lift, time);
      if (lift.to === 0 && lift.level <= .005) {
        hoverLifts.delete(country);
        overlayDirty = true;
      } else {
        animating ||= lift.level !== lift.to;
      }
    }
    if (overlayDirty || animating) {
      const cuts = terrainCuts(selected);
      if (renderer.active) drawAcceleratedShadow(renderer.active, cuts);
      top.clearRect(0, 0, width, height);
      top.save();
      top.resetTransform();
      top.drawImage(terrainCanvas, 0, 0);
      top.restore();
      if (cuts.length) {
        top.save();
        top.beginPath();
        top.arc(x, y, radius, 0, Math.PI * 2);
        top.clip();
        top.globalCompositeOperation = 'destination-out';
        applyTerrainCuts(top, cuts, !renderer.active);
        top.restore();
      }
      if (highlight) {
        const elevation = correct
          ? correctElevation(progress, highlight.fromElevation)
          : liftLevel({ ...highlight, from: highlight.fromElevation }, time);
        const tint = correct ? smoothStep(Math.min(1, progress / .78)) : 0;
        drawAccent(highlight.country, highlight.type, selected, elevation, tint);
      }
      for (const [country, lift] of hoverLifts) {
        if (country !== hover && country.id !== highlight?.id) drawAccent(country, 'hover', lift.level);
      }
      if (hover && hover.id !== highlight?.id) {
        const lift = hoverLifts.get(hover);
        lift.lastElevation = lift.level * (1 - pressDepth);
        drawAccent(hover, 'hover', lift.level, lift.lastElevation);
      }
      overlayDirty = animating;
    }
    return animating || Boolean(pendingHover);
  }

  function render(time) {
    frame = 0;
    if (!width || !height) return;
    const workStart = frameObserver ? performance.now() : 0;
    const elapsed = lastFrame === null ? 16 : clamp(time - lastFrame, 0, 50);
    lastFrame = time;
    updatePinch();
    if (motion) {
      const fraction = clamp((time - motion.start) / motion.duration, 0, 1);
      const ease = motion.ease(fraction);
      camera.lon = wrapLongitude(motion.from.lon + motion.delta * ease);
      const pitch = motion.pitchEase ? motion.pitchEase(fraction) : ease;
      camera.lat = motion.from.lat + (motion.to.lat - motion.from.lat) * pitch;
      camera.zoom = fraction === 1 ? zoomTarget : motion.from.zoom + (zoomTarget - motion.from.zoom) * ease;
      camera.offsetX = motion.from.offsetX + (motion.to.offsetX - motion.from.offsetX) * ease;
      camera.offsetY = motion.from.offsetY + (motion.to.offsetY - motion.from.offsetY) * ease;
      if (fraction === 1) motion = null;
      cameraDirty = true;
    } else if (camera.zoom !== zoomTarget) {
      const remaining = settings.zoomResponse
        ? (camera.zoom - zoomTarget) * Math.exp(-elapsed / settings.zoomResponse)
        : 0;
      applyZoom(Math.abs(remaining) * naturalRadius < .12 ? zoomTarget : zoomTarget + remaining);
      cameraDirty = true;
    }
    if (cameraDirty) {
      updateCenter();
      updateProjection();
      projectMap();
      if (tiles) {
        projection.clipExtent([[-3, mapTop - 3], [width + 3, mapBottom + 3]]);
        tiles.update(viewCap(camera.lon, camera.lat, radius, x, y - mapTop, width, mapBottom - mapTop), radius);
        detail = null;
      }
      shoreDirty = true;
      cameraDirty = false;
      overlayDirty = true;
      waterDirty = true;
      terrainDirty = true;
    }
    if (waterDirty) {
      drawWater();
      waterDirty = false;
    }
    if (terrainDirty) {
      drawTerrain();
      terrainDirty = false;
      overlayDirty = true;
    }
    const moving = Boolean(motion || camera.zoom !== zoomTarget);
    const accentMoving = drawSelection(time, moving, elapsed);
    if (moving || accentMoving) schedule();
    else lastFrame = null;
    if (frameObserver) frameObserver({ time, workMs: performance.now() - workStart });
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function markCamera() {
    cameraDirty = true;
    schedule();
  }

  function updateSettings(next) {
    const changed = (...fields) => fields.some(field => next[field] !== settings[field]);
    const layoutChanged = changed('globeX', 'globeY', 'globeSize');
    const homeChanged = changed('homeLon', 'homeLat', 'homeZoom');
    const waterChanged = changed('waterLight', 'waterMid', 'waterDark', 'gridOpacity');
    const landChanged = changed(...Object.values(continentFields), 'borderColor', 'borderWidth', 'borderOpacity');
    const shoreChanged = changed('shoreLift', 'shoreBlur', 'shoreOpacity', 'shoreColor');
    const accentChanged = changed('hoverLift', 'hoverGrowth', 'hoverDuration', 'hoverShadow',
      'correctDuration', 'correctBounce', 'correctLight', 'correctDark');

    if (changed('hoverDuration', 'correctDuration')) {
      const time = performance.now();
      const retime = (animation, previous, duration) => {
        if (previous === duration) return;
        const phase = previous ? clamp((time - animation.start) / previous, 0, 1) : 1;
        animation.start = time - phase * duration;
      };
      for (const lift of hoverLifts.values()) retime(lift, settings.hoverDuration, next.hoverDuration);
      if (highlight?.type === 'correct') retime(highlight, settings.correctDuration, next.correctDuration);
      else if (highlight) retime(highlight, settings.hoverDuration, next.hoverDuration);
    }

    settings = { ...next };
    if (layoutChanged) updateLayout();
    if (homeChanged) goTo(homePose(settings), 0);
    if (waterChanged || landChanged || shoreChanged || accentChanged) {
      colors = paintColors(settings);
      if (waterChanged) {
        paints = null;
        waterDirty = true;
      }
      if (landChanged || (shoreChanged && !renderer.active)) terrainDirty = true;
      if (shoreChanged || accentChanged) overlayDirty = true;
      schedule();
    }
  }

  function updateLayout() {
    const mapHeight = mapBottom - mapTop;
    if (!width || !height || !mapHeight) return;
    const fittedRadius = Math.max(1, Math.min(width * .457, (mapHeight - 22) / 2));
    naturalRadius = fittedRadius * settings.globeSize / 100;
    homeX = width / 2 + settings.globeX;
    const freeSpace = mapHeight - 2 * fittedRadius;
    homeY = (mapTop + mapBottom) / 2 + Math.min(34, Math.max(0, (freeSpace - 26) * .19)) - 13 + settings.globeY;
    maxOffsetX = Math.min(width * .24, naturalRadius * 1.1);
    maxOffsetY = Math.min(mapHeight * .29, naturalRadius * .77);
    view.radius = naturalRadius;
    updateCenter();
    zoomAnchor = null;
    if (gesture?.pinch) beginPinch();
    stage.style.setProperty('--globe-x', homeX + 'px');
    stage.style.setProperty('--globe-y', homeY + 'px');
    paints = null;
    projected = null;
    oceanLabels.clearMetrics();
    markCamera();
  }

  function resize() {
    const rect = overlay.getBoundingClientRect();
    const region = stage.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    if (!width || !height || !region.height) return;
    ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (width * height)));
    mapTop = region.top - rect.top;
    mapBottom = region.bottom - rect.top;
    for (const surface of [canvas, overlay, terrainCanvas]) {
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
    }
    for (const ctx of [base, top, terrain]) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    resizeShadow();
    stage.style.setProperty('--map-fade-top', Math.max(8, mapTop - 12) + 'px');
    stage.style.setProperty('--map-fade-start', (mapBottom - 10) + 'px');
    stage.style.setProperty('--map-fade-end', (mapBottom + 15) + 'px');
    stage.style.setProperty('--map-input-top', Math.max(0, mapTop - 9) + 'px');
    stage.style.setProperty('--map-input-height', (mapBottom - Math.max(0, mapTop - 9)) + 'px');
    updateLayout();
  }

  function stopMotion() {
    motion = null;
    zoomTarget = camera.zoom;
    zoomAnchor = null;
  }

  function updateCenter() {
    // Ease the sphere back to the layout center as the whole globe comes into view.
    const allowance = naturalRadius * Math.max(0, camera.zoom - 1) * .985;
    const horizontal = Math.min(maxOffsetX, allowance);
    const vertical = Math.min(maxOffsetY, allowance);
    camera.offsetX = clamp(camera.offsetX, -horizontal, horizontal);
    camera.offsetY = clamp(camera.offsetY, -vertical, vertical);
    x = homeX + camera.offsetX;
    y = homeY + camera.offsetY;
    view.x = x;
    view.y = y;
  }

  function zoomPivot(point) {
    return {
      point, localX: (point.x - x) / camera.zoom, localY: (point.y - y) / camera.zoom,
      location: maxZoom > MAX_ZOOM ? globePoint(camera, point, view) : null,
    };
  }

  function applyZoom(zoom, anchor = zoomAnchor, point = anchor?.point) {
    camera.zoom = zoom;
    if (anchor) {
      camera.offsetX = point.x - homeX - anchor.localX * zoom;
      camera.offsetY = point.y - homeY - anchor.localY * zoom;
    }
    updateCenter();
    if (anchor?.location && (zoom > MAX_ZOOM || anchor.spherical)) {
      anchor.spherical = anchorGlobe(camera, anchor.location, point, view);
      return anchor.spherical;
    }
    return false;
  }

  function zoomBy(factor, point = { x: homeX, y: homeY }) {
    if (motion) stopMotion();
    if (!zoomAnchor || pointDistance(point, zoomAnchor.point) > .5) zoomAnchor = zoomPivot(point);
    zoomTarget = clamp(zoomTarget * factor, MIN_ZOOM, maxZoom);
    if (reducedMotion.matches || !settings.zoomResponse) {
      applyZoom(zoomTarget);
      markCamera();
    } else {
      schedule();
    }
  }

  function goTo(target, duration, { ease = easeOut, start = performance.now(), pitchEase = null } = {}) {
    zoomAnchor = null;
    const destination = { offsetX: 0, offsetY: 0, ...target };
    zoomTarget = target.zoom;
    if (duration === undefined) {
      const angle = geoDistance([camera.lon, camera.lat], [target.lon, target.lat]) * DEG;
      const scale = Math.abs(Math.log(target.zoom / camera.zoom));
      duration = clamp(290 + 2.3 * angle + 80 * scale, 300, 720);
    }
    if (reducedMotion.matches || !duration) {
      motion = null;
      Object.assign(camera, destination);
      markCamera();
      return;
    }
    motion = {
      start: Math.min(start, performance.now()), duration, ease, pitchEase, from: { ...camera }, to: destination,
      delta: wrapLongitude(target.lon - camera.lon),
    };
    schedule();
  }

  function coast(drag, time) {
    if (reducedMotion.matches || drag.pinched) return;
    const release = releaseGlobeMotion(drag.samples, camera, view, time,
      settings.inertiaDuration, settings.inertiaDistance);
    if (release) goTo({ ...camera, lon: release.lon, lat: release.lat }, release.duration,
      { ease: release.ease, pitchEase: release.pitchEase, start: time });
  }

  function pinchFrame() {
    const [a, b] = pointers.values();
    return { point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, span: pointDistance(a, b) };
  }

  function beginPinch() {
    const { point, span } = pinchFrame();
    gesture.pinch = { point, span, zoom: camera.zoom, anchor: zoomPivot(point) };
    pinchDirty = false;
  }

  function updatePinch() {
    if (!pinchDirty) return;
    pinchDirty = false;
    const { point, span } = pinchFrame();
    const pinch = gesture.pinch;
    if (pinch.span < PINCH_MIN_SPAN) {
      if (span >= PINCH_MIN_SPAN) beginPinch();
      return;
    }
    const zoom = clamp(pinch.zoom * Math.max(PINCH_MIN_SPAN, span) / pinch.span, MIN_ZOOM, maxZoom);
    if (pointDistance(pinch.point, point) < .01 && Math.abs(zoom - camera.zoom) < 1e-6) return;
    const atSameScale = Math.abs(zoom - camera.zoom) < 1e-6;
    const oldX = x;
    const oldY = y;
    zoomTarget = zoom;
    const anchored = applyZoom(zoom, pinch.anchor, point);
    if (atSameScale && !anchored) {
      const residual = { x: point.x - (x - oldX), y: point.y - (y - oldY) };
      if (pointDistance(pinch.point, residual) > .01) {
        moveGlobe(camera, pinch.point, residual, view);
        pinch.anchor = zoomPivot(point);
      }
    }
    pinch.point = point;
    cameraDirty = true;
  }

  function dragGlobe(point, prior, time) {
    const beforeLon = camera.lon;
    const beforeLat = camera.lat;
    moveGlobe(camera, prior, point, view);
    if (beforeLon === camera.lon && beforeLat === camera.lat) return;
    if (!gesture.pinched) recordGlobeMotion(gesture.samples, camera, time);
    markCamera();
  }

  function select(point) {
    if (!acceptsGuess) return;
    updateProjection();
    const hit = findCountry(point);
    if (hit) {
      tick(performance.now(), 10);
      onSelect(hit.id);
    }
  }

  const eventPoint = event => {
    const rect = overlay.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  input.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (pointers.has(event.pointerId)) finishPointer(event);
    if (pointers.size >= 2) return;
    const point = eventPoint(event);
    if (!pointers.size && (point.y < mapTop - 9 || point.y > mapBottom || pointDistance(point, { x, y }) > radius)) return;
    if (event.pointerType !== 'touch') overlay.focus({ preventScroll: true });
    try {
      input.setPointerCapture(event.pointerId);
    } catch (error) {
      // Window-level handlers still track the gesture if the native pointer is unavailable.
      if (error.name !== 'NotFoundError') throw error;
    }
    stopMotion();
    keyboard = false;
    pointer = null;
    pointers.set(event.pointerId, point);
    if (pointers.size === 1) {
      gesture = {
        start: point, dragged: false, pinched: false, pinch: null,
        threshold: event.pointerType === 'touch' ? 6 : 4,
        samples: [],
      };
      recordGlobeMotion(gesture.samples, camera, event.timeStamp);
    } else {
      gesture.dragged = true;
      gesture.pinched = true;
      beginPinch();
      overlay.setAttribute('data-dragging', '');
    }
    overlayDirty = true;
    schedule();
  });

  input.addEventListener('pointermove', event => {
    if (gesture || event.pointerType === 'touch') return;
    keyboard = false;
    const point = eventPoint(event);
    pointerMoved ||= !pointer || pointDistance(point, pointer) >= .35;
    pointer = point;
    schedule();
  });

  function movePointer(event) {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) {
      finishPointer(event);
      return;
    }
    const point = eventPoint(event);
    pointers.set(event.pointerId, point);
    if (pointers.size === 2) {
      pinchDirty = true;
      schedule();
      return;
    }
    if (gesture.dragged) {
      dragGlobe(point, previous, event.timeStamp);
    } else if (pointDistance(point, gesture.start) >= gesture.threshold) {
      gesture.dragged = true;
      overlay.setAttribute('data-dragging', '');
      dragGlobe(point, gesture.start, event.timeStamp);
    }
  }

  function finishPointer(event) {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    updatePinch();
    pointers.delete(event.pointerId);
    if (pointers.size) {
      // The remaining finger continues from its actual position and cannot tap.
      gesture.pinch = null;
      schedule();
      return;
    }
    const point = eventPoint(event);
    const drag = gesture;
    const released = event.type === 'pointerup';
    const overInput = released && input.contains(document.elementFromPoint(event.clientX, event.clientY));
    if (released && drag.dragged && pointDistance(point, previous) > .01) {
      dragGlobe(point, previous, event.timeStamp);
    }
    gesture = null;
    overlay.removeAttribute('data-dragging');
    pointer = event.pointerType !== 'touch' && overInput ? point : null;
    if (released) {
      if (drag.dragged) coast(drag, event.timeStamp);
      else if (overInput && pointDistance(point, drag.start) < drag.threshold) select(point);
    }
    overlayDirty = true;
    schedule();
  }

  // Capture keeps native delivery reliable. Window listeners also continue tracking
  // known pointers when a browser drops capture while a button is still down.
  window.addEventListener('pointermove', movePointer, true);
  window.addEventListener('pointerup', finishPointer, true);
  window.addEventListener('pointercancel', finishPointer, true);
  window.addEventListener('blur', () => {
    pointers.clear();
    gesture = null;
    pinchDirty = false;
    pointer = null;
    pointerMoved = false;
    keyboard = false;
    overlay.removeAttribute('data-dragging');
    overlayDirty = true;
    schedule();
  });
  input.addEventListener('pointerleave', () => { pointer = null; pointerMoved = false; schedule(); });
  input.addEventListener('wheel', event => {
    const point = eventPoint(event);
    if (gesture || point.y < mapTop - 9 || point.y > mapBottom || pointDistance(point, { x, y }) > radius) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
    zoomBy(Math.exp(-clamp(delta, -180, 180) * .0023), point);
  }, { passive: false });

  overlay.addEventListener('blur', () => { keyboard = false; schedule(); });
  overlay.addEventListener('keydown', event => {
    const rotation = event.shiftKey ? 2.5 : 11;
    const rotations = { ArrowLeft: [-rotation, 0], ArrowRight: [rotation, 0], ArrowUp: [0, rotation], ArrowDown: [0, -rotation] };
    if (Object.hasOwn(rotations, event.key)) {
      stopMotion();
      const [lon, lat] = rotations[event.key];
      camera.lon = wrapLongitude(camera.lon + lon / camera.zoom);
      camera.lat = clamp(camera.lat + lat / camera.zoom, -89, 89);
      markCamera();
    } else if (event.key === '+' || event.key === '=') {
      zoomBy(1.22);
    } else if (event.key === '-') {
      zoomBy(1 / 1.22);
    } else if (event.key === 'Home') {
      goTo(homePose(settings), settings.resetDuration);
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (!event.repeat) select({ x: homeX, y: homeY });
    } else {
      return;
    }
    keyboard = true;
    event.preventDefault();
    schedule();
  });

  new ResizeObserver(resize).observe(stage);
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) stopMotion();
    overlayDirty = true;
    schedule();
  });
  document.fonts.ready.then(() => {
    oceanLabels.clearMetrics();
    markCamera();
  });
  resize();

  renderer.select(new URLSearchParams(location.search).get('renderer'));

  return {
    paint(id, type) {
      const country = byId.get(id);
      const start = performance.now();
      const currentLift = hover?.id === id ? hoverLifts.get(hover) : null;
      const from = currentLift?.level ?? 0;
      const fromElevation = currentLift?.lastElevation ?? from;
      highlight = country && type ? { id, country, type, from, fromElevation, to: 1, start } : null;
      overlayDirty = true;
      schedule();
    },
    setGuessEnabled(enabled) {
      acceptsGuess = enabled;
      pointer = null;
      schedule();
    },
    goTo,
    projectPoint(coordinates) { return width && height ? projectGlobePoint(camera, coordinates, view) : null; },
    coordinatesAt(point) { return width && height ? globeCoordinates(camera, point, view) : null; },
    updateSettings,
    observeFrames(observer) { frameObserver = observer; },
    describeRendering() {
      return { renderer: stage.dataset.renderer, preference: renderer.preference, width: canvas.width, height: canvas.height };
    },
    selectRenderer: renderer.select,
  };
}
