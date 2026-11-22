import { BENCHMARK_RUN_MS, BENCHMARK_WARMUP_MS, benchmarkPose, summarizeBenchmark } from './benchmark-metrics.js';
import { mountBenchmarkPanel } from './benchmark-panel.js';
import { RENDERER_NAMES } from './render-status.js';

const RUNS = ['webgpu', 'webgl', 'webgl', 'webgpu'];
const RENDERER_WAIT_MS = 3500;
const PROGRESS_UPDATE_MS = 600;
const PHASE_MS = BENCHMARK_WARMUP_MS + BENCHMARK_RUN_MS;

function runFrames(signal, step) {
  return new Promise((resolve, reject) => {
    let frame = 0;
    function finish(error) {
      cancelAnimationFrame(frame);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    }
    function abort() {
      finish(signal.reason ?? new Error('Тест остановлен.'));
    }
    function tick(time) {
      try {
        if (step(time)) finish();
        else frame = requestAnimationFrame(tick);
      } catch (error) {
        finish(error);
      }
    }
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    frame = requestAnimationFrame(tick);
  });
}

function viewportMessage(results, width, height) {
  const [gpu, gl] = results;
  const size = `Буфер глобуса ${width} × ${height} пикселей.`;
  if (gpu.unavailable || gl.unavailable) return size;
  if (gpu.slowFrames === 0 && gl.slowFrames === 0) return `Длинных кадров нет в обоих режимах. ${size}`;
  if (gpu.slowShare === gl.slowShare) return `Доля длинных кадров одинакова. ${size}`;
  const faster = gpu.slowShare < gl.slowShare ? gpu : gl;
  return `Меньшая доля длинных кадров у ${RENDERER_NAMES[faster.mode]}. ${size}`;
}

export function mountBenchmark({ globe, selectRenderer, shell, resetCamera }) {
  let active = null;
  const panel = mountBenchmarkPanel({ start, cancel: () => abort('Тест остановлен.') });
  shell.classList.add('benchmark-mode');

  function abort(message) {
    active?.abort(new Error(message));
  }

  function visibilityChanged() {
    if (document.hidden) abort('Тест остановлен. Оставь вкладку открытой до конца замера.');
  }

  function viewportChanged() {
    abort('Размер окна изменился. Запусти тест ещё раз.');
  }

  async function start() {
    if (active) return;
    const { preference, width, height } = globe.describeRendering();
    const controller = new AbortController();
    const { signal } = controller;
    const passes = new Map([...new Set(RUNS)].map(mode => [mode, { intervals: [], unavailable: null }]));
    active = controller;
    shell.inert = true;
    shell.setAttribute('data-benchmark-running', '');
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('resize', viewportChanged);
    let outcome;

    try {
      for (const [index, mode] of RUNS.entries()) {
        const pass = passes.get(mode);
        if (pass.unavailable) continue;
        const phase = { status: 'running', mode, run: index + 1, total: RUNS.length };
        panel.render(phase);
        const current = globe.describeRendering();
        if (current.renderer !== mode || current.preference !== mode) selectRenderer(mode);
        const deadline = performance.now() + RENDERER_WAIT_MS;
        await runFrames(signal, time => {
          const ready = globe.describeRendering().renderer === mode;
          if (!ready && time >= deadline) pass.unavailable = 'Режим недоступен';
          return ready || Boolean(pass.unavailable);
        });
        if (pass.unavailable) continue;

        let startTime;
        let previousSample;
        let lastProgress = -Infinity;
        await runFrames(signal, time => {
          const actual = globe.describeRendering();
          if (actual.width !== width || actual.height !== height) {
            throw new Error('Размер буфера изменился. Запусти тест ещё раз.');
          }
          if (actual.renderer !== mode) {
            pass.unavailable = 'Рендерер отключился во время прогона';
            return true;
          }

          startTime ??= time;
          const elapsed = time - startTime;
          if (elapsed >= BENCHMARK_WARMUP_MS) {
            if (previousSample !== undefined) pass.intervals.push(time - previousSample);
            previousSample = time;
          }
          globe.drawCameraFrame(benchmarkPose(Math.min(elapsed, PHASE_MS) - BENCHMARK_WARMUP_MS), time);
          if (time - lastProgress >= PROGRESS_UPDATE_MS) {
            lastProgress = time;
            panel.render({ ...phase, progress: elapsed / PHASE_MS });
          }
          return elapsed >= PHASE_MS;
        });
      }

      const results = [...passes].map(([mode, { intervals, unavailable }]) => {
        const stats = summarizeBenchmark(intervals);
        return { mode, ...stats, unavailable: unavailable ?? (stats.samples ? null : 'Нет данных') };
      });
      outcome = { status: 'done', results, message: viewportMessage(results, width, height) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось завершить замер.';
      outcome = { status: 'idle', message };
    } finally {
      active = null;
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('resize', viewportChanged);
      shell.inert = false;
      shell.removeAttribute('data-benchmark-running');
      if (globe.describeRendering().preference !== preference) selectRenderer(preference);
      resetCamera();
      panel.render(outcome);
    }
  }
}
