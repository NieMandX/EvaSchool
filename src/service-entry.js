import { applySettings, previewQuestionTransition, renderingDiagnostics } from './app.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { SETTING_GROUPS, decodePreset, encodePreset } from './service-settings.js';
import { mountServicePanel } from './service-panel.js';
import { mountPerformancePanel } from './service-performance.js';

mountServicePanel({
  groups: SETTING_GROUPS, defaults: DEFAULT_SETTINGS, applySettings, decodePreset, encodePreset,
  previewTransition: previewQuestionTransition,
});
mountPerformancePanel(renderingDiagnostics);
