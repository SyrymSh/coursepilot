import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const sandbox = { URL };
runInNewContext(readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8'), sandbox);
const { courseUrl, courseSlug, courseOverviewPath, completedHeading, quizPath, quizOutcome, manualActivityReason, resetQuizLaunch, connectionState, lessonPath, nextLabel, attemptLabel, videoSeconds, activeSeconds, validateAnswers } = sandbox.__COURSEPILOT_TEST__;

test('connection state fails closed and preserves whether this page previously had an owned subject', () => {
  const context = { subjectId: 'owned', enabled: true, allowAI: true };
  assert.equal(connectionState({ ok: true, context }).context, context);
  assert.equal(connectionState({ ok: true, context }).managedBefore, true);
  for (const response of [{ ok: false, error: 'Extension disconnected' }, undefined, { ok: true }, { ok: true, context: null }]) {
    const disconnected = connectionState(response, true);
    assert.equal(disconnected.context, null);
    assert.equal(disconnected.managedBefore, true);
    assert.notEqual(disconnected.connectionNotice, '');
  }
  assert.match(connectionState({ ok: true, context: null }, true).connectionNotice, /больше не связана/u);
  assert.equal(connectionState({ ok: false, error: 'Extension disconnected' }, true).connectionNotice, 'Extension disconnected');
  assert.equal(connectionState({ ok: true, context: null }).managedBefore, false);
  assert.equal(connectionState({ ok: false }).managedBefore, false);
});

test('coach and interactive widgets are recognized manual activities and navigable course items', () => {
  const coach = '/learn/packt-foundations-of-selenium-webdriver-and-java-for-automation-j6khz/coach/vI2MT/running-first-selenium-script-with-set-up-instructions';
  const widget = '/learn/foundations-of-cybersecurity/ungradedWidget/l9B7s/explore-keep-organizations-secure';
  assert.match(manualActivityReason(coach), /Coursera Coach.*ручного ответа/u);
  assert.match(manualActivityReason(widget), /Интерактивное задание.*ручной работы/u);
  for (const route of [coach, widget]) {
    assert.equal(lessonPath(route), true);
    assert.equal(quizPath(route), false, 'Interactive activities must not be treated as answerable quizzes');
  }
  for (const route of ['/learn/course/coach/', '/learn/course/ungradedWidget/', '/learn/course/coach-other/id', '/other/learn/course/coach/id', '/learn/course/quiz/id']) {
    assert.equal(manualActivityReason(route), '');
  }
  for (const route of ['/learn/course/coach/', '/learn/course/ungradedWidget/', '/other/learn/course/coach/id']) assert.equal(lessonPath(route), false);
});

test('explicit resume clears stalled launch and loading guards without clearing processed attempts', () => {
  const attempts = new Map([['quiz-key', 'submitted']]);
  const state = { quizLaunch: 10_000, quizLoadingSince: 20_000, attempts, quizBusy: true, quizFingerprint: 'quiz-key' };
  resetQuizLaunch(state);
  assert.equal(state.quizLaunch, null);
  assert.equal(state.quizLoadingSince, null);
  assert.equal(state.attempts, attempts);
  assert.equal(state.attempts.get('quiz-key'), 'submitted');
  assert.equal(state.quizBusy, true);
  assert.equal(state.quizFingerprint, 'quiz-key');
});

test('known iframe intro requests Continue without AI or marking the material complete', async () => {
  const url = 'https://www.coursera.org/learn/foundations-of-cybersecurity/ungradedWidget/l9B7s/explore-keep-organizations-secure';
  const source = 'https://d10o6em2qtnr4q.cloudfront.net/assets/d96617fd0cc347daaf2a8420f66905f1/tmp/S30P001-security-analysts-en/index.html';
  for (const enabled of [true, false]) {
    const app = runtimeFixture({ ok: true, context: { subjectId: 'fixture', enabled } }, { widget: { url, source } });
    await new Promise(setImmediate);
    assert.equal(app.messages.filter((message) => message.type === 'CONTENT_WIDGET_CONTINUE').length, enabled ? 1 : 0);
    assert.equal(app.messages.filter((message) => message.type.startsWith('AI_')).length, 0);
    assert.equal(app.nextClicks(), 0);
    if (enabled) {
      app.sample(); await new Promise(setImmediate);
      assert.match(app.messages.filter((message) => message.type === 'CONTENT_SAMPLE').at(-1).page.reason, /Continue.*не означает завершение/u);
    }
  }
});

test('quiz routes include assignment-submission without matching projects or unrelated paths', () => {
  for (const route of ['/learn/course/assignment-submission/id/title', '/learn/course/assignment-submission/id/title/attempt', '/learn/course/quiz/id/title', '/learn/course/exam/id']) assert.equal(quizPath(route), true);
  for (const route of ['/learn/course/assignment/id/title', '/learn/course/peer/id', '/learn/course/assignment-submission-other/id', '/learn/course/assignment-submission/', '/other/learn/course/quiz/id']) assert.equal(quizPath(route), false);
});

test('assignment controls recognize start/resume and next item but not retakes or submission', () => {
  for (const label of ['Resume assignment', 'Start assignment', 'Continue quiz', 'Продолжить задание']) assert.equal(attemptLabel(label), true);
  for (const label of ['Retake assignment', 'Start new attempt', 'Submit assignment', 'I understand', 'Help me practice']) assert.equal(attemptLabel(label), false);
  for (const label of ['Go to next item', 'Go to the next item', 'Next', 'Следующий материал']) assert.equal(nextLabel(label), true);
  for (const label of ['Submit and go to next item', 'Previous item', 'Next attempt']) assert.equal(nextLabel(label), false);
});

test('only explicit successful quiz results allow advancing', () => {
  for (const label of ['You passed!', 'Practice assignment completed', 'Задание успешно завершено']) assert.equal(quizOutcome(label), 'passed');
  for (const label of ['You did not pass', 'Failed', 'Тест не пройден']) assert.equal(quizOutcome(label), 'failed');
  for (const label of ['Submitted', 'Grade: 100%', 'Unlimited attempts', 'Not completed', 'If you passed, continue', 'Spot the Phish']) assert.equal(quizOutcome(label), null);
});

test('course discovery accepts actual Coursera course links and rejects lookalikes and lesson URLs', () => {
  assert.equal(courseUrl('/learn/secure-course/?tracking=123'), 'https://www.coursera.org/learn/secure-course');
  assert.equal(courseUrl('https://coursera.org/learn/course'), 'https://coursera.org/learn/course');
  for (const value of ['https://coursera.org.evil.example/learn/course', 'https://evil.example/learn/course', 'javascript:alert(1)', 'http://www.coursera.org/learn/course', '/learn/course/lecture/id']) {
    assert.equal(courseUrl(value), null);
  }
  assert.equal(courseSlug('https://www.coursera.org/learn/course/lecture/id/title'), 'course');
});

test('completion detection requires an explicit course heading and a course-scoped route', () => {
  assert.equal(completedHeading("Congratulations! You've completed this course!"), true);
  assert.equal(completedHeading('Course completed'), true);
  assert.equal(completedHeading('Курс успешно завершён'), true);
  assert.equal(completedHeading('This module explains how to get a course completed quickly'), false);
  assert.equal(completedHeading('Lesson complete'), false);
  assert.equal(courseOverviewPath('/learn/example/home'), true);
  assert.equal(courseOverviewPath('/learn/example/home/week/1'), true);
  assert.equal(courseOverviewPath('/learn/example/lecture/id/course-completed'), false);
});

const video = (overrides = {}) => ({
  wall: 10_000, monotonic: 10_000, identity: 'video-1', media: 10,
  playing: true, seeking: false, interrupted: false, ended: false, rate: 1,
  ...overrides,
});

test('video accounting accepts actual 1x playback including the final partial interval', () => {
  assert.equal(videoSeconds(video(), video({ wall: 20_000, monotonic: 20_000, media: 20 })), 10);
  assert.equal(videoSeconds(video(), video({ wall: 20_000, monotonic: 20_000, media: 16, ended: true, playing: false })), 6);
  assert.equal(videoSeconds(null, video()), 0);
});

test('video accounting excludes seeks, throttled long intervals, clock jumps and pauses', () => {
  const valid = { wall: 20_000, monotonic: 20_000, media: 20 };
  for (const overrides of [
    { seeking: true }, { interrupted: true }, { media: 100 }, { media: 5 },
    { identity: 'video-2' }, { rate: 2 }, { playing: false },
    { wall: 60_000, monotonic: 60_000, media: 60 }, { monotonic: 12_000 },
  ]) assert.equal(videoSeconds(video(), video({ ...valid, ...overrides })), 0);
  assert.equal(videoSeconds(video({ playing: false }), video(valid)), 0);
});

test('reading needs a focused interval, explicit start, recent activity and no sleep gap', () => {
  const previous = { wall: 10_000, monotonic: 10_000, foreground: true };
  const current = { wall: 20_000, monotonic: 20_000, foreground: true };
  assert.equal(activeSeconds(previous, current, 14_000, 14_000), 6);
  assert.equal(activeSeconds(previous, current, 1_000, 1_000), 10);
  assert.equal(activeSeconds(previous, { ...current, foreground: false }, 1_000, 1_000), 0);
  assert.equal(activeSeconds(previous, current, 1_000, -30_000), 5);
  assert.equal(activeSeconds(previous, current, 1_000, -40_000), 0);
  assert.equal(activeSeconds(previous, { ...current, wall: 120_000 }, 1_000, 110_000), 0);
  assert.equal(activeSeconds(previous, { ...current, monotonic: 16_000 }, 1_000, 1_000), 0);
});

const quiz = { questions: [
  { id: 'q-1', multiple: false, options: [{ id: 'o-1' }, { id: 'o-2' }] },
  { id: 'q-2', multiple: true, options: [{ id: 'o-1' }, { id: 'o-2' }, { id: 'o-3' }] },
] };

test('answers are accepted only with complete unique question IDs and valid option membership', () => {
  const valid = [{ questionId: 'q-1', optionIds: ['o-1'] }, { questionId: 'q-2', optionIds: ['o-1', 'o-3'] }];
  assert.equal(validateAnswers(quiz, valid), true);
  for (const answer of [
    null, [], valid.slice(0, 1), [valid[0], valid[0]],
    [{ questionId: 'q-1', optionIds: ['o-1', 'o-2'] }, valid[1]],
    [valid[0], { questionId: 'q-2', optionIds: ['o-1', 'o-1'] }],
    [valid[0], { questionId: 'q-2', optionIds: ['unknown'] }],
    [valid[0], { questionId: '__proto__', optionIds: ['o-1'] }],
    [valid[0], { questionId: 'q-2', optionIds: [] }],
  ]) assert.equal(validateAnswers(quiz, answer), false);
});

function runtimeFixture(initialResponse, { cover = false, attestation = false, attestationLabel = 'I certify this is my own work and accept the Honor Code.', honorForm = null, extraAttestation = false, disabledSubmit = false, stored = new Map(), selected = false, feedback = null, route = 'attempt', confirmation = null, widget = null } = {}) {
  const created = [];
  const makeElement = (tag = 'div', content = '') => {
    const attributes = new Map();
    const element = {
      tag, textContent: content, isConnected: true, children: [], hidden: false,
      getAttribute: (name) => attributes.get(name) || null,
      setAttribute: (name, value) => attributes.set(name, value),
      closest: () => null, matches: () => false, querySelector: () => null, querySelectorAll: () => [],
      getClientRects() { return this.hidden ? [] : [{}]; }, addEventListener: () => {},
      append(...children) { this.children.push(...children); },
      attachShadow() { this.shadow = makeElement('shadow'); return this.shadow; },
    };
    created.push(element);
    return element;
  };
  const group = makeElement('fieldset');
  const legend = makeElement('legend', 'Choose an option');
  group.querySelector = () => legend;
  let answerClicks = 0;
  const inputs = ['Option A', 'Option B'].map((label) => Object.assign(makeElement('input'), {
    type: 'radio', name: 'question', checked: false, disabled: false, labels: [makeElement('label', label)],
    closest: (selector) => selector.startsWith('[hidden]') ? null : group,
    click() { answerClicks += 1; for (const input of inputs) input.checked = false; this.checked = true; },
  }));
  inputs[0].checked = selected;
  const main = makeElement('main');
  let launchClicks = 0;
  let submitClicks = 0;
  let nextClicks = 0;
  let attestationClicks = 0;
  let confirmationClicks = 0;
  let confirmationVisible = confirmation?.visible === true;
  let failWrites = false;
  let result = null;
  const honorBlock = makeElement('div');
  honorBlock.hidden = honorForm?.hidden === true;
  honorBlock.closest = (selector) => selector.startsWith('fieldset') && honorForm?.inQuestion ? group : null;
  const honorHeading = makeElement('h3', 'Coursera Honor Code');
  const honorStatement = makeElement('p', honorForm?.statement ?? 'By clicking Submit, you confirm this work is your own. Submitting work created with AI tools may result in course failure or account deactivation according to Coursera Honor Code policy.');
  const honor = Object.assign(makeElement('input'), {
    type: 'checkbox', checked: false, disabled: honorForm?.disabled === true, labels: [makeElement('label', attestationLabel)],
    matches: (selector) => selector === 'input[type="checkbox"]',
    closest: (selector) => selector === '[data-testid="HonorCodeAgreement"]' && honorForm ? honorBlock : null,
    click() { attestationClicks += 1; if (!honorForm?.inert) this.checked = !this.checked; },
  });
  const otherAttestation = Object.assign(makeElement('input'), { type: 'checkbox', checked: false, disabled: false, labels: [makeElement('label', 'I agree to different terms')] });
  honorBlock.querySelectorAll = (selector) => selector === 'h3' ? [honorHeading] : selector === 'p' ? [honorStatement] :
    selector === 'input[type="checkbox"],[role="checkbox"]' ? honorForm?.duplicate ? [honor, otherAttestation] : [honor] : [];
  const submit = Object.assign(makeElement('button', 'Submit'), { type: 'submit', disabled: disabledSubmit, click: () => { submitClicks += 1; confirmationVisible = Boolean(confirmation); } });
  const confirmationHeading = makeElement('h2', confirmation?.title ?? 'Ready to submit?');
  const confirmationSubmit = Object.assign(makeElement('button', 'Submit'), { type: 'button', disabled: confirmation?.disabled === true,
    click() { confirmationClicks += 1; if (!confirmation?.inert) confirmationVisible = false; } });
  const confirmationCancel = makeElement('button', 'Cancel');
  const confirmationDialog = makeElement('section', `${confirmationHeading.textContent} Submit Cancel${confirmation?.extraText ? ' I accept other terms' : ''}`);
  confirmationDialog.querySelectorAll = (selector) => selector === 'h1,h2,h3,[role="heading"]' ? [confirmationHeading] :
    selector === 'button' ? [confirmationSubmit, confirmationCancel] : [];
  confirmationDialog.querySelector = () => confirmation?.extraInput ? honor : null;
  const next = Object.assign(makeElement('button', 'Go to next item'), { type: 'button', click: () => { nextClicks += 1; } });
  const resume = Object.assign(makeElement('button', 'Resume assignment'), { type: 'button', click: () => { launchClicks += 1; } });
  const feedbackGrade = makeElement('h2', feedback?.grade ?? 'Your grade: 100%');
  const feedbackAlert = makeElement('div');
  const feedbackBanner = makeElement('div', feedback?.text ?? 'Your grade: 100% Your latest: 100% Your highest: 100% To pass you need at least 75%. We keep your highest score. Next item');
  feedbackBanner.hidden = feedback?.hidden === true;
  feedbackBanner.closest = (selector) => selector === '[role="alert"]' ? feedback?.alert === false ? null : feedbackAlert : feedback?.inQuestion ? group : null;
  feedbackBanner.querySelectorAll = (selector) => selector === 'h2' ? feedback?.ambiguous ? [feedbackGrade, feedbackGrade] : [feedbackGrade] : [];
  main.querySelectorAll = (selector) => {
    if (selector === 'iframe[data-testid="widget-iframe"]' && widget?.source) return [Object.assign(makeElement('iframe'), { getAttribute: () => widget.source })];
    if (selector === 'input[type="radio"],input[type="checkbox"]') return cover ? [] : [...inputs, ...(attestation ? [honor] : [])];
    if (selector === 'input[type="checkbox"]') return attestation && !cover ? [honor, ...(extraAttestation ? [otherAttestation] : [])] : [];
    if (selector === '[data-testid="HonorCodeAgreement"]') return honorForm ? [honorBlock] : [];
    if (selector === 'button,a[href]') return cover ? [resume] : [];
    if (selector === 'button,input[type="submit"]') return cover ? [] : [submit];
    if (selector === 'a[href],button') return [next];
    if (selector === 'h1,h2,[role="status"]') return result ? [result] : [];
    if (selector === '[data-testid="AssignmentViewTopBanner"]') return feedback?.missing ? [] : feedback ? [feedbackBanner] : [];
    return [];
  };
  const document = {
    title: 'Quiz fixture', body: main, documentElement: makeElement('html'), visibilityState: 'visible',
    hasFocus: () => true, getElementById: () => null, addEventListener: () => {},
    createElement: makeElement, querySelector: () => main,
    querySelectorAll: (selector) => selector.startsWith('[role="dialog"]') && confirmationVisible ? [confirmationDialog] : [],
  };
  const timers = new Map();
  const intervals = new Map();
  const storage = stored;
  const messages = [];
  let timerId = 0;
  let response = initialResponse;
  let clock = 100_000;
  let answer;
  let command;
  const runtime = {
    id: 'fixture-extension', onMessage: { addListener(listener) { command = listener; } },
    sendMessage(message, callback) {
      messages.push(message);
      if (message.type === 'AI_QUIZ') answer = () => callback({ ok: true, autoSubmit: response.context?.autoSubmit === true,
        answers: message.quiz.questions.map((question) => ({ questionId: question.id, optionIds: [question.options[0].id] })),
      });
      else if (message.type === 'CONTENT_WIDGET_CONTINUE') callback(widget?.reply ?? { ok: true, status: 'opened' });
      else callback(response);
    },
  };
  runInNewContext(readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8'), {
    URL, document, window: { addEventListener: () => {} }, chrome: { runtime },
    location: new URL(widget?.url ?? `https://www.coursera.org/learn/fixture/assignment-submission/id/quiz/${route}`),
    Date: { now: () => clock }, performance: { now: () => clock }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => { if (failWrites) throw new Error('Storage unavailable'); storage.set(key, value); }, removeItem: (key) => storage.delete(key) },
    setTimeout: (callback, milliseconds) => {
      const id = ++timerId;
      timers.set(id, callback);
      if (milliseconds === 100) queueMicrotask(() => { if (timers.delete(id)) callback(); });
      return id;
    }, clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, milliseconds) => intervals.set(milliseconds, callback), queueMicrotask,
  });
  return {
    messages, inputs, storage, honor, submit, confirmationSubmit,
    sample: () => intervals.get(10_000)(),
    checkNavigation: () => intervals.get(1_000)(),
    replyWith(value) { response = value; },
    releaseAI: () => answer(),
    run: (explicit = true) => command({ type: 'COURSE_COMMAND', action: 'run', explicit }, { id: runtime.id }, () => {}),
    advance: (milliseconds) => { clock += milliseconds; },
    launchClicks: () => launchClicks,
    submitClicks: () => submitClicks,
    confirmationClicks: () => confirmationClicks,
    failStorageWrites: () => { failWrites = true; },
    nextClicks: () => nextClicks,
    attestationClicks: () => attestationClicks,
    showCover: () => { cover = true; },
    setOutcome: (heading) => { result = makeElement('h2', heading); },
    answerClicks: () => answerClicks,
    widget: () => created.find((element) => element.id === 'coursepilot-helper'),
    displayedText: () => created.map((element) => element.textContent).join('\n'),
  };
}

