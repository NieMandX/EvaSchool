const STORAGE_KEY = 'kontur:service-preset:v1';
const SVG_NS = 'http://www.w3.org/2000/svg';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text, className = 'service-button') {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function icon(path) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('d', path);
  svg.append(line);
  return svg;
}

function numberLimits(input, field) {
  if (Number.isFinite(field.min)) input.min = field.min;
  if (Number.isFinite(field.max)) input.max = field.max;
  input.step = field.step ?? 'any';
}

function normalizeHex(value) {
  const hex = value.trim().replace(/^#/, '').toLowerCase();
  if (/^[\da-f]{6}$/.test(hex)) return '#' + hex;
  if (/^[\da-f]{3}$/.test(hex)) return '#' + [...hex].map(digit => digit + digit).join('');
  return null;
}

function makeField(field, id, change) {
  const row = element('div', 'service-field');
  row.dataset.setting = field.key;
  const label = element('label', 'service-field-label', field.label);
  label.htmlFor = id;
  const controls = element('div', 'service-controls');
  row.append(label, controls);

  const describe = input => {
    if (field.description) input.setAttribute('aria-describedby', id + '-description');
  };
  if (field.description) {
    const description = element('p', 'service-field-description', field.description);
    description.id = id + '-description';
    row.append(description);
  }

  if (field.type === 'select') {
    const select = element('select', 'service-input');
    select.id = id;
    select.name = field.key;
    describe(select);
    const options = field.options ?? [];
    options.forEach(({ label: optionLabel }, index) => {
      const option = element('option', '', optionLabel);
      option.value = index;
      select.append(option);
    });
    select.addEventListener('change', () => change(field.key, options[select.selectedIndex]?.value));
    controls.append(select);
    return { row, sync(value) { select.selectedIndex = options.findIndex(option => option.value === value); } };
  }

  if (field.type === 'color') {
    const picker = element('input', 'service-swatch');
    picker.type = 'color';
    picker.setAttribute('aria-label', field.label + ', выбор цвета');
    describe(picker);
    const hex = element('input', 'service-input service-hex');
    hex.id = id;
    hex.name = field.key;
    hex.type = 'text';
    hex.maxLength = 7;
    hex.spellcheck = false;
    hex.autocomplete = 'off';
    hex.autocapitalize = 'off';
    describe(hex);
    const sync = (value, source) => {
      const color = normalizeHex(String(value)) ?? '#000000';
      if (source !== picker) picker.value = color;
      if (source !== hex) hex.value = color.toUpperCase();
    };
    picker.addEventListener('input', () => change(field.key, picker.value, picker));
    picker.addEventListener('change', () => change(field.key, picker.value, picker, true));
    hex.addEventListener('input', () => {
      const value = hex.value.trim().replace(/^#/, '');
      if (value.length !== 6) return;
      const color = normalizeHex(hex.value);
      if (color) change(field.key, color, hex);
    });
    hex.addEventListener('blur', () => change(field.key, normalizeHex(hex.value), null, true));
    hex.addEventListener('keydown', event => {
      if (event.key === 'Enter') hex.blur();
    });
    controls.append(picker, hex);
    return { row, sync };
  }

  const number = element('input', 'service-input service-number');
  number.id = id;
  number.name = field.key;
  number.type = 'number';
  number.inputMode = 'decimal';
  numberLimits(number, field);
  describe(number);

  const valueGroup = element('div', 'service-value');
  valueGroup.append(number);
  if (field.unit) valueGroup.append(element('span', 'service-unit', field.unit));
  controls.append(valueGroup);

  let range;
  if (Number.isFinite(field.min) && Number.isFinite(field.max) && field.max > field.min) {
    range = element('input', 'service-range');
    range.type = 'range';
    range.setAttribute('aria-label', field.label + ', ползунок');
    numberLimits(range, field);
    describe(range);
    range.addEventListener('input', () => change(field.key, range.valueAsNumber, range));
    range.addEventListener('change', () => change(field.key, range.valueAsNumber, range, true));
    row.append(range);
  }

  number.addEventListener('input', () => {
    const value = number.valueAsNumber;
    if (Number.isFinite(value) && !number.validity.rangeUnderflow && !number.validity.rangeOverflow) {
      change(field.key, value, number);
    }
  });
  number.addEventListener('blur', () => {
    const raw = number.valueAsNumber;
    const value = Number.isFinite(raw)
      ? Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, raw))
      : null;
    change(field.key, value, null, true);
  });
  number.addEventListener('keydown', event => {
    if (event.key === 'Enter') number.blur();
  });
  return {
    row,
    sync(value, source) {
      if (source !== number) number.value = value;
      if (range && source !== range) range.value = value;
    },
  };
}

