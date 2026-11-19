import { createGlobe } from './globe.js';
import { nextDeck, ROUND_LENGTH } from './questions.js';

const CORRECT_ANSWER_PAUSE = 1100;

const element = id => document.getElementById(id);
const selection = element('selection');
const hintButton = element('hint');
const skipButton = element('skip');
const nextButton = element('primary');
const zoomIn = element('zoom-in');
const zoomOut = element('zoom-out');
const progressLabel = element('progress-label');
const feedback = element('feedback');
const questionView = element('question-view');
const countryLabel = element('country');
const intro = element('question-lead');
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
let showingHint = false;
let headingMotion = null;
let feedbackMotion = null;
let answerHold = null;

const globe = createGlobe({
  stage: selection.parentElement,
  canvas: element('globe'),
  overlay: selection,
  input: element('globe-input'),
  onSelect: guess,
  onZoom({ canZoomIn, canZoomOut }) {
    zoomIn.disabled = !canZoomIn;
    zoomOut.disabled = !canZoomOut;
  },
});

function message(text = '', tone = '') {
  if (feedback.textContent === text && (feedback.dataset.tone ?? '') === tone) return;
  feedbackMotion?.cancel();
  feedbackMotion = null;
  feedback.textContent = text;
  feedback.dataset.tone = tone;
  if (text && !reducedMotion.matches && !document.hidden) {
    feedbackMotion = feedback.animate(
      [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
      { duration: 165, easing: 'cubic-bezier(.22, .65, .3, 1)' },
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
  const animate = !reducedMotion.matches && !document.hidden;
  const previous = animate ? headingSnapshot(target) : null;
  clearHeadingMotion();
  update();
  if (!animate) return;

  let departure;
  if (previous) {
    const { snapshot, opacity, transform } = previous;
    target.before(snapshot);
    departure = snapshot.animate(
      [{ opacity, transform }, { opacity: 0, transform: 'translateY(-3px)' }],
      { duration: 120, easing: 'cubic-bezier(.3, 0, .55, 1)', fill: 'forwards' },
    );
    departure.onfinish = () => {
      snapshot.remove();
      if (headingMotion?.departure === departure) headingMotion.snapshot = null;
    };
  }

  const arrival = target.animate(
    [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: 185, delay: previous ? 55 : 0, easing: 'cubic-bezier(.22, .65, .3, 1)', fill: 'backwards' },
  );
  headingMotion = { target, arrival, departure, snapshot: previous?.snapshot };
  arrival.onfinish = () => { if (headingMotion?.arrival === arrival) headingMotion = null; };
}

function fitCountry(text) {
  const tracking = .06 * Math.max(0, text.length - 1);
  // Measure at a fixed size to keep the same line box as names change.
  titleMetrics.font = '800 100px Manrope, system-ui, sans-serif';
  const textUnits = Math.max(2.98, titleMetrics.measureText(text).width / 100 - tracking + .24);
  countryLabel.style.setProperty('--country-units', textUnits);
}

function showHeading(lead, text, tone = '') {
  const newCountry = text !== countryLabel.textContent;
  if (!newCountry && lead === intro.textContent && tone === (intro.dataset.tone ?? '')) return;
  const update = () => {
    intro.textContent = lead;
    intro.dataset.tone = tone;
    if (newCountry) {
      countryLabel.textContent = text;
      fitCountry(text);
    }
  };
  if (!newCountry && headingMotion?.target === questionView) update();
  else transitionHeading(newCountry ? questionView : intro, update);
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
  const hold = { step, remaining: CORRECT_ANSWER_PAUSE, timer: null };
  if (!reducedMotion.matches) {
    hold.marker = document.createElement('span');
    hold.marker.className = 'progress-hold';
    step.append(hold.marker);
    step.setAttribute('data-holding', '');
    hold.animation = hold.marker.animate(
      [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      { duration: CORRECT_ANSWER_PAUSE, fill: 'both' },
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

function showQuestion() {
  phase = 'question';
  showingHint = false;
  hintButton.setAttribute('aria-expanded', 'false');
  showHeading('Найди на глобусе', deck[index].name);
  progressLabel.textContent = `${index + 1} из ${ROUND_LENGTH}`;
  steps.forEach((step, i) => {
    step.dataset.state = results[i] ?? (i === index ? 'current' : 'waiting');
  });
  hintButton.hidden = false;
  skipButton.hidden = false;
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
    showHeading('Верно!', question.name, 'correct');
    startAnswerHold();
  } else {
    globe.paint(id, 'wrong');
    hintButton.setAttribute('aria-expanded', 'false');
    showingHint = false;
    message('Пока мимо. Попробуй ещё раз.', 'wrong');
  }
}

function settle(result) {
  phase = 'answer';
  results[index] = result;
  played.add(deck[index].id);
  steps[index].dataset.state = result;
  hintButton.hidden = true;
  skipButton.hidden = true;
  nextButton.hidden = result === 'found';
  nextButton.firstElementChild.textContent = index === ROUND_LENGTH - 1 ? 'Мой результат' : 'Следующее задание';
  message();
  globe.setGuessEnabled(false);
}

function showSummary() {
  phase = 'summary';
  const found = results.filter(result => result === 'found').length;
  showHeading('Твой результат', `${found} из ${ROUND_LENGTH}`);
  nextButton.hidden = false;
  nextButton.firstElementChild.textContent = 'Сыграть ещё';
  progressLabel.textContent = `${ROUND_LENGTH} из ${ROUND_LENGTH}`;
  globe.paint();
  message();
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
  showingHint = !showingHint;
  hintButton.setAttribute('aria-expanded', String(showingHint));
  globe.paint();
  message(showingHint ? deck[index].hint : '');
});

skipButton.addEventListener('click', () => {
  const keyboard = skipButton.matches(':focus-visible');
  const question = deck[index];
  settle('skipped');
  showHeading('Правильный ответ', question.name);
  globe.paint(question.id, 'reveal');
  globe.goTo({ lon: question.lon, lat: question.lat, zoom: 1.05 });
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

zoomIn.addEventListener('click', () => globe.zoomBy(1.25));
zoomOut.addEventListener('click', () => globe.zoomBy(1 / 1.25));
element('reset').addEventListener('click', globe.reset);

fitCountry(countryLabel.textContent);
showQuestion();
