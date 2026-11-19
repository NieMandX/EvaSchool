import { DEFAULT_SETTINGS } from './settings.js';

const number = (key, label, min, max, step, unit, description) =>
  ({ key, label, type: 'number', min, max, step, unit, description });
const pixels = (key, label, min, max, step = 1, description) => number(key, label, min, max, step, 'пкс', description);
const milliseconds = (key, label, max, step = 5) => number(key, label, 0, max, step, 'мс');
const percent = (key, label, min, max) => number(key, label, min, max, 1, '%');
const color = (key, label) => ({ key, label, type: 'color' });
const easing = (key, label) => ({
  key, label, type: 'select', options: [
    { value: 'soft-out', label: 'Плавное замедление' },
    { value: 'soft-in', label: 'Плавный разгон' },
    { value: 'ease-in-out', label: 'Разгон и замедление' },
    { value: 'linear', label: 'Равномерно' },
  ],
});

export const SETTING_GROUPS = [
  { label: 'Экран и компоновка', fields: [
    pixels('headerX', 'Шапка по X', -120, 120),
    pixels('headerY', 'Шапка по Y', -35, 90),
    pixels('questionX', 'Вопрос по X', -160, 160),
    pixels('questionY', 'Вопрос по Y', -120, 70),
    percent('questionScale', 'Размер текста вопроса', 65, 140),
    pixels('controlsX', 'Кнопки масштаба по X', -160, 30),
    pixels('controlsY', 'Кнопки масштаба по Y', -65, 170),
    color('pageColor', 'Фон экрана'),
    color('textColor', 'Основной текст'),
    color('mutedColor', 'Текст подсказок'),
    color('successText', 'Текст верного ответа'),
    color('wrongText', 'Текст ошибки'),
  ] },
  { label: 'Смена вопроса', fields: [
    milliseconds('headingEnterMs', 'Появление текста', 1000),
    milliseconds('headingExitMs', 'Затухание текста', 1000),
    milliseconds('headingDelayMs', 'Задержка появления', 700),
    pixels('headingEnterOffset', 'Сдвиг при появлении', -40, 40),
    pixels('headingExitOffset', 'Сдвиг при затухании', -40, 40),
    easing('headingEnterEasing', 'Кривая появления'),
    easing('headingExitEasing', 'Кривая затухания'),
    milliseconds('feedbackMs', 'Появление подсказки', 900),
    milliseconds('correctPause', 'Пауза до следующего вопроса', 5000, 50),
  ] },
  { label: 'Глобус и инерция', fields: [
    pixels('globeX', 'Центр глобуса по X', -150, 150),
    pixels('globeY', 'Центр глобуса по Y', -110, 110),
    percent('globeSize', 'Размер глобуса', 60, 135),
    number('homeLon', 'Начальная долгота', -180, 180, .1, '°'),
    number('homeLat', 'Начальная широта', -85, 85, .1, '°'),
    number('homeZoom', 'Начальный масштаб', .85, 4.5, .01, '×'),
    percent('inertiaDuration', 'Длительность инерции', 0, 220),
    percent('inertiaDistance', 'Поворот по инерции', 0, 250),
    number('zoomResponse', 'Плавность зума', 0, 180, 1, 'мс', 'Чем больше, тем мягче реакция на изменение масштаба.'),
    milliseconds('resetDuration', 'Возврат к начальному виду', 1400),
  ] },
  { label: 'Рельеф и границы', fields: [
    pixels('shoreLift', 'Высота суши над водой', 0, 16, .25, 'Сдвиг береговой тени создаёт впечатление высоты.'),
    pixels('shoreBlur', 'Размытие береговой тени', 0, 24, .25),
    percent('shoreOpacity', 'Плотность береговой тени', 0, 100),
    color('shoreColor', 'Цвет береговой тени'),
    pixels('borderWidth', 'Толщина границ стран', 0, 3, .05),
    percent('borderOpacity', 'Видимость границ стран', 0, 100),
    color('borderColor', 'Цвет границ стран'),
    percent('gridOpacity', 'Видимость сетки глобуса', 0, 100),
  ] },
  { label: 'Наведение и верный ответ', fields: [
    percent('hoverLift', 'Подъём страны', 0, 250),
    percent('hoverGrowth', 'Увеличение страны', 0, 200),
    milliseconds('hoverDuration', 'Подъём и опускание', 700),
    percent('hoverShadow', 'Плотность тени страны', 0, 200),
    percent('correctBounce', 'Пружина верного ответа', 0, 200),
    milliseconds('correctDuration', 'Длительность верного ответа', 1200),
    color('correctLight', 'Верная страна · свет'),
    color('correctDark', 'Верная страна · тень'),
  ] },
  { label: 'Цвета карты', fields: [
    color('waterLight', 'Вода · свет'),
    color('waterMid', 'Вода · средний тон'),
    color('waterDark', 'Вода · тень'),
    color('landEurasia', 'Евразия'),
    color('landAfrica', 'Африка'),
    color('landNorthAmerica', 'Северная Америка'),
    color('landSouthAmerica', 'Южная Америка'),
    color('landOceania', 'Австралия и Океания'),
    color('landAntarctica', 'Антарктида'),
  ] },
];

const fields = SETTING_GROUPS.flatMap(group => group.fields);

function normalizeSettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('В файле отсутствуют настройки.');
  }
  const settings = { ...DEFAULT_SETTINGS };
  for (const { key, label, type, min, max, options } of fields) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (type === 'number' && Number.isFinite(value)) {
      settings[key] = Math.min(max, Math.max(min, value));
    } else if (type === 'color' && typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
      settings[key] = value.toLowerCase();
    } else if (type === 'select' && options.some(option => option.value === value)) {
      settings[key] = value;
    } else {
      throw new Error(`Проверьте значение поля «${label}».`);
    }
  }
  return settings;
}

export function decodePreset(json) {
  const preset = JSON.parse(json);
  if (preset?.version !== 1) throw new Error('Файл должен быть набором настроек «Контура» версии 1.');
  return normalizeSettings(preset.settings);
}

export function encodePreset(values) {
  return JSON.stringify({ version: 1, settings: normalizeSettings(values) }, null, 2) + '\n';
}