const flushRuntime = () => new Promise((resolve) => setImmediate(resolve));

test('automatic quiz submission confirms Ready to submit exactly once and retains the guard after reload', async () => {
  const response = { ok: true, context: { subjectId: 'owned', enabled: true, allowAI: true, autoSubmit: true } };
  const app = runtimeFixture(response, { confirmation: {} });
  await flushRuntime();
  app.releaseAI();
  await flushRuntime();
  assert.equal(app.submitClicks(), 1);
  assert.equal(app.confirmationClicks(), 1);
  app.sample();
  await flushRuntime();
  assert.equal(app.confirmationClicks(), 1);
  const restored = runtimeFixture(response, { stored: app.storage, selected: true, confirmation: { visible: true } });
  await flushRuntime();
  restored.sample();
  await flushRuntime();
  assert.equal(restored.confirmationClicks(), 0);
  assert.equal(restored.submitClicks(), 0);
  assert.equal(restored.messages.filter(({ type }) => type === 'AI_QUIZ').length, 0);
});

test('submission confirmation waits for availability and does not accept unknown dialog text or controls', async () => {
  const response = { ok: true, context: { subjectId: 'owned', enabled: true, allowAI: true, autoSubmit: true } };
  for (const confirmation of [{ title: 'Accept new terms?' }, { extraText: true }, { extraInput: true }, { disabled: true }]) {
    const app = runtimeFixture(response, { confirmation });
    await flushRuntime();
    app.releaseAI();
    await flushRuntime();
    assert.equal(app.submitClicks(), 1);
    assert.equal(app.confirmationClicks(), 0);
    if (confirmation.disabled) {
      app.confirmationSubmit.disabled = false;
      app.checkNavigation();
      await flushRuntime();
      assert.equal(app.confirmationClicks(), 1);
    }
  }
});

