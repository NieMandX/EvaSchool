// Pixel wheel events carry the platform's momentum. A pinch is delivered as
// Ctrl+wheel in Chromium/Firefox or as a cumulative GestureEvent in WebKit.
export function mountTrackpad(input, { pointFor, accepts, directTouch, rotate, zoom, begin, end }) {
  let mouseMode = false;
  let nativePinch = null;
  let deadline = 0;
  let timer = null;
  function idle() {
    const remaining = deadline - performance.now();
    if (remaining > 0) timer = setTimeout(idle, remaining);
    else {
      timer = null;
      if (!nativePinch) end();
    }
  }
  function activity(point) {
    deadline = performance.now() + 120;
    if (timer === null) timer = setTimeout(idle, 120);
    begin(point);
  }
  function reset() {
    nativePinch = null;
    clearTimeout(timer);
    timer = null;
    end();
  }

  input.addEventListener('wheel', event => {
    if (directTouch()) return;
    const point = pointFor(event);
    if (!nativePinch && !accepts(point) && !(timer !== null && performance.now() < deadline)) return;
    event.preventDefault();
    // WebKit versions that supply both streams must apply each pinch only once.
    if (nativePinch) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? input.clientHeight : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    activity(point);
    if (event.ctrlKey) zoom(Math.exp(-dy / 100), point, true);
    else if (mouseMode) zoom(Math.exp(-Math.max(-180, Math.min(180, dy)) * .0023), point, false);
    else rotate(dx, dy);
  }, { passive: false });

  input.addEventListener('gesturestart', event => {
    const point = pointFor(event);
    if (directTouch() || !accepts(point)) return;
    event.preventDefault();
    nativePinch = { scale: 1, point };
    activity(point);
    zoom(1, point, true);
  }, { passive: false });
  function updatePinch(event) {
    if (!nativePinch) return;
    event.preventDefault();
    const scale = event.scale;
    if (!directTouch() && Number.isFinite(scale) && scale > 0 && scale !== nativePinch.scale) {
      zoom(scale / nativePinch.scale, nativePinch.point, true);
      nativePinch.scale = scale;
    }
  }
  window.addEventListener('gesturechange', updatePinch, { passive: false });
  window.addEventListener('gestureend', event => {
    if (!nativePinch) return;
    updatePinch(event);
    reset();
  }, { passive: false });
  window.addEventListener('blur', reset);
  input.ownerDocument?.addEventListener('visibilitychange', () => {
    if (input.ownerDocument.hidden) reset();
  });
  return mode => { mouseMode = mode === 'mouse'; };
}
