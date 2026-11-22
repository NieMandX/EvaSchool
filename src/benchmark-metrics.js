import { wrapLongitude } from './globe-camera.js';

export const BENCHMARK_WARMUP_MS = 1200;
export const BENCHMARK_RUN_MS = 6000;
export const SLOW_FRAME_MS = 1000 / 60 + 1;

// The warmup can use negative time so that sampling starts without changing the pose.
export function benchmarkPose(elapsedMs) {
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  const phase = ((elapsed % BENCHMARK_RUN_MS + BENCHMARK_RUN_MS) % BENCHMARK_RUN_MS) / BENCHMARK_RUN_MS;
  const angle = phase * 2 * Math.PI;
  const turn = Math.cos(angle);
  return {
    lon: wrapLongitude(87 + 360 * phase),
    lat: 26 - 8 * turn + 30 * Math.sin(angle),
    // Reach maximum zoom over Eurasia and North America to exercise detailed coastlines.
    zoom: 1 + 1.6 * turn ** 2,
  };
}

export function summarizeBenchmark(intervals) {
  const frames = [];
  const values = typeof intervals?.[Symbol.iterator] === 'function' ? intervals : [];
  let duration = 0;
  let slowFrames = 0;
  for (const interval of values) {
    if (!Number.isFinite(interval) || interval <= 0) continue;
    duration += interval;
    if (interval > SLOW_FRAME_MS) slowFrames++;
    frames.push(interval);
  }
  const samples = frames.length;
  if (!samples) return { samples: 0, fps: 0, slowFrames: 0, slowShare: 0, p95: 0 };
  frames.sort((a, b) => a - b);
  return {
    samples,
    fps: samples * 1000 / duration,
    slowFrames,
    slowShare: slowFrames / samples,
    p95: frames[Math.ceil(.95 * samples) - 1],
  };
}