test('submission confirmation obeys current auto-submit permission and successful persistence', async () => {
  const response = { ok: true, context: { subjectId: 'owned', enabled: true, allowAI: true, autoSubmit: true } };
  const original = runtimeFixture(response);
  await flushRuntime();
  original.releaseAI();
  await flushRuntime();
  for (const context of [{ ...response.context, enabled: false }, { ...response.context, allowAI: false }, { ...response.context, autoSubmit: false }]) {
    const app = runtimeFixture({ ok: true, context }, { stored: new Map(original.storage), confirmation: { visible: true } });
    await flushRuntime();
    app.sample();
    await flushRuntime();
    assert.equal(app.confirmationClicks(), 0);
  }
  const app = runtimeFixture(response, { stored: new Map(original.storage), confirmation: { visible: true, disabled: true } });
  await flushRuntime();
  app.confirmationSubmit.disabled = false;
  app.failStorageWrites();
  app.sample();
  await flushRuntime();
  assert.equal(app.confirmationClicks(), 0);
  assert.match(app.displayedText(), /сохранить подтверждение отправки/u);
});

test('inert submission confirmation times out without clicking the same final Submit again', async () => {
  const response = { ok: true, context: { subjectId: 'owned', enabled: true, allowAI: true, autoSubmit: true } };
  const app = runtimeFixture(response, { confirmation: { inert: true } });
  await flushRuntime();
  app.releaseAI();
  await flushRuntime();
  app.advance(120_001);
  app.sample();
  await flushRuntime();
  assert.equal(app.confirmationClicks(), 1);
  assert.equal(app.submitClicks(), 1);
  assert.match(app.displayedText(), /не обработала подтверждение/u);
});

