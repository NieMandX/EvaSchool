import { geoDistance, geoOrthographic, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import atlas from './assets/countries.json';
import { viewCap } from './map-geometry.js';
import { createCountryIndex, pickVisibleCountry, tileLineVertices } from './globe-geography.js';
import {
  anchorGlobe, globeCoordinates, globePoint, moveGlobe, projectGlobePoint,
  recordGlobeMotion, releaseGlobeMotion, wrapLongitude,
} from './globe-camera.js';
import { createGlobeRenderer } from './globe-renderer.js';
import { createGlobeTiles } from './globe-tiles.js';
import { createOceanLabels } from './ocean-labels.js';
import { mountTrackpad } from './trackpad.js';
import { createWaterLookup } from './ocean-water.js';
import { oceanWaterGrid } from 'globe-mesh';

const MIN_ZOOM = 0.85;
const MAX_ZOOM = 4.5;
const MAX_PIXELS = 2_100_000;
const DEG = 180 / Math.PI;
const countries = feature(atlas, atlas.objects.countries).features;
const byId = new Map();
for (const country of countries) {
  const group = byId.get(country.id);
  if (group) group.features.push(country);
  else byId.set(country.id, { type: 'FeatureCollection', id: country.id, features: [country] });
}
const countryAtCoordinates = createCountryIndex(countries);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const easeOut = fraction => 1 - (1 - fraction) ** 3;
const smoothStep = fraction => fraction * fraction * (3 - 2 * fraction);
const BORDER_TOLERANCE = 1.8;
const BORDER_SETTLE = 65;
const PINCH_MIN_SPAN = 12;

const paperLight = [253 / 255, 252 / 255, 248 / 255];
const paperDark = [249 / 255, 248 / 255, 243 / 255];
const accents = {
  still: [219 / 255, 233 / 255, 231 / 255],
  wrong: [228 / 255, 200 / 255, 188 / 255],
  reveal: [236 / 255, 215 / 255, 170 / 255],
};
const color = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
const blend = (start, end, t) => start.map((channel, index) => channel + (end[index] - channel) * t);
const homePose = ({ homeLon, homeLat, homeZoom }) => ({ lon: homeLon, lat: homeLat, zoom: homeZoom });

export function createGlobe({
  stage, canvas, overlay, input, labelLayer, onSelect, settings: initialSettings, tileSource,
  onRenderFrame, onRendererChange, rendererPreference, initialQuality,
}) {
  const maxZoom = clamp(tileSource?.maxCameraZoom ?? MAX_ZOOM, MAX_ZOOM, 2 ** 20);
  const accentProjection = geoOrthographic().clipAngle(90).scale(1).translate([0, 0]).precision(.0003);
  const accentBounds = geoPath(accentProjection);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let settings = { ...initialSettings };
  let quality = initialQuality === 'lite' ? 'lite' : 'standard';
  let correctColors = [color(settings.correctLight), color(settings.correctDark)];
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
  let layoutTop = 0;
  let frame = 0;
  let cameraDirty = true;
  let overlayDirty = true;
  let zoomTarget = camera.zoom;
  let zoomAnchor = null;
  let lastFrame = null;
  let motion = null;
  let pointer = null;
  let pointerMoved = false;
  let trackpadActive = false;
  let gesture = null;
  let pinchDirty = false;
  let hover = null;
  let pendingHover = null;
  let pressDepth = 0;
  const hoverLifts = new Map();
  let highlight = null;
  let acceptsGuess = true;
  let keyboard = false;
  let accentPaths = new WeakMap();
  let lastTick = -Infinity;
  let lastHit = null;
  let drawnAccents = [];
  let frameObserver = null;
  let bufferWidth = 0;
  let bufferHeight = 0;
  let detailVertices = null;
  const tiles = tileSource && createGlobeTiles({
    ...tileSource,
    onChange(entries) {
      detailVertices = tileLineVertices(entries);
      renderer.active?.driver.setDetail(detailVertices);
      overlayDirty = true;
      schedule();
    },
  });

  const isWater = createWaterLookup(oceanWaterGrid, countryAtCoordinates);
  const oceanLabels = createOceanLabels(labelLayer, (px, py) => {
    const coordinates = globeCoordinates(camera, { x: px, y: py }, view);
    return coordinates && isWater(coordinates);
  });

  stage.dataset.renderer = 'loading';
  onRendererChange?.('loading');
  const renderer = createGlobeRenderer(canvas, name => {
    stage.dataset.renderer = name;
    onRendererChange?.(name);
    const active = renderer.active;
    if (active && bufferWidth && bufferHeight) {
      if (active.driver.resize(bufferWidth, bufferHeight, ratio) === false) {
        active.fail();
        return;
      }
      if (detailVertices) active.driver.setDetail(detailVertices);
    }
    cameraDirty = overlayDirty = true;
    schedule();
  });

  function findCountry(point) {
    // A stationary pointer must not start a new enter/leave cycle just because
    // its own hover animation moved a small island away from the original spot.
    if (lastHit?.x === point.x && lastHit.y === point.y) return lastHit.country;
    const country = countryAt(point);
    lastHit = { x: point.x, y: point.y, country };
    return country;
  }

  function countryAt(point) {
    if (point.y < mapTop - 9 || point.y > mapBottom) return null;
    return pickVisibleCountry(point, view, drawnAccents, surfaceCountryAt);
  }

  function surfaceCountryAt(point) {
    const coordinates = globeCoordinates(camera, point, view);
    const hit = coordinates && countryAtCoordinates(coordinates);
    return hit ? byId.get(hit.id) : null;
  }

  function liftLevel(lift, time) {
    if (reducedMotion.matches || !settings.hoverDuration) return lift.to;
    const fraction = clamp((time - lift.start) / settings.hoverDuration, 0, 1);
    return lift.from + (lift.to - lift.from) * smoothStep(fraction);
  }

  function countrySilhouette(country) {
    const group = byId.get(country.id);
    let bounds = accentPaths.get(group);
    if (!bounds) {
      const [[left, top], [right, bottom]] = accentBounds.bounds(group);
      if (!Number.isFinite(right)) return null;
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;
      const normalLength = Math.max(1, Math.hypot(centerX, centerY));
      bounds = {
        centerX, centerY, normalX: centerX / normalLength, normalY: centerY / normalLength,
        span: Math.max(right - left, bottom - top),
      };
      accentPaths.set(group, bounds);
    }
    return bounds;
  }

  function globeAccent(country, type, level, elevation = level, tint = 0) {
    if (level <= 0) return null;
    const silhouette = countrySilhouette(country);
    if (!silhouette) return null;
    const { centerX, centerY, normalX, normalY, span } = silhouette;
    const still = reducedMotion.matches;
    const lift = still ? 0 : clamp(2.2 + Math.sqrt(span * radius) * .17, 2.8, 5)
      * elevation * settings.hoverLift / 100;
    const growth = lift / radius * settings.hoverGrowth / 100;
    const flatColor = accents[type] ?? (still && type === 'hover' ? accents.still : null);
    return {
      id: String(country.id),
      offsetX: lift * normalX - centerX * radius * growth,
      offsetY: lift * normalY - centerY * radius * growth,
      scale: 1 + growth,
      opacity: level,
      cutOpacity: still ? 0 : smoothStep(Math.min(1, level / .68)),
      light: flatColor ?? (tint ? blend(paperLight, correctColors[0], tint) : paperLight),
      dark: flatColor ?? (tint ? blend(paperDark, correctColors[1], tint) : paperDark),
    };
  }

  function correctElevation(fraction, start) {
    if (fraction === 1) return 1;
    const angle = fraction * 3 * Math.PI;
    const bounce = settings.correctBounce / 100;
    const settle = (start - 1) * Math.exp(-6 * fraction);
    return 1 + settle * (1 + bounce * (Math.cos(angle) - 1))
      + bounce * .48 * Math.exp(-5 * fraction) * Math.sin(angle);
  }

  function tick(time, duration) {
    if (time - lastTick < 95 || document.hidden || navigator.userActivation?.hasBeenActive === false) return;
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(duration);
      lastTick = time;
    }
  }

  function nearBorder(country, point) {
    const { x, y } = point;
    const r = BORDER_TOLERANCE;
    return countryAt({ x: x - r, y })?.id === country.id || countryAt({ x: x + r, y })?.id === country.id
      || countryAt({ x, y: y - r })?.id === country.id || countryAt({ x, y: y + r })?.id === country.id;
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
    if (!point || !acceptsGuess) lastHit = null;
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
    updateHover(time, moving || gesture?.dragged || trackpadActive);
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
      const accents = [];
      const add = accent => { if (accent) accents.push(accent); };
      if (highlight) {
        const elevation = correct
          ? correctElevation(progress, highlight.fromElevation)
          : liftLevel({ ...highlight, from: highlight.fromElevation }, time);
        const tint = correct ? smoothStep(Math.min(1, progress / .78)) : 0;
        add(globeAccent(highlight.country, highlight.type, selected, elevation, tint));
      }
      for (const [country, lift] of hoverLifts) {
        if (country !== hover && country.id !== highlight?.id) add(globeAccent(country, 'hover', lift.level));
      }
      if (hover && hover.id !== highlight?.id) {
        const lift = hoverLifts.get(hover);
        lift.lastElevation = lift.level * (1 - pressDepth);
        add(globeAccent(hover, 'hover', lift.level, lift.lastElevation));
      }
      const active = renderer.active;
      if (active) {
        const drawn = active.driver.draw({ lon: camera.lon, lat: camera.lat, x, y, radius, settings, quality, accents });
        if (drawn === false) active.fail();
        else {
          drawnAccents = accents;
          onRenderFrame?.(time);
        }
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
      radius = naturalRadius * camera.zoom;
      lastHit = null;
      drawnAccents = [];
      accentPaths = new WeakMap();
      accentProjection.rotate([-camera.lon, -camera.lat, 0]);
      if (tiles) {
        tiles.update(viewCap(camera.lon, camera.lat, radius, x, y - mapTop, width, mapBottom - mapTop), radius);
      }
      oceanLabels.draw({ camera, view, radius, width, mapTop, mapBottom, enabled: Boolean(renderer.active) });
      cameraDirty = false;
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

  function drawCameraFrame(pose, time) {
    if (frame) cancelAnimationFrame(frame);
    Object.assign(camera, pose, { offsetX: 0, offsetY: 0 });
    stopMotion();
    cameraDirty = true;
    render(time);
  }

  function markCamera() {
    cameraDirty = true;
    schedule();
  }

  function updateSettings(next) {
    const changed = (...fields) => fields.some(field => next[field] !== settings[field]);
    const layoutChanged = changed('globeX', 'globeY', 'globeSize');
    const homeChanged = changed('homeLon', 'homeLat', 'homeZoom');

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
    correctColors = [color(settings.correctLight), color(settings.correctDark)];
    overlayDirty = true;
    schedule();
  }

  function updateLayout() {
    const mapHeight = mapBottom - mapTop;
    if (!width || !height || !mapHeight) return;
    const availableHeight = mapBottom - layoutTop;
    const fittedRadius = Math.max(1, Math.min(width * .457, (availableHeight - 32) / 2));
    naturalRadius = fittedRadius * settings.globeSize / 100;
    homeX = width / 2 + settings.globeX;
    const freeSpace = availableHeight - 2 * fittedRadius;
    homeY = (layoutTop + mapBottom) / 2 + Math.min(34, Math.max(0, (freeSpace - 26) * .19)) - 13 + settings.globeY;
    maxOffsetX = Math.min(width * .24, naturalRadius * 1.1);
    maxOffsetY = Math.min(mapHeight * .29, naturalRadius * .77);
    view.radius = naturalRadius;
    updateCenter();
    zoomAnchor = null;
    if (gesture?.pinch) beginPinch();
    stage.style.setProperty('--globe-x', homeX + 'px');
    stage.style.setProperty('--globe-y', homeY + 'px');
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
    // Center the default globe below the header while keeping the entire stage interactive.
    layoutTop = stage.parentElement.getBoundingClientRect().top - rect.top;
    bufferWidth = Math.round(width * ratio);
    bufferHeight = Math.round(height * ratio);
    const active = renderer.active;
    if (active && active.driver.resize(bufferWidth, bufferHeight, ratio) === false) active.fail();
    updateLayout();
  }

  function setQuality(next) {
    if (next === quality || (next !== 'lite' && next !== 'standard')) return;
    quality = next;
    overlayDirty = true;
    schedule();
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

  function zoomBy(factor, point = { x: homeX, y: homeY }, direct = false) {
    if (motion) stopMotion();
    if (!zoomAnchor || Boolean(zoomAnchor.direct) !== direct || pointDistance(point, zoomAnchor.point) > .5) {
      zoomAnchor = zoomPivot(point);
      if (direct) {
        zoomAnchor.direct = true;
        zoomAnchor.location = globePoint(camera, point, view);
        zoomAnchor.spherical = true;
      }
    }
    zoomTarget = clamp((direct ? camera.zoom : zoomTarget) * factor, MIN_ZOOM, maxZoom);
    if (direct || reducedMotion.matches || !settings.zoomResponse) {
      applyZoom(zoomTarget);
      markCamera();
    } else {
      schedule();
    }
  }

  function beginCameraMotion(destination, duration, ease = easeOut, pitchEase = null) {
    motion = {
      start: performance.now(), duration, ease, pitchEase, from: { ...camera }, to: destination,
      delta: wrapLongitude(destination.lon - camera.lon),
    };
    schedule();
  }

  function goTo(target, duration) {
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
    beginCameraMotion(destination, duration);
  }

  function coast(drag, time) {
    // A direct flick still brakes smoothly with Reduce Motion on, but travels less.
    const scale = reducedMotion.matches ? .7 : 1;
    const release = releaseGlobeMotion(drag.samples, camera, view, time,
      settings.inertiaDuration * scale, settings.inertiaDistance * scale);
    if (release) {
      beginCameraMotion({ ...camera, lon: release.lon, lat: release.lat },
        release.duration, release.ease, release.pitchEase);
    }
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
    if (time !== undefined) recordGlobeMotion(gesture.samples, camera, time);
    markCamera();
  }

  function select(hit) {
    if (!acceptsGuess || !renderer.active) return;
    if (hit) {
      tick(performance.now(), 10);
      onSelect(hit.id);
    }
  }

  const eventPoint = event => {
    const rect = overlay.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  function pointerTime(event) {
    const now = performance.now();
    return event.timeStamp > 0 && event.timeStamp <= now ? event.timeStamp : now;
  }

  input.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (pointers.has(event.pointerId)) finishPointer(event);
    if (pointers.size >= 2) return;
    const point = eventPoint(event);
    const pressedCountry = !pointers.size && acceptsGuess ? countryAt(point) : null;
    if (!pointers.size && (point.y < mapTop - 9 || point.y > mapBottom ||
      (pointDistance(point, { x, y }) > radius && !pressedCountry))) return;
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
        start: point, pressedCountry, dragged: false, pinched: false, pinch: null,
        threshold: event.pointerType === 'touch' ? 6 : 4,
        samples: [],
      };
      recordGlobeMotion(gesture.samples, camera, pointerTime(event));
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
      dragGlobe(point, previous, pointerTime(event));
    } else if (pointDistance(point, gesture.start) >= gesture.threshold) {
      gesture.dragged = true;
      overlay.setAttribute('data-dragging', '');
      dragGlobe(point, gesture.start, pointerTime(event));
    }
  }

  function finishPointer(event) {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    updatePinch();
    pointers.delete(event.pointerId);
    const time = pointerTime(event);
    const drag = gesture;
    if (pointers.size) {
      // A new one-finger movement can build its own velocity after a pinch.
      drag.pinch = null;
      drag.dragged = false;
      drag.start = pointers.values().next().value;
      drag.samples.length = 0;
      recordGlobeMotion(drag.samples, camera, time);
      overlay.removeAttribute('data-dragging');
      schedule();
      return;
    }
    const point = eventPoint(event);
    const released = event.type === 'pointerup';
    const overInput = released && input.contains(document.elementFromPoint(event.clientX, event.clientY));
    if (released && drag.dragged && pointDistance(point, previous) > .01) {
      // The up coordinate can jitter or include a tiny unsampled tail.
      // Apply it to the pose without replacing the velocity from move events.
      dragGlobe(point, previous);
    }
    gesture = null;
    overlay.removeAttribute('data-dragging');
    pointer = event.pointerType !== 'touch' && overInput ? point : null;
    if (released) {
      if (drag.dragged) coast(drag, time);
      // The press animation can lower the coastline beneath a stationary finger.
      // A completed tap belongs to the country visible at pointer-down.
      else if (!drag.pinched && overInput && pointDistance(point, drag.start) < drag.threshold) select(drag.pressedCountry);
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
  const setDesktopMode = mountTrackpad(input, {
    pointFor(event) {
      if (event.type === 'gesturestart' && !event.clientX && !event.clientY && pointer) return pointer;
      return eventPoint(event);
    },
    accepts: point => point.y >= mapTop - 9 && point.y <= mapBottom && pointDistance(point, { x, y }) <= radius,
    directTouch: () => Boolean(gesture),
    begin(point) {
      trackpadActive = true;
      keyboard = false;
      pointer = point;
    },
    end() {
      if (!trackpadActive) return;
      trackpadActive = false;
      if (zoomAnchor?.direct) zoomAnchor = null;
      schedule();
    },
    rotate(dx, dy) {
      stopMotion();
      const degreesPerPixel = DEG / (naturalRadius * camera.zoom);
      camera.lon = wrapLongitude(camera.lon + dx * degreesPerPixel);
      camera.lat = clamp(camera.lat - dy * degreesPerPixel, -89, 89);
      markCamera();
    },
    zoom: zoomBy,
  });

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
      if (!event.repeat) select(countryAt({ x: homeX, y: homeY }));
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

  renderer.select(new URLSearchParams(location.search).get('renderer') ?? rendererPreference);

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
    drawCameraFrame,
    setQuality,
    setDesktopMode,
    projectPoint(coordinates) { return width && height ? projectGlobePoint(camera, coordinates, view) : null; },
    coordinatesAt(point) { return width && height ? globeCoordinates(camera, point, view) : null; },
    updateSettings,
    observeFrames(observer) { frameObserver = observer; },
    describeRendering() {
      return {
        renderer: stage.dataset.renderer, rendererPending: renderer.pending, preference: renderer.preference,
        width: bufferWidth, height: bufferHeight, quality,
      };
    },
    selectRenderer: renderer.select,
  };
}
