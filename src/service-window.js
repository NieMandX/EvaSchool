const openWindows = new Set();
const shortcuts = new Map();

function showFront(windowState) {
  openWindows.delete(windowState);
  openWindows.add(windowState);
  let layer = 16;
  for (const { panel } of openWindows) panel.style.zIndex = layer++;
}

function handleShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.repeat ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const { target } = event;
  const editable = target instanceof Element &&
    (target.closest('input, textarea, select') || target.isContentEditable);

  if (event.key === 'Escape') {
    const windows = [...openWindows];
    const focused = windows.find(({ panel }) => panel.contains(document.activeElement));
    const current = focused ?? (!editable ? windows.at(-1) : null);
    if (current) {
      event.preventDefault();
      current.setOpen(false);
    }
    return;
  }

  const shortcut = shortcuts.get(event.code) ?? shortcuts.get(event.key?.toLowerCase());
  if (shortcut && !editable) {
    event.preventDefault();
    shortcut.setOpen(shortcut.panel.hidden);
  }
}

export function mountServiceWindow({ panel, header, close, key, onOpenChange }) {
  let panelPosition = null;
  let panelDrag = null;
  let previousFocus = null;
  const state = { panel, setOpen };

  function placePanel(left, top) {
    const margin = 8;
    const { clientWidth, clientHeight } = document.documentElement;
    left = Math.max(margin, Math.min(left, clientWidth - panel.offsetWidth - margin));
    top = Math.max(margin, Math.min(top, clientHeight - panel.offsetHeight - margin));
    if (panelPosition && left === panelPosition.left && top === panelPosition.top) return;
    panelPosition = { left, top };
    panel.style.setProperty('--service-panel-x', `${left}px`);
    panel.style.setProperty('--service-panel-y', `${top}px`);
    panel.setAttribute('data-positioned', '');
  }

  function keepPanelVisible() {
    if (panelPosition && !panel.hidden) placePanel(panelPosition.left, panelPosition.top);
  }

  function endPanelDrag() {
    if (!panelDrag) return;
    const { id } = panelDrag;
    panelDrag = null;
    panel.removeAttribute('data-dragging');
    if (header.hasPointerCapture(id)) header.releasePointerCapture(id);
  }

  function setOpen(open) {
    if (open === !panel.hidden) return;
    const restoreFocus = !open && panel.contains(document.activeElement);
    if (open) previousFocus = document.activeElement;
    else endPanelDrag();
    panel.hidden = !open;
    if (open) {
      showFront(state);
      keepPanelVisible();
      close.focus({ preventScroll: true });
    } else {
      openWindows.delete(state);
      if (restoreFocus && previousFocus?.isConnected && !previousFocus.closest('[hidden]')) {
        previousFocus.focus({ preventScroll: true });
      }
    }
    onOpenChange?.(open);
  }

  header.addEventListener('pointerdown', event => {
    if (panelDrag || event.button !== 0 || event.target.closest('button')) return;
    const { left, top } = panel.getBoundingClientRect();
    panelDrag = { id: event.pointerId, x: event.clientX - left, y: event.clientY - top };
    if (event.isTrusted) header.setPointerCapture(event.pointerId);
    panel.setAttribute('data-dragging', '');
  });
  window.addEventListener('pointermove', event => {
    if (panelDrag?.id === event.pointerId) placePanel(event.clientX - panelDrag.x, event.clientY - panelDrag.y);
  });
  const finishPointer = event => {
    if (panelDrag?.id === event.pointerId) endPanelDrag();
  };
  window.addEventListener('pointerup', finishPointer);
  window.addEventListener('pointercancel', finishPointer);
  header.addEventListener('lostpointercapture', finishPointer);
  window.addEventListener('blur', endPanelDrag);
  window.addEventListener('resize', keepPanelVisible);
  new ResizeObserver(keepPanelVisible).observe(panel);

  panel.addEventListener('focusin', () => showFront(state));
  panel.addEventListener('pointerdown', () => showFront(state));
  close.addEventListener('click', () => setOpen(false));

  if (!shortcuts.size) document.addEventListener('keydown', handleShortcut);
  shortcuts.set('Key' + key.toUpperCase(), state);
  shortcuts.set(key.toLowerCase(), state);
}
