import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { SETTING_GROUPS, decodePreset, encodePreset } from '../src/service-settings.js';

test('each preset field has a default and can be exported and restored', () => {
  const keys = SETTING_GROUPS.flatMap(group => group.fields.map(field => field.key));
  assert.deepEqual(keys.sort(), Object.keys(DEFAULT_SETTINGS).sort());
  assert.deepEqual(decodePreset(encodePreset(DEFAULT_SETTINGS)), DEFAULT_SETTINGS);
});

test('partial presets use defaults and keep numeric values within supported ranges', () => {
  const decoded = decodePreset(JSON.stringify({
    version: 1,
    settings: { shoreBlur: 90, shoreLift: 0, zoomResponse: -1, pageColor: '#ABCDEF', futureField: 1 },
  }));
  assert.deepEqual(decoded, { ...DEFAULT_SETTINGS, shoreBlur: 24, shoreLift: 0, zoomResponse: 0, pageColor: '#abcdef' });
});

test('invalid preset versions, values and layouts cannot change the draft', () => {
  assert.throws(() => decodePreset('{"version":2,"settings":{}}'), /версии 1/);
  assert.throws(() => decodePreset('{"version":1,"settings":[]}'), /отсутствуют настройки/);
  assert.throws(() => encodePreset({ waterLight: 'url(example)' }), /Вода/);
  assert.throws(() => encodePreset({ headingDelayMs: 'now' }), /Задержка/);
  assert.throws(() => encodePreset({ headingExitEasing: 'bounce' }), /Кривая/);
});
