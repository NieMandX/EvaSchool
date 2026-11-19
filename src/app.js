import { createGlobe } from './globe.js';
import { nextDeck, ROUND_LENGTH } from './questions.js';
import { DEFAULT_SETTINGS, EASING } from './settings.js';

let settings = DEFAULT_SETTINGS;

function applyScreenSettings(next, previous = {}) {
  const style = document.documentElement.style;
  const colors = { pageColor: '--page', textColor: '--ink', mutedColor: '--muted', successText: '--green', wrongText: '--rust' };
  const positions = {
    headerX: '--header-x', headerY: '--header-y', questionX: '--question-x', questionY: '--question-y',
  };
  for (const [key, property] of Object.entries(colors)) {
    if (next[key] !== previous[key]) style.setProperty(property, next[key]);
  }
  for (const [key, property] of Object.entries(positions)) {
    if (next[key] !== previous[key]) style.setProperty(property, `${next[key]}px`);
  }
  if (next.questionScale !== previous.questionScale) style.setProperty('--question-scale', next.questionScale / 100);
}

export function applySettings(next) {
  applyScreenSettings(next, settings);
  settings = next;
  globe.updateSettings(next);
}

applyScreenSettings(settings);

const element = id => document.getElementById(id);
const selection = element('selection');
const hintButton = element('hint');
const hintOptions = element('hint-options');
const skipButton = element('skip');
const nextButton = element('primary');
const progress = element('progress');
const feedback = element('feedback');
const questionView = element('question-view');
const countryLabel = element('country');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const titleMetrics = document.createElement('canvas').getContext('2d');

const steps = Array.from({ length: ROUND_LENGTH }, () => {
  const step = document.createElement('span');
  step.className = 'progress-step';
  element('progress-track').append(step);
  return step;
});

const played = new Set();
let deck = nextDeck();
let index = 0;
let results = [];
let phase = 'question';
let headingMotion = null;
let feedbackMotion = null;
let answerHold = null;

const globe = createGlobe({
  stage: selection.parentElement,
  canvas: element('globe'),
  overlay: selection,
  input: element('globe-input'),
  settings,
  onSelect: guess,
});

