const RAD = Math.PI / 180;
const DEG = 1 / RAD;
const LIMB = .985;
const RELEASE_WINDOW_MS = 60;
const RELEASE_IDLE_MS = 100;
const MIN_RELEASE_SPEED = .065;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrapRadians = value => Math.atan2(Math.sin(value), Math.cos(value));

export const wrapLongitude = value => ((value + 180) % 360 + 360) % 360 - 180;

export function globePoint(camera, point, view) {
  const radius = view.radius * camera.zoom;
  const east = (point.x - view.x) / radius;
  const up = (view.y - point.y) / radius;
  const square = east * east + up * up;
  if (square >= 1) return null;
  const front = Math.sqrt(1 - square);
  const tilt = camera.lat * RAD;
  const forward = front * Math.cos(tilt) - up * Math.sin(tilt);
  return {
    longitude: camera.lon * RAD + Math.atan2(east, forward),
    latitude: Math.asin(clamp(front * Math.sin(tilt) + up * Math.cos(tilt), -1, 1)),
  };
}

// Keep north up while placing a geographic point at the requested screen position.
// A longitude can have two solutions near the poles. Use the closest camera pose.
export function anchorGlobe(camera, anchor, point, view) {
  const radius = view.radius * camera.zoom;
  const east = (point.x - view.x) / radius;
  const up = (view.y - point.y) / radius;
  if (Math.hypot(east, up) > LIMB) return false;
  const parallel = Math.cos(anchor.latitude);
  if (Math.abs(east) > parallel || parallel < 1e-8) return false;
  const offset = Math.asin(clamp(east / parallel, -1, 1));
  const front = Math.sqrt(Math.max(0, 1 - east * east - up * up));
  const vertical = Math.atan2(up, front);
  const north = Math.sin(anchor.latitude);
  let nearest = null;
  let smallest = Infinity;
  for (const delta of [offset, Math.PI - offset]) {
    const lon = wrapLongitude((anchor.longitude - delta) * DEG);
    const lat = wrapRadians(Math.atan2(north, parallel * Math.cos(delta)) - vertical) * DEG;
    if (Math.abs(lat) > 89.000001) continue;
    const change = Math.hypot(wrapLongitude(lon - camera.lon), lat - camera.lat);
    if (change < smallest) {
      nearest = { lon, lat: clamp(lat, -89, 89) };
      smallest = change;
    }
  }
  // At a nearly singular pole, the alternate branch can be on the far side.
  if (!nearest || smallest > 70) return false;
  Object.assign(camera, nearest);
  return true;
}

export function moveGlobe(camera, from, to, view) {
  const radius = view.radius * camera.zoom;
  const sensitivity = DEG / radius;
  const slide = {
    lon: wrapLongitude(camera.lon - (to.x - from.x) * sensitivity),
    lat: clamp(camera.lat + (to.y - from.y) * sensitivity, -89, 89),
  };
  // Blend the exact surface grab into a bounded spin near the limb, where
  // the inverse projection amplifies small pointer movements.
  const reach = Math.max(Math.hypot(from.x - view.x, from.y - view.y), Math.hypot(to.x - view.x, to.y - view.y)) / radius;
  const grip = clamp((LIMB - reach) / .135, 0, 1);
  const anchor = grip > 0 && globePoint(camera, from, view);
  if (!anchor || !anchorGlobe(camera, anchor, to, view)) {
    Object.assign(camera, slide);
    return;
  }
  const blend = grip * grip * (3 - 2 * grip);
  camera.lon = wrapLongitude(slide.lon + wrapLongitude(camera.lon - slide.lon) * blend);
  camera.lat = slide.lat + (camera.lat - slide.lat) * blend;
}

export function recordGlobeMotion(samples, camera, time) {
  const previous = samples[samples.length - 1];
  // Keep longitude continuous through the antimeridian so it measures the drag, not the wrap.
  const lon = previous ? previous.lon + wrapLongitude(camera.lon - previous.lon) : camera.lon;
  if (previous && time <= previous.time) {
    previous.lon = lon;
    previous.lat = camera.lat;
    return;
  }
  samples.push({ lon, lat: camera.lat, time });
  const cutoff = time - RELEASE_WINDOW_MS;
  while (samples.length > 2 && samples[1].time <= cutoff) samples.shift();
}

export function releaseGlobeMotion(samples, camera, view, time, durationPercent, distancePercent) {
  if (samples.length < 2 || durationPercent <= 0 || distancePercent <= 0) return null;
  const first = samples[0];
  const next = samples[1];
  const last = samples[samples.length - 1];
  const age = Math.max(0, time - last.time);
  if (age >= RELEASE_IDLE_MS) return null;

  // Interpolate the leading sample to compare the same time window at different input rates.
  const start = Math.max(first.time, last.time - RELEASE_WINDOW_MS);
  const fraction = (start - first.time) / (next.time - first.time);
  const interval = last.time - start;
  if (interval < 4) return null;
  const attenuation = Math.exp(-age / 44) / interval;
  const vLon = (last.lon - first.lon - (next.lon - first.lon) * fraction) * attenuation;
  const vLat = (last.lat - first.lat - (next.lat - first.lat) * fraction) * attenuation;
  const parallel = Math.max(.22, Math.cos(camera.lat * RAD));
  const speed = Math.hypot(vLon * parallel, vLat) * view.radius * camera.zoom * RAD;
  if (speed < MIN_RELEASE_SPEED) return null;

  const duration = clamp(216 + 74 * Math.log1p(speed / .33), 220, 390);
  const freeTravel = speed * (duration / 3) * (distancePercent / 100);
  // Ease into the travel limit so stronger flicks keep their distinction from slower drags.
  const limit = view.radius * .88;
  const travel = -limit * Math.expm1(-freeTravel / limit) / speed;
  const lon = wrapLongitude(camera.lon + clamp(vLon * travel, -120, 120));
  const lat = clamp(camera.lat + vLat * travel, -89, 89);
  if (Math.hypot(wrapLongitude(lon - camera.lon), lat - camera.lat) < .02) return null;
  return { lon, lat, duration: duration * durationPercent / 100 };
}