function searchText(text) {
  return text.toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();
}

export function mountServicePanel({ groups, defaults, applySettings, decodePreset, encodePreset, previewTransition }) {
  const toggle = button('Настройка', 'service-toggle');
  toggle.id = 'service-toggle';
  toggle.prepend(icon('M4 7h6m4 0h6M4 17h9m4 0h3M10 5v4m4 6v4'));
  toggle.setAttribute('aria-controls', 'service-panel');
  toggle.setAttribute('aria-expanded', 'false');

  const panel = element('section', 'service-panel');
  panel.id = 'service-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', 'service-title');

  const header = element('header', 'service-header');
  header.title = 'Перетащить окно настроек';
  const title = element('h2', 'service-title', 'Настройка');
  title.id = 'service-title';
  const close = button('', 'service-close');
  close.setAttribute('aria-label', 'Закрыть настройку');
  close.append(icon('m7 7 10 10M17 7 7 17'));
  header.append(title, close);

  const search = element('input', 'service-input service-search');
  search.type = 'search';
  search.placeholder = 'Найти параметр';
  search.setAttribute('aria-label', 'Найти параметр');
  search.autocomplete = 'off';

  const content = element('div', 'service-content');
  const noResults = element('p', 'service-status', 'Параметры не найдены.');
  noResults.setAttribute('role', 'status');
  noResults.hidden = true;

  const footer = element('footer', 'service-footer');
  const actions = element('div', 'service-actions');
  const reset = button('Сбросить');
  const importButton = button('Импорт');
  importButton.setAttribute('aria-label', 'Импортировать JSON');
  const exportButton = button('Экспорт', 'service-button service-button-primary');
  exportButton.setAttribute('aria-label', 'Скачать пресет JSON');
  const fileInput = element('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json,text/plain';
  fileInput.hidden = true;
  const status = element('p', 'service-status');
  status.setAttribute('role', 'status');
  actions.append(reset, importButton, exportButton, fileInput);
  footer.append(actions, status);
  panel.append(header, search, content, footer);

  let settings = { ...defaults };
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) settings = decodePreset(saved);
  } catch {
    // Defaults also work when storage is unavailable or holds an obsolete preset.
  }
  applySettings(settings);

  let saveTimer = null;
  let importRevision = 0;
  let panelPosition = null;
  let panelDrag = null;
  const fields = new Map();

  function announce(text, error = false) {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, encodePreset(settings));
    } catch {
      // Live settings remain usable without browser storage.
    }
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 160);
  }

  function change(key, value, source, committed = false) {
    if (value !== null && value !== undefined && value !== settings[key]) {
      const next = { ...settings, [key]: value };
      applySettings(next);
      settings = next;
      importRevision++;
      announce('');
      saveSoon();
    }
    fields.get(key).sync(settings[key], source);
    if (committed && saveTimer !== null) save();
  }

  const sections = groups.map(({ label, fields: descriptors }, groupIndex) => {
    const details = element('details', 'service-section');
    details.append(element('summary', 'service-summary', label));
    const group = element('div', 'service-fields');
    const rows = descriptors.map((field, fieldIndex) => {
      const binding = makeField(field, `service-field-${groupIndex}-${fieldIndex}`, change);
      binding.sync(settings[field.key]);
      fields.set(field.key, binding);
      group.append(binding.row);
      return { row: binding.row, text: searchText(`${field.label} ${field.key} ${field.description ?? ''}`) };
    });
    if (label === 'Смена вопроса' && typeof previewTransition === 'function') {
      const preview = button('Проверить затухание');
      preview.classList.add('service-preview');
      preview.addEventListener('click', previewTransition);
      group.append(preview);
    }
    details.append(group);
    content.append(details);
    return { details, title: searchText(label), rows, expanded: details.open };
  });

  const jsonSection = element('details', 'service-section service-json');
  jsonSection.append(element('summary', 'service-summary', 'JSON текстом'));
  const jsonTools = element('div', 'service-json-tools');
  const jsonLabel = element('label', 'sr-only', 'Текст пресета JSON');
  jsonLabel.htmlFor = 'service-preset-json';
  const jsonInput = element('textarea', 'service-input service-json-input');
  jsonInput.id = 'service-preset-json';
  jsonInput.rows = 5;
  jsonInput.placeholder = 'Вставьте JSON пресета';
  jsonInput.spellcheck = false;
  jsonInput.autocapitalize = 'off';
  const jsonActions = element('div', 'service-actions service-json-actions');
  const useJson = button('Применить');
  const showJson = button('Показать текущий');
  jsonActions.append(useJson, showJson);
  jsonTools.append(jsonLabel, jsonInput, jsonActions);
  jsonSection.append(jsonTools);
  content.append(noResults, jsonSection);

  let filtering = false;
  search.addEventListener('input', () => {
    const query = searchText(search.value);
    let found = false;
    for (const section of sections) {
      if (query && !filtering) section.expanded = section.details.open;
      const wholeGroup = section.title.includes(query);
      let visibleRows = false;
      for (const row of section.rows) {
        const visible = wholeGroup || row.text.includes(query);
        row.row.hidden = !visible;
        visibleRows ||= visible;
      }
      found ||= visibleRows;
      section.details.hidden = !visibleRows;
      if (query || filtering) section.details.open = query ? visibleRows : section.expanded;
    }
    filtering = Boolean(query);
    noResults.hidden = !filtering || found;
    jsonSection.hidden = filtering;
  });

  function replaceSettings(next) {
    applySettings(next);
    settings = next;
    for (const [key, binding] of fields) binding.sync(settings[key]);
  }

  function importError() {
    announce('Не удалось прочитать пресет. Проверьте JSON.', true);
  }

  function importPreset(text) {
    try {
      replaceSettings(decodePreset(text));
      save();
      announce('Пресет применён.');
    } catch {
      importError();
    }
  }

  importButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    const revision = ++importRevision;
    try {
      const text = await file.text();
      if (revision === importRevision) importPreset(text);
    } catch {
      if (revision === importRevision) importError();
    }
  });

  exportButton.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([encodePreset(settings)], { type: 'application/json' }));
    const download = document.createElement('a');
    download.href = url;
    download.download = 'kontur-preset.json';
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('Пресет готов к скачиванию.');
  });

  reset.addEventListener('click', () => {
    importRevision++;
    replaceSettings({ ...defaults });
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Reset also works when storage is unavailable.
    }
    announce('Восстановлены исходные значения.');
  });

  useJson.addEventListener('click', () => {
    importRevision++;
    importPreset(jsonInput.value);
  });
  showJson.addEventListener('click', () => {
    jsonInput.value = encodePreset(settings);
    jsonInput.focus({ preventScroll: true });
    jsonInput.select();
  });

  function placePanel(left, top) {
    const margin = 8;
    const { clientWidth, clientHeight } = document.documentElement;
    left = Math.max(margin, Math.min(left, clientWidth - panel.offsetWidth - margin));
    top = Math.max(margin, Math.min(top, clientHeight - panel.offsetHeight - margin));
    if (panelPosition && left === panelPosition.left && top === panelPosition.top) return;
    panelPosition = { left, top };
    panel.style.setProperty('--service-panel-x', `${left}px`);
    panel.style.setProperty('--service-panel-y', `${top}px`);
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

  header.addEventListener('pointerdown', event => {
    if (panelDrag || event.button !== 0 || event.target.closest('button')) return;
    const { left, top } = panel.getBoundingClientRect();
    panelDrag = { id: event.pointerId, x: event.clientX - left, y: event.clientY - top };
    header.setPointerCapture(event.pointerId);
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

  function openPanel(open) {
    const restoreFocus = !open && panel.contains(document.activeElement);
    if (!open) endPanelDrag();
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      keepPanelVisible();
      close.focus({ preventScroll: true });
    }
    if (restoreFocus) toggle.focus({ preventScroll: true });
  }

  toggle.addEventListener('click', () => openPanel(panel.hidden));
  close.addEventListener('click', () => openPanel(false));
  document.addEventListener('keydown', event => {
    if (!panel.hidden && event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      openPanel(false);
    }
  });
  window.addEventListener('pagehide', () => {
    if (saveTimer !== null) save();
  });

  document.body.append(toggle, panel);
}
