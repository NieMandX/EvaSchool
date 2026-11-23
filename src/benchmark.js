import { BENCHMARK_RUN_MS, BENCHMARK_WARMUP_MS, benchmarkPose, summarizeBenchmark } from './benchmark-metrics.js';
import { mountBenchmarkPanel, QUALITY_NAMES } from './benchmark-panel.js';
import { RENDERER_NAMES } from './render-status.js';

const RENDERER_RUNS = ['webgpu', 'webgl', 'webgl', 'webgpu'];
const QUALITY_RUNS = ['standard', 'lite', 'lite', 'standard'];
const RENDERER_WAIT_MS = 3500;
const PROGRESS_UPDATE_MS = 600;
const PHASE_MS = BENCHMARK_WARMUP_MS + BENCHMARK_RUN_MS;
const FPS_COMPARISON_TOLERANCE = .02;

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

function viewportMessage(results, width, height, renderer) {
  const [first, second] = results;
  const size = `Буфер глобуса ${width} × ${height} пикселей.`;
  const context = renderer ? `Рендерер ${RENDERER_NAMES[renderer]}. ${size}` : size;
  if (first.unavailable || second.unavailable) return context;
  if (first.slowShare === second.slowShare) {
    const tie = first.slowFrames === 0 ? 'Длинных кадров нет в обоих режимах.' : 'Доля длинных кадров одинакова.';
    if (!renderer) return `${tie} ${context}`;
    if (Math.abs(first.fps - second.fps) <= Math.max(first.fps, second.fps) * FPS_COMPARISON_TOLERANCE) {
      return `${tie} Средний FPS близок. ${context}`;
    }
    const faster = first.fps > second.fps ? first : second;
    return `${tie} Выше средний FPS в режиме «${QUALITY_NAMES[faster.mode]}». ${context}`;
  }
  const faster = first.slowShare < second.slowShare ? first : second;
  const name = renderer ? `режима «${QUALITY_NAMES[faster.mode]}»` : RENDERER_NAMES[faster.mode];
  return `Меньшая доля длинных кадров у ${name}. ${context}`;
}

function requireRenderer(actual, expected) {
  if (actual.rendererPending || actual.renderer !== expected) {
    throw new Error('Рендерер сменился во время замера. Запусти тест ещё раз.');
  }
}

export function mountBenchmark({ globe, selectRenderer, shell, resetCamera, compareQuality = false }) {
  let active = null;
  const runs = compareQuality ? QUALITY_RUNS : RENDERER_RUNS;
  const panel = mountBenchmarkPanel({ start, cancel: () => abort('Тест остановлен.'), compareQuality });
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
    const original = globe.describeRendering();
    let { width, height } = original;
    let renderer = null;
    const controller = new AbortController();
    const { signal } = controller;
    const passes = new Map([...new Set(runs)].map(mode => [mode, { intervals: [], unavailable: null }]));
    active = controller;
    shell.inert = true;
    shell.setAttribute('data-benchmark-running', '');
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('resize', viewportChanged);
    let outcome;

    try {
      if (compareQuality) {
        panel.render({ status: 'running' });
        const deadline = performance.now() + RENDERER_WAIT_MS;
        await runFrames(signal, time => {
          const actual = globe.describeRendering();
          if (!actual.rendererPending && RENDERER_NAMES[actual.renderer]) {
            ({ renderer, width, height } = actual);
            return true;
          }
          if (time >= deadline) throw new Error('Рендерер ещё запускается. Повтори замер через несколько секунд.');
          return false;
        });
      }

      for (const [index, mode] of runs.entries()) {
        const pass = passes.get(mode);
        if (pass.unavailable) continue;
        const phase = { status: 'running', mode, renderer, run: index + 1, total: runs.length };
        panel.render(phase);
        const current = globe.describeRendering();
        if (compareQuality) {
          requireRenderer(current, renderer);
          globe.setQuality(mode);
        } else {
          if (current.renderer !== mode || current.preference !== mode) selectRenderer(mode);
          const deadline = performance.now() + RENDERER_WAIT_MS;
          await runFrames(signal, time => {
            const ready = globe.describeRendering().renderer === mode;
            if (!ready && time >= deadline) pass.unavailable = 'Режим недоступен';
            return ready || Boolean(pass.unavailable);
          });
          if (pass.unavailable) continue;
        }

        let startTime;
        let previousSample;
        let lastProgress = -Infinity;
        await runFrames(signal, time => {
          const actual = globe.describeRendering();
          if (actual.width !== width || actual.height !== height) {
            throw new Error('Размер буфера изменился. Запусти тест ещё раз.');
          }
          if (compareQuality) {
            requireRenderer(actual, renderer);
            if (actual.quality !== mode) throw new Error('Режим качества изменился во время замера. Запусти тест ещё раз.');
          } else if (actual.renderer !== mode) {
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

      if (compareQuality) requireRenderer(globe.describeRendering(), renderer);
      const results = [...passes].map(([mode, { intervals, unavailable }]) => {
        const stats = summarizeBenchmark(intervals);
        return { mode, ...stats, unavailable: unavailable ?? (stats.samples ? null : 'Нет данных') };
      });
      outcome = { status: 'done', results, message: viewportMessage(results, width, height, renderer) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось завершить замер.';
      outcome = { status: 'idle', message };
    } finally {
      active = null;
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('resize', viewportChanged);
      shell.inert = false;
      shell.removeAttribute('data-benchmark-running');
      const current = globe.describeRendering();
      if (compareQuality) {
        if (current.quality !== original.quality) globe.setQuality(original.quality);
      } else if (current.preference !== original.preference) selectRenderer(original.preference);
      resetCamera();
      panel.render(outcome);
    }
  }
}
