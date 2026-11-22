export const RENDERER_NAMES = { webgpu: 'WebGPU', webgl: 'WebGL', canvas: 'Canvas 2D' };

const INITIAL_SAMPLE_MS = 120;
const UPDATE_MS = 400;
const IDLE_MS = 500;
const EMPTY = '—';

export function mountRenderStatus(backendLabel, fpsLabel) {
  let firstFrame = null;
  let lastFrame = null;
  let intervals = 0;
  let fps = EMPTY;
  let idleTimer = null;

  function showFps(value) {
    if (fps === value) return;
    fps = value;
    fpsLabel.textContent = value;
  }

  function reset() {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    firstFrame = lastFrame = null;
    intervals = 0;
    showFps(EMPTY);
  }

  function checkIdle() {
    const remaining = IDLE_MS - (performance.now() - lastFrame);
    if (remaining > 0) idleTimer = setTimeout(checkIdle, remaining);
    else reset();
  }

  document.addEventListener('visibilitychange', reset);

  return {
    setRenderer(renderer) {
      backendLabel.textContent = RENDERER_NAMES[renderer] ?? EMPTY;
      reset();
    },
    recordFrame(time) {
      if (document.hidden) return;
      if (lastFrame !== null && time <= lastFrame) return;
      if (lastFrame === null || time - lastFrame > IDLE_MS) {
        reset();
        firstFrame = time;
        idleTimer = setTimeout(checkIdle, IDLE_MS);
      } else {
        intervals++;
        const elapsed = time - firstFrame;
        if (elapsed >= (fps === EMPTY ? INITIAL_SAMPLE_MS : UPDATE_MS)) {
          showFps(String(Math.round(1000 * intervals / elapsed)));
          firstFrame = time;
          intervals = 0;
        }
      }
      lastFrame = time;
    },
  };
}
