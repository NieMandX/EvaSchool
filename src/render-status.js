export const RENDERER_NAMES = { webgpu: 'WebGPU', webgl: 'WebGL' };

const INITIAL_SAMPLE_MS = 120;
const UPDATE_MS = 400;
const IDLE_MS = 500;
const EMPTY = '—';
const PREFERENCE_KEY = 'kontur.renderer.v1';

export function mountRenderStatus(menu, selectRenderer) {
  const toggle = menu.querySelector('#render-toggle');
  const backendLabel = menu.querySelector('#render-backend');
  const fpsLabel = menu.querySelector('#render-fps');
  const fallback = menu.querySelector('#render-fallback');
  const choices = [...menu.querySelectorAll('input[name="globe-renderer"]')];
  let renderer = 'loading';
  let preference = 'auto';
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

  function updateFallback() {
    const message = renderer === 'unavailable' ? 'Графический режим недоступен.'
      : RENDERER_NAMES[preference] && RENDERER_NAMES[renderer] && preference !== renderer
      ? `Запрошен ${RENDERER_NAMES[preference]}. Сейчас работает ${RENDERER_NAMES[renderer]}.`
      : '';
    fallback.textContent = message;
    fallback.hidden = !message;
  }

  document.addEventListener('visibilitychange', reset);
  document.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('keydown', event => {
    if (!menu.open || event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    menu.open = false;
    toggle.focus();
  });
  for (const choice of choices) {
    choice.addEventListener('change', () => {
      try { localStorage.setItem(PREFERENCE_KEY, choice.value); } catch { /* The choice still applies. */ }
      selectRenderer(choice.value);
    });
  }

  return {
    savedPreference() {
      try { return localStorage.getItem(PREFERENCE_KEY); } catch { return null; }
    },
    setPreference(next) {
      preference = next;
      for (const choice of choices) choice.checked = choice.value === preference;
      updateFallback();
    },
    setRenderer(next) {
      renderer = next;
      backendLabel.textContent = RENDERER_NAMES[renderer] ?? (renderer === 'unavailable' ? 'Недоступен' : EMPTY);
      updateFallback();
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