test('runtime keeps a disconnected owned widget visible and prevents pending AI from changing answers', async () => {
  const active = { ok: true, context: { subjectId: 'owned', enabled: true, allowAI: true, autoSubmit: false } };
  for (const lost of [{ ok: true, context: null }, { ok: false, error: 'Extension disconnected' }]) {
    const app = runtimeFixture(active);
    await flushRuntime();
    assert.equal(app.messages.filter((message) => message.type === 'AI_QUIZ').length, 1);
    app.replyWith(lost);
    app.sample();
    await flushRuntime();
    assert.equal(app.widget().hidden, false);
    assert.match(app.displayedText(), /CoursePilot не управляет вкладкой/u);
    assert.match(app.displayedText(), lost.ok ? /больше не связана/u : /Extension disconnected/u);
    app.releaseAI();
    await flushRuntime();
    assert.equal(app.answerClicks(), 0);
    assert.equal(app.inputs.some((input) => input.checked), false);
    app.replyWith(active);
    app.sample();
    await flushRuntime();
    assert.equal(app.messages.filter((message) => message.type === 'AI_QUIZ').length, 1, 'Recovery must not silently repeat a pending request');
    assert.match(app.displayedText(), /Предыдущий запрос ИИ был прерван/u);
  }
});

test('runtime does not claim unrelated unowned tabs or send their quiz to AI', async () => {
  const app = runtimeFixture({ ok: true, context: null });
  await flushRuntime();
  assert.equal(app.widget(), undefined);
  assert.equal(app.messages.some((message) => message.type === 'AI_QUIZ'), false);
  assert.equal(app.answerClicks(), 0);
});