function message(text = '', tone = '') {
  if (feedback.textContent === text && (feedback.dataset.tone ?? '') === tone) return;
  feedbackMotion?.cancel();
  feedbackMotion = null;
  feedback.textContent = text;
  feedback.dataset.tone = tone;
  if (text && settings.feedbackMs && !reducedMotion.matches && !document.hidden) {
    feedbackMotion = feedback.animate(
      [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
      { duration: settings.feedbackMs, easing: EASING['soft-out'] },
    );
  }
}

function clearHeadingMotion() {
  if (!headingMotion) return;
  headingMotion.arrival.cancel();
  headingMotion.departure?.cancel();
  headingMotion.snapshot?.remove();
  headingMotion = null;
}

function headingSnapshot(target) {
  let source = target;
  const liveOpacity = Number(getComputedStyle(target).opacity);
  const departing = headingMotion?.target === target ? headingMotion.snapshot : null;
  if (departing && Number(getComputedStyle(departing).opacity) > liveOpacity) {
    source = departing;
  }

  const { opacity, transform } = getComputedStyle(source);
  if (Number(opacity) <= .01) return null;
  const snapshot = source.cloneNode(true);
  snapshot.querySelectorAll('[data-outgoing]').forEach(node => node.remove());
  snapshot.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  snapshot.removeAttribute('id');
  snapshot.setAttribute('aria-hidden', 'true');
  snapshot.setAttribute('data-outgoing', '');
  return { snapshot, opacity, transform };
}

function transitionHeading(target, update) {
  const {
    headingEnterMs, headingExitMs, headingDelayMs,
    headingEnterOffset, headingExitOffset, headingEnterEasing, headingExitEasing,
  } = settings;
  const animate = !reducedMotion.matches && !document.hidden && (headingEnterMs || headingExitMs);
  const previous = animate && headingExitMs ? headingSnapshot(target) : null;
  clearHeadingMotion();
  update();
  if (!animate) return;

  const motion = { target, arrival: null, departure: null, snapshot: previous?.snapshot };
  const finish = () => {
    if (headingMotion === motion && !motion.snapshot && motion.arrival.playState === 'finished') headingMotion = null;
  };
  if (previous) {
    const { snapshot, opacity, transform } = previous;
    target.before(snapshot);
    motion.departure = snapshot.animate(
      [{ opacity, transform }, { opacity: 0, transform: `translateY(${-headingExitOffset}px)` }],
      { duration: headingExitMs, easing: EASING[headingExitEasing], fill: 'forwards' },
    );
    motion.departure.onfinish = () => {
      snapshot.remove();
      motion.snapshot = null;
      finish();
    };
  }

  motion.arrival = target.animate(
    [{ opacity: 0, transform: `translateY(${headingEnterOffset}px)` }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: headingEnterMs, delay: previous ? headingDelayMs : 0, easing: EASING[headingEnterEasing], fill: 'backwards' },
  );
  headingMotion = motion;
  motion.arrival.onfinish = finish;
}

export function previewQuestionTransition() {
  transitionHeading(questionView, () => {});
}

function fitCountry(text) {
  const tracking = .06 * Math.max(0, text.length - 1);
  // Measure at a fixed size to keep the same line box as names change.
  titleMetrics.font = '800 100px Manrope, system-ui, sans-serif';
  const textUnits = Math.max(2.98, titleMetrics.measureText(text).width / 100 - tracking + .24);
  countryLabel.style.setProperty('--country-units', textUnits);
}

function showHeading(text, tone = '') {
  if (text === countryLabel.textContent) {
    countryLabel.dataset.tone = tone;
    return;
  }
  transitionHeading(questionView, () => {
    countryLabel.textContent = text;
    countryLabel.dataset.tone = tone;
    fitCountry(text);
  });
}

function clearAnswerCue(hold) {
  hold.animation?.cancel();
  hold.marker?.remove();
  hold.animation = null;
  hold.marker = null;
  hold.step.removeAttribute('data-holding');
}

function pauseAnswerHold() {
  if (!answerHold || answerHold.timer === null) return;
  clearTimeout(answerHold.timer);
  answerHold.remaining = Math.max(0, answerHold.remaining - (performance.now() - answerHold.startedAt));
  answerHold.timer = null;
  answerHold.animation?.pause();
}

function resumeAnswerHold() {
  const hold = answerHold;
  if (!hold || document.hidden || hold.timer !== null) return;
  hold.startedAt = performance.now();
  hold.animation?.play();
  hold.timer = setTimeout(() => {
    if (document.hidden) {
      pauseAnswerHold();
      return;
    }
    clearAnswerCue(hold);
    answerHold = null;
    advanceAnswer();
  }, hold.remaining);
}

function startAnswerHold() {
  const step = steps[index];
  const hold = { step, remaining: settings.correctPause, timer: null };
  if (hold.remaining && !reducedMotion.matches) {
    hold.marker = document.createElement('span');
    hold.marker.className = 'progress-hold';
    step.append(hold.marker);
    step.setAttribute('data-holding', '');
    hold.animation = hold.marker.animate(
      [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      { duration: hold.remaining, fill: 'both' },
    );
    hold.animation.pause();
  }
  answerHold = hold;
  resumeAnswerHold();
}

reducedMotion.addEventListener('change', () => {
  if (!reducedMotion.matches) return;
  clearHeadingMotion();
  feedbackMotion?.cancel();
  if (answerHold) clearAnswerCue(answerHold);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseAnswerHold();
  else resumeAnswerHold();
});
document.fonts.ready.then(() => fitCountry(countryLabel.textContent));

function setHintOpen(open) {
  hintButton.setAttribute('aria-expanded', String(open));
  hintOptions.hidden = !open;
}

function showQuestion() {
  phase = 'question';
  setHintOpen(false);
  showHeading(deck[index].name);
  progress.setAttribute('aria-valuenow', index + 1);
  progress.setAttribute('aria-valuetext', `Задание ${index + 1} из ${ROUND_LENGTH}`);
  steps.forEach((step, i) => {
    step.dataset.state = results[i] ?? (i === index ? 'current' : 'waiting');
  });
  hintButton.hidden = false;
  nextButton.hidden = true;
  message();
  globe.paint();
  globe.setGuessEnabled(true);
}

function guess(id) {
  if (phase !== 'question') return;
  const question = deck[index];
  if (id === question.id) {
    settle('found');
    globe.paint(id, 'correct');
    showHeading(question.name, 'correct');
    message('Верно!', 'correct');
    startAnswerHold();
  } else {
    globe.paint(id, 'wrong');
    setHintOpen(false);
    message('Пока мимо. Попробуй ещё раз.', 'wrong');
  }
}

function settle(result) {
  phase = 'answer';
  results[index] = result;
  played.add(deck[index].id);
  steps[index].dataset.state = result;
  hintButton.hidden = true;
  setHintOpen(false);
  nextButton.hidden = result === 'found';
  nextButton.firstElementChild.textContent = index === ROUND_LENGTH - 1 ? 'Мой результат' : 'Следующее задание';
  message();
  globe.setGuessEnabled(false);
}

function showSummary() {
  phase = 'summary';
  const found = results.filter(result => result === 'found').length;
  showHeading(`${found} из ${ROUND_LENGTH}`);
  nextButton.hidden = false;
  nextButton.firstElementChild.textContent = 'Сыграть ещё';
  progress.setAttribute('aria-valuetext', 'Раунд завершён');
  globe.paint();
  message('Твой результат');
}

function advanceAnswer() {
  if (phase !== 'answer') return;
  if (index === ROUND_LENGTH - 1) {
    showSummary();
    if (selection.matches(':focus-visible')) nextButton.focus();
  } else {
    index++;
    showQuestion();
  }
}

hintButton.addEventListener('click', () => {
  const open = hintOptions.hidden;
  setHintOpen(open);
  globe.paint();
  message(open ? deck[index].hint : '');
});

skipButton.addEventListener('click', () => {
  const keyboard = skipButton.matches(':focus-visible');
  const question = deck[index];
  settle('skipped');
  globe.paint(question.id, 'reveal');
  globe.goTo({ lon: question.lon, lat: question.lat, zoom: 1.05 });
  message('Правильный ответ');
  if (keyboard) nextButton.focus();
});

nextButton.addEventListener('click', () => {
  const keyboard = nextButton.matches(':focus-visible');
  if (phase === 'summary') {
    deck = nextDeck(played);
    results = [];
    index = 0;
    showQuestion();
  } else if (phase === 'answer' && results[index] === 'skipped') {
    advanceAnswer();
  }
  if (keyboard && phase === 'question') selection.focus();
});

fitCountry(countryLabel.textContent);
showQuestion();
