import assert from 'node:assert/strict';
import test from 'node:test';
import { BENCHMARK_RUN_MS, BENCHMARK_WARMUP_MS, SLOW_FRAME_MS, benchmarkPose, summarizeBenchmark } from '../src/benchmark-metrics.js';
import { wrapLongitude } from '../src/globe-camera.js';

test('steady 120 Hz and 60 Hz do not count as slow frames', () => {
  for (const hz of [120, 60]) {
    const interval = 1000 / hz;
    const count = hz * (BENCHMARK_RUN_MS / 1000);
    const result = summarizeBenchmark(new Array(count).fill(interval));
    assert.equal(result.samples, count);
    assert(Math.abs(result.fps - hz) < 1e-9);
    assert.equal(result.slowFrames, 0);
    assert.equal(result.slowShare, 0);
    assert.equal(result.p95, interval);
  }
});

test('only intervals strictly above the tolerance count as slow', () => {
  const faster = 1000 / 60;
  const slower = SLOW_FRAME_MS + .01;
  const result = summarizeBenchmark([faster, SLOW_FRAME_MS, slower]);
  assert.equal(SLOW_FRAME_MS, faster + 1);
  assert.equal(result.slowFrames, 1);
  assert.equal(result.slowShare, 1 / 3);
  assert.equal(result.p95, slower);
});

test('aggregation uses elapsed frame time for FPS and nearest rank for p95', () => {
  const steady = new Array(18).fill(10);
  const intervals = [80, ...steady, 40];
  const result = summarizeBenchmark(intervals);
  assert.deepEqual(result, { samples: 20, fps: 20000 / 300, slowFrames: 2, slowShare: .1, p95: 40 });
  assert.equal(summarizeBenchmark([...steady, 10, 80]).p95, 10);
  assert.equal(intervals[0], 80);
});

test('invalid intervals are excluded and an empty measurement reports zero samples', () => {
  const invalid = [NaN, Infinity, -Infinity, -8, 0, null, undefined, '16'];
  const empty = { samples: 0, fps: 0, slowFrames: 0, slowShare: 0, p95: 0 };
  assert.deepEqual(summarizeBenchmark(), empty);
  assert.deepEqual(summarizeBenchmark(42), empty);
  assert.deepEqual(summarizeBenchmark(invalid), empty);
  assert.deepEqual(summarizeBenchmark([12, ...invalid, 24]), summarizeBenchmark([12, 24]));
});

test('the complete pose path is periodic, continuous from warmup and covers both zoom extremes', () => {
  const half = benchmarkPose(BENCHMARK_RUN_MS / 2);
  assert.equal(benchmarkPose(0).zoom, 2.6);
  assert.equal(half.zoom, 2.6);
  assert.equal(benchmarkPose(BENCHMARK_RUN_MS / 4).zoom, 1);
  assert.equal(benchmarkPose(BENCHMARK_RUN_MS * .75).zoom, 1);
  assert.equal(Math.abs(wrapLongitude(half.lon - benchmarkPose(0).lon)), 180);
  assert.deepEqual(benchmarkPose(-BENCHMARK_WARMUP_MS), benchmarkPose(BENCHMARK_RUN_MS - BENCHMARK_WARMUP_MS));
  assert.deepEqual(benchmarkPose(BENCHMARK_RUN_MS), benchmarkPose(0));
  const preceding = benchmarkPose(-1);
  let previous = preceding;
  let rotation = 0;
  for (let elapsed = 0; elapsed < BENCHMARK_RUN_MS; elapsed++) {
    const pose = benchmarkPose(elapsed);
    const step = wrapLongitude(pose.lon - previous.lon);
    assert(step > 0 && step < .07);
    assert(Math.abs(pose.lat - previous.lat) < .04);
    assert(Math.abs(pose.zoom - previous.zoom) < .002);
    rotation += step;
    previous = pose;
  }
  assert(Math.abs(rotation - 360) < 1e-9);
});