test('runtime retries a stalled launch only after an explicit resume, never a scheduler wakeup', async () => {
  const active = { ok: true, context: { subjectId: 'owned', enabled: true, allowAI: true } };
  const app = runtimeFixture(active, { cover: true });
  await flushRuntime();
  assert.equal(app.launchClicks(), 1);
  app.advance(21_000);
  app.sample();
  await flushRuntime();
  assert.match(app.displayedText(), /Попытка не открылась/u);
  app.run(false);
  await flushRuntime();
  assert.equal(app.launchClicks(), 1);
  app.run(true);
  await flushRuntime();
  assert.equal(app.launchClicks(), 2);
  app.sample();
  await flushRuntime();
  assert.equal(app.launchClicks(), 2);
  assert.equal(app.messages.some((message) => message.type === 'AI_QUIZ'), false);
});

const activeQuizContext = (autoSubmit = true, autoHonorCode = false) => ({ ok: true, context: { subjectId: 'owned', enabled: true, allowAI: true, autoSubmit, autoHonorCode } });
const quizCalls = (app) => app.messages.filter((message) => message.type === 'AI_QUIZ').length;
const lastSample = (app) => app.messages.filter((message) => message.type === 'CONTENT_SAMPLE').at(-1);

test('numeric result parser requires an exact grade label and a single valid passing threshold', () => {
  const { quizGradeOutcome } = sandbox.__COURSEPILOT_TEST__;
  for (const [grade, threshold, result] of [['100', '75', 'passed'], ['75', '75', 'passed'], ['74.99', '75', 'failed'], ['75,5', '75.5', 'passed']]) {
    assert.equal(quizGradeOutcome(`Your grade: ${grade}%`, `Your latest: 0% Your highest: 100% To pass you need at least ${threshold}%.`), result);
  }
  for (const [grade, summary] of [
    ['Grade: 100%', 'To pass you need at least 75%.'],
    ['Your grade: 100%', 'Your highest: 100%'],
    ['Your grade: 100%', 'To pass you need at least 75%. To pass you need at least 80%.'],
    ['Your grade: 101%', 'To pass you need at least 75%.'],
    ['Your grade: 100%', 'To pass you need at least 101%.'],
    ['Your grade: -1%', 'To pass you need at least 75%.'],
    ['Your grade: 100% pending', 'To pass you need at least 75%.'],
    ['Your grade: 100%', `${'x'.repeat(1_001)} To pass you need at least 75%.`],
  ]) assert.equal(quizGradeOutcome(grade, summary), null);
});

