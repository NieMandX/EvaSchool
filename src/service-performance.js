import { mountServiceWindow } from './service-window.js';

const WINDOW_MS = 1000;
const IDLE_MS = 350;
const REFRESH_MS = 250;
const DASH = '—';
const renderers = { webgpu: 'WebGPU', webgl: 'WebGL', canvas: 'Canvas 2D' };
const wholeNumber = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function updateText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function addMetric(list, label, description) {
  const row = element('div', 'performance-metric');
  const heading = element('dt', '', label);
  if (description) heading.title = description;
  const value = element('dd', '', DASH);
  row.append(heading, value);
  list.append(row);
  return value;
}

export function mountPerformancePanel({ observeFrames, describeRendering, selectRenderer }) {
  const panel = element('section', 'service-panel service-performance');
  panel.id = 'performance-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', 'performance-title');
  panel.setAttribute('aria-keyshortcuts', 'P Escape');

  const header = element('header', 'service-header');
  header.title = 'Перетащить окно показателей';
  const title = element('h2', 'service-title', 'Производительность');
  title.id = 'performance-title';
  const close = element('button', 'service-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть показатели');
  header.append(title, close);

  const content = element('div', 'performance-content');
  const rate = element('dl', 'performance-rate');
  const fpsLabel = element('dt', '', 'FPS глобуса');
  fpsLabel.title = 'Частота активных кадров глобуса за последнюю секунду';
  const fps = element('dd', '', DASH);
  rate.append(fpsLabel, fps);
  const metrics = element('dl', 'performance-metrics');
  const p95 = addMetric(metrics, 'Интервал p95', '95-й процентиль интервала между активными кадрами');
  const cpu = addMetric(metrics, 'CPU · обработчик', 'Среднее время JS-обработчика кадра. Время GPU не измеряется.');
  const resolution = addMetric(metrics, 'Буфер, пиксели');
  const backend = addMetric(metrics, 'Рендерер');
  content.append(rate, metrics);

  let rendererChoice = null;
  if (typeof selectRenderer === 'function') {
    const control = element('label', 'performance-choice');
    control.append(element('span', '', 'Режим'));
    rendererChoice = element('select', 'service-input');
    rendererChoice.setAttribute('aria-label', 'Предпочтительный рендерер');
    for (const [value, label] of Object.entries({ auto: 'Авто', ...renderers })) {
      const option = element('option', '', label);
      option.value = value;
      rendererChoice.append(option);
    }
    rendererChoice.addEventListener('change', () => {
      samples.length = 0;
      selectRenderer(rendererChoice.value);
      refresh();
    });
    control.append(rendererChoice);
    content.append(control);
  }
  panel.append(header, content);
  document.body.append(panel);

  const samples = [];
  let lastArrival = -Infinity;
  let lastRenderer = null;
  let refreshTimer = null;

  function record({ time, workMs }) {
    if (!Number.isFinite(time) || !Number.isFinite(workMs) || workMs < 0) return;
    const previous = samples.at(-1);
    const interval = previous ? time - previous.time : 0;
    if (previous && (interval <= 0 || interval > Math.max(IDLE_MS, previous.workMs + 100))) {
      samples.length = 0;
    }
    samples.push({ time, workMs });
    lastArrival = performance.now();
    while (time - samples[0].time > WINDOW_MS) samples.shift();
  }

  function refresh() {
    const { renderer, width, height, preference } = describeRendering();
    if (lastRenderer !== null && lastRenderer !== renderer) samples.length = 0;
    lastRenderer = renderer;
    updateText(backend, renderers[renderer] ?? DASH);
    updateText(resolution, width > 0 && height > 0
      ? `${wholeNumber.format(width)} × ${wholeNumber.format(height)}`
      : DASH);
    if (rendererChoice && rendererChoice.value !== preference) rendererChoice.value = preference ?? 'auto';

    const latest = samples.at(-1);
    const idle = !latest || performance.now() - lastArrival > Math.max(IDLE_MS, latest.workMs + 100);
    rate.toggleAttribute('data-idle', idle);
    if (idle) {
      updateText(fps, 'покой');
      updateText(p95, DASH);
      updateText(cpu, DASH);
      return;
    }
    const intervals = samples.slice(1).map(({ time }, index) => time - samples[index].time).sort((a, b) => a - b);
    const total = latest.time - samples[0].time;
    const count = intervals.length;
    const work = samples.reduce((sum, sample) => sum + sample.workMs, 0) / samples.length;
    updateText(fps, count ? wholeNumber.format(1000 * count / total) : DASH);
    updateText(p95, count ? decimal.format(intervals[Math.ceil(.95 * count) - 1]) + ' мс' : DASH);
    updateText(cpu, decimal.format(work) + ' мс');
  }

  function syncObservation() {
    const listening = !panel.hidden && !document.hidden;
    if (listening && refreshTimer === null) {
      samples.length = 0;
      lastArrival = -Infinity;
      lastRenderer = null;
      observeFrames(record);
      refresh();
      refreshTimer = setInterval(refresh, REFRESH_MS);
    } else if (!listening && refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
      observeFrames(null);
    }
  }

  mountServiceWindow({ panel, header, close, key: 'P', onOpenChange: syncObservation });
  document.addEventListener('visibilitychange', syncObservation);
}
