import assert from 'node:assert/strict';
import test from 'node:test';
import {
  globeCoordinates, moveGlobe, projectGlobePoint, recordGlobeMotion, releaseGlobeMotion, wrapLongitude,
} from '../src/globe-camera.js';

const view = { x: 400, y: 300, radius: 200 };

function drag(duration, steps = 12, zoom = 1) {
  const camera = { lon: 87, lat: 18, zoom };
  const samples = [];
  let previous = { x: view.x, y: view.y };
  recordGlobeMotion(samples, camera, 0);
  for (let index = 1; index <= steps; index++) {
    const point = { x: view.x + 80 * index / steps, y: view.y };
    moveGlobe(camera, previous, point, view);
    recordGlobeMotion(samples, camera, duration * index / steps);
    previous = point;
  }
  return { camera, release: (pause = 0, timeScale = 100, distanceScale = 100) =>
    releaseGlobeMotion(samples, camera, view, duration + pause, timeScale, distanceScale) };
}

const angle = ({ camera, release }) => Math.abs(wrapLongitude(release().lon - camera.lon));

test('at the same release pose, faster drags have clearly longer coasts', () => {
  const slow = drag(360);
  const fast = drag(90);
  assert.deepEqual(slow.camera, fast.camera);
  assert(angle(fast) > 3 * angle(slow));
  assert(fast.release().duration > slow.release().duration);
  assert(angle(drag(42)) > 1.5 * angle(fast));
});

test('release distance is stable across sampling rates and expressed at the active zoom', () => {
  assert(Math.abs(angle(drag(90, 6)) - angle(drag(90, 24))) < .3);
  assert(angle(drag(90, 12, 2)) < .6 * angle(drag(90)));
});

test('the service percentages scale time and distance independently, and a pause stops the coast', () => {
  const { camera, release } = drag(90);
  const normal = release();
  const shorter = release(0, 50, 100);
  const farther = release(0, 100, 180);
  assert.equal(shorter.duration, normal.duration / 2);
  assert.equal(shorter.lon, normal.lon);
  assert.equal(farther.duration, normal.duration);
  assert(Math.abs(wrapLongitude(farther.lon - camera.lon)) > Math.abs(wrapLongitude(normal.lon - camera.lon)));
  assert.equal(release(0, 0, 100), null);
  assert.equal(release(0, 100, 0), null);
  assert.equal(release(100), null);
});

test('crossing the antimeridian does not reverse the release', () => {
  const samples = [];
  const camera = { lon: 177, lat: 0, zoom: 1 };
  for (const [index, lon] of [177, 179, -179, -177].entries()) {
    camera.lon = lon;
    recordGlobeMotion(samples, camera, 12 * index);
  }
  const release = releaseGlobeMotion(samples, camera, view, 36, 100, 100);
  assert(release);
  assert(wrapLongitude(release.lon - camera.lon) > 0);
});

test('a fast release starts at drag speed, including after the last normal frame gap', () => {
  const samples = [];
  const camera = { lon: 120, lat: 25, zoom: 1 };
  for (const time of [0, 8, 20, 31]) {
    camera.lon = wrapLongitude(120 + 1.9 * time);
    camera.lat = 25 + .4 * time;
    recordGlobeMotion(samples, camera, time);
  }
  for (const [timeScale, distanceScale] of [[100, 100], [25, 200], [200, 25]]) {
    const { lon, lat, duration, ease } = releaseGlobeMotion(samples, camera, view, 48, timeScale, distanceScale);
    const dt = duration * 1e-5;
    const fraction = ease(dt / duration);
    assert(Math.abs(wrapLongitude(lon - camera.lon) * fraction / dt - 1.9) < .001);
    assert(Math.abs((lat - camera.lat) * fraction / dt - .4) < .001);
    assert(ease(0) === 0);
    assert.equal(ease(1), 1);
  }
});

test('a 30 Hz touch drag retains its release speed through one delayed input frame', () => {
  const camera = { lon: 87, lat: 18, zoom: 1 };
  const samples = [];
  for (const time of [0, 33, 66, 99]) {
    camera.lon = 87 - .25 * time;
    recordGlobeMotion(samples, camera, time);
  }
  const immediate = releaseGlobeMotion(samples, camera, view, 99, 100, 100);
  for (const delay of [23, 33, 42]) {
    const delayed = releaseGlobeMotion(samples, camera, view, 99 + delay, 100, 100);
    assert.equal(delayed.lon, immediate.lon);
    assert.equal(delayed.duration, immediate.duration);
  }
  assert.equal(releaseGlobeMotion(samples, camera, view, 200, 100, 100), null);
});

test('a flick toward a pole eases to the latitude limit while longitude keeps coasting', () => {
  const camera = { lon: 16, lat: 88, zoom: 1 };
  const samples = [{ lon: 10, lat: 80, time: 0 }, { ...camera, time: 16 }];
  const { lat, duration, ease, pitchEase } = releaseGlobeMotion(samples, camera, view, 16, 100, 100);
  assert.equal(lat, 89);
  assert(Math.abs(pitchEase(1e-5) / (duration * 1e-5) - .5) < .001);
  assert(pitchEase(.2) > ease(.2));
  assert.equal(pitchEase(1), 1);
});

test('geographic placement and picking are inverse at the dateline, near the poles and at large scales', () => {
  for (const { camera, at } of [
    { camera: { lon: 178, lat: 6, zoom: 1 }, at: [-177, 4.2] },
    { camera: { lon: -65, lat: 88, zoom: 2.5 }, at: [25, 89.9] },
    { camera: { lon: -122.4, lat: 37.7, zoom: 2 ** 18 }, at: [-122.4003, 37.7002] },
  ]) {
    const screen = projectGlobePoint(camera, at, view);
    const [lon, lat] = globeCoordinates(camera, screen, view);
    assert(Math.abs(wrapLongitude(at[0] - lon)) < 1e-8);
    assert(Math.abs(at[1] - lat) < 1e-8);
    assert.equal(projectGlobePoint(camera, [camera.lon + 180, -camera.lat], view), null);
  }
});
