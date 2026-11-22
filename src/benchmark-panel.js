import { SLOW_FRAME_MS } from './benchmark-metrics.js';
import { RENDERER_NAMES } from './render-status.js';

const DASH = '—';
const whole = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 });
const threshold = decimal.format(SLOW_FRAME_MS);
const LONG_FRAME_NOTE = `Длинные кадры — интервалы выше порога ${threshold} мс (округлённо).`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function textIfChanged(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function formatted(formatter, value) {
  return Number.isFinite(value) ? formatter.format(value) : DASH;
}

function rendererName(mode) {
  return RENDERER_NAMES[mode] ?? DASH;
}

export function mountBenchmarkPanel({ start, cancel }) {
  const panel = element('section', 'benchmark-panel');
  panel.id = 'benchmark-panel';
  panel.setAttribute('aria-labelledby', 'benchmark-title');
  const title = element('h2', '', 'Сравнение рендереров');
  title.id = 'benchmark-title';
  const statusLine = element('p', 'benchmark-status');
  statusLine.setAttribute('role', 'status');
  const intro = element('p', 'benchmark-note', 'Одинаковое вращение и зум в каждом режиме. Замер займёт около 30 секунд.');
  const progressBar = element('progress', 'benchmark-progress');
  progressBar.max = 100;
  progressBar.setAttribute('aria-label', 'Ход текущего прогона');
  progressBar.hidden = true;
  const messageLine = element('p', 'benchmark-message');
  messageLine.setAttribute('role', 'status');

  const resultsBox = element('div', 'benchmark-results');
  resultsBox.hidden = true;
  const table = element('table', 'benchmark-table');
  table.append(element('caption', 'sr-only', 'Сводные показатели прогонов'));
  const head = element('thead');
  const columns = element('tr');
  for (const label of ['Режим', 'Кадры', 'FPS', 'Длинные', 'p95, мс']) {
    const cell = element('th', '', label);
    cell.scope = 'col';
    if (label === 'Длинные') cell.setAttribute('aria-label', 'Длинные кадры');
    if (label === 'p95, мс') cell.title = '95-й процентиль интервала между кадрами';
    columns.append(cell);
  }
  head.append(columns);
  const body = element('tbody');
  table.append(head, body);
  resultsBox.append(table, element('p', 'benchmark-note', LONG_FRAME_NOTE));

  const actions = element('div', 'benchmark-actions');
  const startButton = element('button', 'benchmark-button benchmark-primary', 'Сравнить режимы');
  const cancelButton = element('button', 'benchmark-button', 'Остановить');
  const copyButton = element('button', 'benchmark-button', 'Копировать');
  for (const button of [startButton, cancelButton, copyButton]) button.type = 'button';
  cancelButton.hidden = true;
  copyButton.hidden = true;
  const copyNotice = element('p', 'benchmark-message');
  copyNotice.setAttribute('role', 'status');
  actions.append(startButton, cancelButton, copyButton);
  panel.append(title, intro, statusLine, progressBar, messageLine, resultsBox, actions, copyNotice);
  document.body.append(panel);

  let lastStatus = 'idle';
  let lastProgress = null;
  let copyText = '';

  function updateProgress(progress) {
    const value = Number.isFinite(progress)
      ? Math.round(Math.min(1, Math.max(0, progress)) * 20) * 5
      : null;
    if (value === lastProgress) return;
    lastProgress = value;
    if (value === null) progressBar.removeAttribute('value');
    else progressBar.value = value;
  }

  function showResults(results, message) {
    let usable = 0;
    const lines = [`Режим\tКадры\tFPS\tДлинные кадры (>${threshold} мс)\tp95, мс`];
    const rows = results.map(({ mode, samples, fps, slowFrames, slowShare, p95, unavailable }) => {
      const row = element('tr');
      const name = rendererName(mode);
      const heading = element('th', '', name);
      heading.scope = 'row';
      row.append(heading);
      if (unavailable || !Number.isFinite(samples) || samples <= 0) {
        let reason = 'Нет данных';
        if (unavailable) reason = typeof unavailable === 'string' ? unavailable : 'Недоступен';
        const cell = element('td', 'benchmark-unavailable', reason);
        cell.colSpan = 4;
        row.append(cell);
        lines.push(`${name}\t${reason}`);
        return row;
      }

      usable++;
      const count = formatted(whole, samples);
      const rate = formatted(decimal, fps);
      const slow = formatted(whole, slowFrames);
      const share = formatted(percent, slowShare);
      const interval = formatted(decimal, p95);
      const longFrames = element('td', '', slow);
      longFrames.append(element('small', '', share));
      row.append(element('td', '', count), element('td', '', rate), longFrames, element('td', '', interval));
      lines.push([name, count, rate, `${slow} (${share})`, interval].join('\t'));
      return row;
    });
    body.replaceChildren(...rows);
    resultsBox.hidden = !rows.length;
    copyText = rows.length ? ['Сравнение рендереров', message, ...lines].filter(Boolean).join('\n') : '';
    copyButton.hidden = !copyText || typeof navigator.clipboard?.writeText !== 'function';
    return usable;
  }

  function render({ status = 'idle', mode, run, total, progress, results = [], message = '' } = {}) {
    const running = status === 'running';
    if (status !== lastStatus) {
      const restoreFocus = running ? document.activeElement === startButton : document.activeElement === cancelButton;
      lastStatus = status;
      intro.hidden = status !== 'idle';
      startButton.hidden = running;
      startButton.textContent = status === 'done' ? 'Повторить' : 'Сравнить режимы';
      cancelButton.hidden = !running;
      progressBar.hidden = !running;
      resultsBox.hidden = true;
      copyButton.hidden = true;
      copyText = '';
      textIfChanged(copyNotice, '');
      if (restoreFocus) (running ? cancelButton : startButton).focus({ preventScroll: true });
    }
    textIfChanged(messageLine, message);

    if (running) {
      const label = rendererName(mode);
      const runText = Number.isFinite(run) && Number.isFinite(total) ? `Прогон ${run} из ${total}` : 'Подготовка замера';
      textIfChanged(statusLine, label === DASH ? runText : `${label} · ${runText}`);
      updateProgress(progress);
      return;
    }
    updateProgress(null);
    if (status === 'done') {
      const usable = showResults(results, message);
      const outcome = usable >= 2 ? 'Замер завершён.' : usable ? 'Замер выполнен частично.' : 'Нет результатов замера.';
      textIfChanged(statusLine, !usable && message ? '' : outcome);
    } else {
      textIfChanged(statusLine, '');
    }
  }

  startButton.addEventListener('click', () => start());
  cancelButton.addEventListener('click', () => cancel());
  copyButton.addEventListener('click', async () => {
    const snapshot = copyText;
    if (!snapshot) return;
    let notice;
    try {
      await navigator.clipboard.writeText(snapshot);
      notice = 'Результаты скопированы.';
    } catch {
      notice = 'Не удалось скопировать результаты.';
    }
    if (copyText === snapshot) textIfChanged(copyNotice, notice);
  });
  return { render };
}