test('feedback banner advances a passed quiz once without AI, submission, or opening a new attempt', async () => {
  const app = runtimeFixture({ ok: true, context: { subjectId: 'owned', enabled: true, allowAI: false } }, { feedback: {}, route: 'view-feedback', cover: true });
  await flushRuntime();
  assert.equal(app.nextClicks(), 1);
  app.advance(21_000);
  app.checkNavigation();
  app.run(true);
  await flushRuntime();
  assert.equal(app.nextClicks(), 1);
  assert.equal(app.launchClicks(), 0);
  assert.equal(app.submitClicks(), 0);
  assert.equal(quizCalls(app), 0);
});

test('feedback with a failing grade stops even if the banner includes a higher previous score', async () => {
  const app = runtimeFixture(activeQuizContext(), { feedback: { grade: 'Your grade: 50%' }, route: 'view-feedback' });
  await flushRuntime();
  assert.equal(app.nextClicks(), 0);
  assert.equal(quizCalls(app), 0);
  assert.match(app.displayedText(), /тест не пройден/u);
});

test('unconfirmed feedback never falls through to AI, submission, or launching another attempt', async () => {
  for (const feedback of [{ missing: true }, { hidden: true }, { alert: false }, { inQuestion: true }, { ambiguous: true }, { text: 'Your grade: 100%' }]) {
    const app = runtimeFixture(activeQuizContext(), { feedback, route: 'view-feedback', cover: true });
    await flushRuntime();
    assert.equal(app.nextClicks(), 0, JSON.stringify(feedback));
    assert.equal(app.launchClicks(), 0);
    assert.equal(app.submitClicks(), 0);
    assert.equal(quizCalls(app), 0);
    assert.match(app.displayedText(), /страница результатов/u);
  }
});

test('a grade outside the feedback route cannot complete an active quiz and paused feedback cannot navigate', async () => {
  const active = runtimeFixture(activeQuizContext(), { feedback: {} });
  await flushRuntime();
  assert.equal(active.nextClicks(), 0);
  assert.equal(quizCalls(active), 1);
  const paused = runtimeFixture({ ok: true, context: { subjectId: 'owned', enabled: false, allowAI: true } }, { feedback: {}, route: 'view-feedback' });
  await flushRuntime();
  assert.equal(paused.nextClicks(), 0);
  assert.equal(quizCalls(paused), 0);
});

async function selectedQuizFixture(options = {}, autoSubmit = true, autoHonorCode = false) {
  const app = runtimeFixture(activeQuizContext(autoSubmit, autoHonorCode), options);
  await flushRuntime();
  app.releaseAI();
  await flushRuntime();
  return app;
}

test('selected answers wait for enabled Submit and send once without another AI request', async () => {
  const app = await selectedQuizFixture({ disabledSubmit: true });
  assert.equal(app.answerClicks(), 1);
  assert.equal(app.submitClicks(), 0);
  assert.match(app.displayedText(), /Ожидается доступная кнопка отправки/u);
  app.sample();
  await flushRuntime();
  assert.equal(lastSample(app).page.reason, undefined);
  app.submit.disabled = false;
  app.sample();
  await flushRuntime();
  assert.equal(app.submitClicks(), 1);
  app.sample();
  await flushRuntime();
  assert.equal(app.submitClicks(), 1);
  assert.equal(app.answerClicks(), 1);
  assert.equal(quizCalls(app), 1);
  const stored = [...app.storage.values()].find((value) => value.startsWith('{'));
  const record = JSON.parse(stored);
  assert.equal(record.status, 'submitted');
  assert.deepEqual(record.answers, [{ questionId: 'q-1', optionIds: ['o-1'] }]);
});

