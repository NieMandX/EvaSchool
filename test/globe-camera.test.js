import assert from 'node:assert/strict';
import test from 'node:test';
import { moveGlobe, recordGlobeMotion, releaseGlobeMotion, wrapLongitude } from '../src/globe-camera.js';

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