test('attestation stays untouched and manual confirmation can release the waiting submit', async () => {
  const app = await selectedQuizFixture({ attestation: true });
  assert.equal(app.honor.checked, false);
  assert.equal(app.attestationClicks(), 0);
  assert.equal(app.submitClicks(), 0);
  app.sample();
  await flushRuntime();
  assert.equal(lastSample(app).page.reason, undefined);
  app.honor.checked = true;
  app.sample();
  await flushRuntime();
  assert.equal(app.submitClicks(), 1);
  assert.equal(app.attestationClicks(), 0);
  assert.equal(quizCalls(app), 1);
});

test('named Coursera Honor Code acknowledgement is recognized without clicking it', async () => {
  const app = await selectedQuizFixture({ attestation: true, attestationLabel: 'I, Test Participant, understand and agree.' });
  assert.equal(app.honor.checked, false);
  assert.equal(app.attestationClicks(), 0);
  assert.equal(app.submitClicks(), 0);
  assert.match(app.displayedText(), /Coursera Honor Code/u);
  app.honor.checked = true;
  app.sample();
  await flushRuntime();
  assert.equal(app.submitClicks(), 1);
  assert.equal(app.attestationClicks(), 0);
  assert.equal(quizCalls(app), 1);
});

const knownHonorForm = { attestation: true, attestationLabel: 'I, Test Participant, understand and agree.', honorForm: {} };

test('opted-in exact Honor Code checkbox is clicked once then submitted on the following check', async () => {
  const app = await selectedQuizFixture(knownHonorForm, true, true);
  assert.equal(app.honor.checked, true);
  assert.equal(app.attestationClicks(), 1);
  assert.equal(app.submitClicks(), 0, 'Wait for the page to process the checkbox before submitting');
  app.sample();
  await flushRuntime();
  assert.equal(app.submitClicks(), 1);
  app.sample();
  await flushRuntime();
  assert.equal(app.submitClicks(), 1);
  assert.equal(app.attestationClicks(), 1);
  assert.equal(quizCalls(app), 1);
});

test('Honor Code automation requires both opt-ins and never accepts changed, unknown, disabled or ambiguous forms', async () => {
  for (const [options, autoSubmit, autoHonorCode] of [
    [knownHonorForm, true, false], [knownHonorForm, false, true],
    [{ ...knownHonorForm, honorForm: null }, true, true],
    [{ ...knownHonorForm, honorForm: { statement: 'Please accept a new policy.' } }, true, true],
    [{ ...knownHonorForm, honorForm: { disabled: true } }, true, true],
    [{ ...knownHonorForm, honorForm: { inQuestion: true } }, true, true],
    [{ ...knownHonorForm, honorForm: { hidden: true } }, true, true],
    [{ ...knownHonorForm, honorForm: { duplicate: true } }, true, true],
    [{ ...knownHonorForm, extraAttestation: true }, true, true],
    [{ ...knownHonorForm, attestationLabel: 'I confirm my identity.' }, true, true],
  ]) {
    const app = await selectedQuizFixture(options, autoSubmit, autoHonorCode);
    app.sample();
    await flushRuntime();
    assert.equal(app.attestationClicks(), 0, JSON.stringify(options));
    assert.equal(app.submitClicks(), 0);
  }
});

test('an ignored checkbox click and a reload never cause repeated Honor Code acknowledgement', async () => {
  const options = { ...knownHonorForm, honorForm: { inert: true } };
  const app = await selectedQuizFixture(options, true, true);
  assert.equal(app.attestationClicks(), 1);
  app.sample();
  await flushRuntime();
  assert.equal(app.attestationClicks(), 1);
  assert.equal(app.submitClicks(), 0);
  const reloaded = runtimeFixture(activeQuizContext(true, true), { ...options, stored: app.storage, selected: true });
  await flushRuntime();
  assert.equal(reloaded.attestationClicks(), 0);
  assert.equal(reloaded.submitClicks(), 0);
  assert.equal(quizCalls(reloaded), 0);
});

test('Honor Code acknowledgement stops if its duplicate guard cannot be saved', async () => {
  class QuotaStore extends Map {
    set(key, value) {
      if (value.includes('"honorCodeAttempted":true')) throw new Error('QuotaExceededError');
      return super.set(key, value);
    }
  }
  const app = await selectedQuizFixture({ ...knownHonorForm, stored: new QuotaStore() }, true, true);
  assert.equal(app.attestationClicks(), 0);
  assert.equal(app.submitClicks(), 0);
  assert.match(app.displayedText(), /защиту от повторной автогалочки/u);
});

test('disabling automatic acknowledgement during an AI request preserves the unchecked checkbox', async () => {
  const app = runtimeFixture(activeQuizContext(true, true), knownHonorForm);
  await flushRuntime();
  app.replyWith(activeQuizContext(true, false));
  app.sample();
  await flushRuntime();
  app.releaseAI();
  await flushRuntime();
  assert.equal(app.attestationClicks(), 0);
  assert.equal(app.submitClicks(), 0);
});

test('manual mode remains observable and enabling autosubmit later uses retained answers', async () => {
  const app = await selectedQuizFixture({}, false);
  assert.equal(app.submitClicks(), 0);
  app.advance(180_000);
  app.sample();
  await flushRuntime();
  assert.equal(lastSample(app).page.reason, undefined);
  assert.match(app.displayedText(), /автоотправка выключена/u);
  app.replyWith(activeQuizContext(true));
  app.sample();
  await flushRuntime();
  assert.equal(app.submitClicks(), 1);
  assert.equal(quizCalls(app), 1);
  assert.equal(app.answerClicks(), 1);
});

test('submitted attempts survive reload and wait for explicit success without reopening or duplicate navigation', async () => {
  const original = await selectedQuizFixture();
  assert.equal(original.submitClicks(), 1);
  const app = runtimeFixture(activeQuizContext(), { cover: true, stored: original.storage });
  await flushRuntime();
  assert.equal(app.launchClicks(), 0);
  assert.equal(app.submitClicks(), 0);
  assert.equal(quizCalls(app), 0);
  app.setOutcome('Grade: 100%');
  app.sample();
  await flushRuntime();
  assert.equal(app.nextClicks(), 0);
  app.setOutcome('You passed!');
  app.sample();
  await flushRuntime();
  assert.equal(app.nextClicks(), 1);
  app.advance(21_000);
  app.checkNavigation();
  app.run(true);
  await flushRuntime();
  assert.equal(app.nextClicks(), 1);
  assert.equal(app.launchClicks(), 0);
  assert.equal(quizCalls(app), 0);
});

test('retained selected payload resumes after reload only when the same answers are still checked', async () => {
  const original = await selectedQuizFixture({ disabledSubmit: true });
  const restored = runtimeFixture(activeQuizContext(), { stored: new Map(original.storage), selected: true });
  await flushRuntime();
  assert.equal(restored.submitClicks(), 1);
  assert.equal(restored.answerClicks(), 0);
  assert.equal(quizCalls(restored), 0);
  const changed = runtimeFixture(activeQuizContext(), { stored: new Map(original.storage), selected: false });
  await flushRuntime();
  assert.equal(changed.submitClicks(), 0);
  assert.equal(changed.answerClicks(), 0);
  assert.equal(quizCalls(changed), 0);
  assert.match(changed.displayedText(), /Вопросы или выбранные ответы изменились/u);
});

test('manual answer edits are neither overwritten nor automatically submitted', async () => {
  const app = await selectedQuizFixture({ disabledSubmit: true });
  app.inputs[0].checked = false;
  app.inputs[1].checked = true;
  app.submit.disabled = false;
  app.sample();
  await flushRuntime();
  assert.equal(app.submitClicks(), 0);
  assert.equal(app.answerClicks(), 1);
  assert.equal(app.inputs[1].checked, true);
  assert.equal(quizCalls(app), 1);
  assert.match(app.displayedText(), /выбранные ответы изменились/u);
});

test('persisted selection is validated again before submitting', async () => {
  const original = await selectedQuizFixture({ disabledSubmit: true });
  for (const corrupt of [
    (record) => { record.answers[0].optionIds = ['unknown']; },
    (record) => { record.quiz.questions[0].prompt = 'A different question'; },
    (record) => { record.answers = null; },
  ]) {
    const stored = new Map(original.storage);
    for (const [key, value] of stored) {
      if (!value.startsWith('{')) continue;
      const record = JSON.parse(value);
      corrupt(record);
      stored.set(key, JSON.stringify(record));
    }
    const restored = runtimeFixture(activeQuizContext(), { stored, selected: true });
    await flushRuntime();
    assert.equal(restored.submitClicks(), 0);
    assert.equal(restored.answerClicks(), 0);
    assert.equal(quizCalls(restored), 0);
    assert.match(restored.displayedText(), /Вопросы или выбранные ответы изменились/u);
  }
});

test('waiting for submit, attestation and result is bounded without repeated requests or clicks', async () => {
  for (const options of [{ disabledSubmit: true }, { attestation: true }, {}]) {
    const app = await selectedQuizFixture(options);
    app.advance(120_001);
    app.sample();
    await flushRuntime();
    app.sample();
    await flushRuntime();
    assert.ok(lastSample(app).page.reason);
    assert.equal(app.submitClicks(), options.disabledSubmit || options.attestation ? 0 : 1);
    assert.equal(app.attestationClicks(), 0);
    assert.equal(quizCalls(app), 1);
  }
});

test('manual submissions and legacy selected status can still observe success', async () => {
  const original = await selectedQuizFixture({}, false);
  original.setOutcome('Practice assignment completed');
  original.sample();
  await flushRuntime();
  assert.equal(original.nextClicks(), 1);
  assert.equal(original.submitClicks(), 0);
  const stored = new Map(original.storage);
  for (const [key, value] of stored) {
    if (value.startsWith('{')) stored.set(key, 'selected');
    if (key.endsWith(':advanced')) stored.delete(key);
  }
  const legacy = runtimeFixture(activeQuizContext(), { stored, selected: true });
  await flushRuntime();
  assert.equal(legacy.submitClicks(), 0);
  assert.equal(quizCalls(legacy), 0);
  assert.match(legacy.displayedText(), /Ответы старой версии/u);
  legacy.setOutcome('You passed!');
  legacy.sample();
  await flushRuntime();
  assert.equal(legacy.nextClicks(), 1);
});
