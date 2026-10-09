import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const VIDEO_URL = 'https://www.coursera.org/learn/fixture/lecture/first/video';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function videoFixture({ present = true, context = {}, playModes = [], readyState = 4, mediaSource = true, dialog = null, videoQuestion = null } = {}) {
  const created = [];
  function element(tag = 'div', content = '') {
    const attributes = new Map();
    const listeners = new Map();
    const node = {
      tag, tagName: tag.toUpperCase(), textContent: content, isConnected: true, hidden: false,
      children: [], dataset: {}, disabled: false, type: tag === 'button' ? 'button' : undefined,
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      closest: () => null, matches: () => false, querySelector: () => null, querySelectorAll: () => [],
      getClientRects() { return this.hidden ? [] : [{}]; },
      addEventListener(name, listener) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(listener);
      },
      removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); return true; },
      emit(type) { this.dispatchEvent({ type, target: this }); },
      append(...children) { this.children.push(...children); for (const child of children) child.parentElement = this; },
      attachShadow() { this.shadow = element('shadow'); return this.shadow; },
    };
    created.push(node);
    return node;
  }
  const allVideos = [];
  function makeVideo(modes = []) {
    const pending = [];
    const video = Object.assign(element('video'), {
      currentSrc: mediaSource ? `https://media.example/video-${allVideos.length}.mp4` : '', src: '',
      currentTime: 0, duration: 30, playbackRate: 1.5, muted: false, defaultMuted: false,
      paused: true, ended: false, seeking: false, readyState, error: null,
      playCalls: 0, pauseCalls: 0, loadCalls: 0, playStates: [], modes: [...modes], pending,
      load() { this.loadCalls += 1; this.error = null; this.paused = true; this.emit('emptied'); },
      play() {
        this.playCalls += 1;
        this.playStates.push({ muted: this.muted, rate: this.playbackRate });
        const mode = this.modes.shift() || 'success';
        if (mode === 'pending') {
          this.paused = false;
          return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        }
        if (mode !== 'success') {
          this.paused = true;
          return Promise.reject(Object.assign(new Error(mode), { name: mode }));
        }
        this.paused = false;
        this.emit('playing');
        return Promise.resolve();
      },
      pause() { this.pauseCalls += 1; this.paused = true; this.emit('pause'); },
      finish() { this.currentTime = this.duration; this.ended = true; this.paused = true; this.emit('ended'); },
      resolvePlay() {
        assert.ok(pending.length, 'Expected a pending video.play() promise');
        this.paused = false;
        pending.shift().resolve();
      },
    });
    allVideos.push(video);
    return video;
  }
  let video = makeVideo(playModes);
  const heading = element('h1', 'Video fixture');
  const navigation = { next: 0, closed: 0, skipped: 0, questionSubmitted: 0 };
  const questionHeading = element('h2', videoQuestion?.title ?? 'Question');
  const questionArea = element('fieldset');
  const questionSubmit = element('button', 'Submit');
  questionSubmit.click = () => { navigation.questionSubmitted += 1; };
  const questionSkip = Object.assign(element('button', 'Skip'), {
    disabled: videoQuestion?.disabled === true,
    click() { navigation.skipped += 1; if (!videoQuestion?.inert) videoQuestion = null; },
  });
  const questionDialog = element('div', `${questionHeading.textContent} Optional video prompt Submit Skip`);
  questionDialog.querySelectorAll = (selector) => selector === 'h2' ? [questionHeading] : selector === 'button' ? [questionSubmit, questionSkip] : [];
  questionDialog.querySelector = (selector) => selector === 'fieldset.rc-VideoQuizQuestionArea' && !videoQuestion?.unknownForm ? questionArea :
    selector === 'button[data-testid="VideoQuizSubmission-Button"]' ? questionSubmit : null;
  const nextButton = Object.assign(element('button', 'Go to next item'), { click() { navigation.next += 1; } });
  const main = element('main');
  main.querySelectorAll = (selector) => {
    if (selector === 'h1') return [heading];
    if (selector === 'video') return present ? [video] : [];
    if (selector === 'a[href],button') return [nextButton];
    return [];
  };
  main.querySelector = (selector) => main.querySelectorAll(selector)[0] || null;

  const modal = element('section');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const modalHeading = element('h2', dialog?.title ?? 'Module complete!');
  const modalCopy = element('p', dialog?.copy ?? 'Great work in completing the module. Here are some highlights:');
  const closeButton = Object.assign(element('button', dialog?.closeLabel ?? 'Close'), {
    disabled: dialog?.closeDisabled === true,
    click() { navigation.closed += 1; dialog = null; modal.isConnected = false; },
  });
  closeButton.setAttribute('aria-label', dialog?.closeLabel ?? 'Close celebration dialog');
  modal.hidden = dialog?.hidden === true;
  modal.textContent = `${modalHeading.textContent} ${modalCopy.textContent} 3 videos 5% of the course is complete Close`;
  modal.querySelectorAll = (selector) => {
    if (selector === 'h2' || selector === 'h1,h2,h3' || selector === 'h2,h3' || selector === 'h1,h2,h3,[role="heading"]') return [modalHeading];
    if (selector === 'button' || selector === 'button,[role="button"]') return [closeButton];
    if (selector === 'button[aria-label="Close celebration dialog"]') return closeButton.getAttribute('aria-label') === 'Close celebration dialog' ? [closeButton] : [];
    if (selector === 'p') return [modalCopy];
    return [];
  };
  modal.querySelector = (selector) => modal.querySelectorAll(selector)[0] || null;
  modalHeading.closest = (selector) => selector.includes('dialog') ? modal : null;
  closeButton.closest = (selector) => selector.includes('dialog') ? modal : null;
  const document = {
    title: 'Video fixture', body: main, documentElement: element('html'), visibilityState: 'visible',
    hasFocus: () => true, getElementById: () => null, addEventListener: () => {}, createElement: element,
    querySelector: (selector) => selector === 'main,[role="main"]' ? main : selector === 'video' && present ? video : null,
    querySelectorAll: (selector) => selector === '[data-testid="playerContainer"] [role="dialog"][data-testid="scroll-container"]' ?
      videoQuestion && !videoQuestion.outsidePlayer ? [questionDialog] : [] :
      selector.includes('[role="dialog"]') && dialog ? [modal] : selector === 'video' && present ? [video] : [],
  };
  const timers = new Map();
  const intervals = new Map();
  const requests = [];
  const storage = new Map();
  let timerId = 0;
  let clock = 100_000;
  let command;
  let response = { ok: true, context: { subjectId: 'owned', enabled: true, allowAI: false, autoDialogue: false, ...context } };
  const runtime = {
    id: 'video-fixture', onMessage: { addListener(listener) { command = listener; } },
    sendMessage(message, callback) { requests.push(message); callback(structuredClone(response)); },
  };
  const location = new URL(VIDEO_URL);
  location.assign = (url) => { location.href = url; };
  runInNewContext(source, {
    URL, document, window: { addEventListener: () => {} }, chrome: { runtime }, location,
    Event: class { constructor(type) { this.type = type; } },
    Date: { now: () => clock }, performance: { now: () => clock }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, at: clock + delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id), setInterval: (callback, ms) => intervals.set(ms, callback), queueMicrotask,
  });
  async function dueTimers() {
    for (let round = 0; round < 20; round += 1) {
      const due = [...timers].filter(([, timer]) => timer.at <= clock);
      if (!due.length) break;
      for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
      await flush();
    }
  }
  return {
    get video() { return video; }, requests, navigation, allVideos,
    notice: () => created.map((node) => node.textContent).join('\n'),
    samples: () => requests.filter((message) => message.type === 'CONTENT_SAMPLE'),
    showVideo() { present = true; },
    replaceVideo(modes = []) {
      const oldVideo = video;
      oldVideo.isConnected = false;
      video = makeVideo(modes);
      return oldVideo;
    },
    replyWith(value) { response = value; },
    async sample() { intervals.get(10_000)(); await flush(); },
    async advance(milliseconds = 1_000) {
      clock += milliseconds;
      await dueTimers();
      intervals.get(1_000)();
      await flush();
      await dueTimers();
    },
    async pause() {
      response = { ...response, context: { ...response.context, enabled: false } };
      command({ type: 'COURSE_COMMAND', action: 'pause' }, { id: runtime.id }, () => {});
      await flush();
    },
    async changePage({ replacement = true } = {}) {
      const oldVideo = video;
      oldVideo.isConnected = false;
      present = replacement;
      video = makeVideo();
      location.href = 'https://www.coursera.org/learn/fixture/lecture/second/next-video';
      intervals.get(1_000)();
      await flush();
      return oldVideo;
    },
  };
}

async function begin(options) {
  const app = videoFixture(options);
  await flush();
  return app;
}

test('video waits for a delayed player without blocking the subject, then starts muted at 1x', async () => {
  const app = await begin({ present: false });
  await app.advance(60_000);
  await app.sample();
  assert.ok(app.samples().every(({ page }) => !page.reason));
  assert.equal(app.navigation.next, 0);
  app.showVideo();
  await app.advance();
  assert.equal(app.video.playCalls, 1);
  assert.deepEqual(app.video.playStates, [{ muted: true, rate: 1 }]);
  assert.equal(app.video.muted, true);
  assert.equal(app.video.playbackRate, 1);
  assert.equal(app.video.paused, false);
  assert.equal(app.navigation.next, 0);
});

test('video loading is bounded rather than leaving the subject active forever', async () => {
  const app = await begin({ present: false });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await app.advance(120_001);
    await app.sample();
    if (attempt < 2) assert.equal(app.samples().at(-1).page.reason, undefined);
  }
  assert.ok(app.samples().at(-1).page.reason, 'An unavailable player must eventually require attention');
  assert.equal(app.navigation.next, 0);
});

test('video resumes pauses and does not advance before the actual ended event', async () => {
  const app = await begin();
  assert.equal(app.video.playCalls, 1);
  assert.equal(app.video.muted, true);
  app.video.currentTime = app.video.duration - 0.01;
  app.video.pause();
  await app.advance(2_001);
  assert.equal(app.video.playCalls, 2);
  assert.equal(app.video.paused, false);
  assert.equal(app.navigation.next, 0);
  app.video.finish();
  await flush();
  await app.advance();
  await app.sample();
  assert.equal(app.navigation.next, 1);
});

test('video buffering is not completion and does not restart a running player', async () => {
  const app = await begin();
  app.video.readyState = 1;
  app.video.emit('waiting');
  await app.advance(10_000);
  await app.sample();
  assert.equal(app.video.playCalls, 1);
  assert.equal(app.navigation.next, 0);
  assert.ok(app.samples().every(({ page }) => !page.reason));
  app.video.readyState = 4;
  app.video.emit('canplay');
  await flush();
  assert.equal(app.video.playCalls, 1);
});

test('video waits for a source or metadata before requesting playback', async () => {
  const app = await begin({ readyState: 0, mediaSource: false });
  await app.advance(3_000);
  assert.equal(app.video.playCalls, 0);
  assert.equal(app.navigation.next, 0);
  app.video.readyState = 1;
  await app.advance();
  assert.equal(app.video.playCalls, 1);
  assert.deepEqual(app.video.playStates, [{ muted: true, rate: 1 }]);
});

test('video with a source and preload none can start before metadata is loaded', async () => {
  const app = await begin({ readyState: 0 });
  assert.equal(app.video.playCalls, 1);
  assert.deepEqual(app.video.playStates, [{ muted: true, rate: 1 }]);
  assert.equal(app.navigation.next, 0);
});

test('video sustained buffering eventually requires attention without advancing', async () => {
  const app = await begin();
  app.video.readyState = 1;
  app.video.emit('waiting');
  await app.advance();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await app.advance(120_001);
    if (attempt < 2) {
      await app.advance(4_001);
      await app.advance();
    }
    await app.sample();
  }
  assert.ok(app.samples().at(-1).page.reason);
  assert.equal(app.video.paused, true);
  assert.equal(app.navigation.next, 0);
});

test('video transient AbortError retries with a delay without a premature block', async () => {
  const app = await begin({ playModes: ['AbortError', 'success'] });
  assert.equal(app.video.playCalls, 1);
  await app.advance(1_000);
  assert.equal(app.video.playCalls, 1);
  await app.advance(1_001);
  assert.equal(app.video.playCalls, 2);
  assert.equal(app.video.paused, false);
  await app.sample();
  assert.ok(app.samples().every(({ page }) => !page.reason));
});

test('video retries two failures and recovers on the third play attempt', async () => {
  const app = await begin({ playModes: ['AbortError', 'AbortError', 'success'] });
  await app.advance(2_001);
  assert.equal(app.video.playCalls, 2);
  await app.advance(3_999);
  assert.equal(app.video.playCalls, 2);
  await app.advance(2);
  assert.equal(app.video.playCalls, 3);
  assert.equal(app.video.paused, false);
  await app.sample();
  assert.ok(app.samples().every(({ page }) => !page.reason));
});

test('video stops after three failed plays and a pending retry is canceled by subject pause', async () => {
  const exhausted = await begin({ playModes: ['AbortError', 'AbortError', 'AbortError', 'success'] });
  await exhausted.advance(2_001);
  await exhausted.advance(4_001);
  await exhausted.sample();
  await exhausted.advance(10_000);
  await exhausted.sample();
  assert.equal(exhausted.video.playCalls, 3);
  assert.match(exhausted.samples().at(-1).page.reason, /два автоматических повтора/u);
  const paused = await begin({ playModes: ['AbortError', 'success'] });
  await paused.pause();
  await paused.advance(10_000);
  assert.equal(paused.video.playCalls, 1);
});

test('video media errors reload the source before retrying playback', async () => {
  const app = await begin();
  app.video.pause();
  app.video.error = { code: 2 };
  await app.advance();
  await app.advance(2_001);
  assert.equal(app.video.loadCalls, 1);
  await app.advance();
  assert.equal(app.video.playCalls, 2);
  assert.equal(app.video.paused, false);
  assert.equal(app.navigation.next, 0);
});

test('video autoplay policy rejection shows a specific actionable reason', async () => {
  const app = await begin({ playModes: ['NotAllowedError', 'NotAllowedError', 'NotAllowedError'] });
  await app.advance(2_001);
  await app.advance(4_001);
  await app.sample();
  assert.match(app.samples().at(-1).page.reason, /Chrome.*(?:автовоспроизведение|автозапуск)/u);
  assert.equal(app.video.muted, true);
  assert.equal(app.video.playCalls, 3);
  assert.equal(app.navigation.next, 0);
});

test('video unresolved play does not hold the driver indefinitely and retries after timeout', async () => {
  const app = await begin({ playModes: ['pending', 'success'], readyState: 1 });
  assert.equal(app.video.playCalls, 1);
  await app.advance(14_999);
  assert.equal(app.video.playCalls, 1);
  await app.advance(1);
  app.video.readyState = 4;
  await app.advance(2_001);
  assert.equal(app.video.playCalls, 2);
  assert.equal(app.video.paused, false);
  assert.equal(app.navigation.next, 0);
});

test('video late play completion cannot restart playback after explicit pause or ownership loss', async () => {
  for (const transition of ['pause', 'ownership']) {
    const app = await begin({ playModes: ['pending'], readyState: 1 });
    if (transition === 'pause') await app.pause();
    else {
      app.replyWith({ ok: true, context: null });
      await app.sample();
    }
    app.video.resolvePlay();
    await flush();
    await app.advance(2_001);
    assert.equal(app.video.paused, true, transition);
    assert.equal(app.video.playCalls, 1, transition);
    assert.equal(app.navigation.next, 0, transition);
  }
});

test('video stale end and late play completion after route change do not affect the new item', async () => {
  const app = await begin({ playModes: ['pending'], readyState: 1 });
  const oldVideo = await app.changePage();
  assert.equal(app.video.playCalls, 1);
  oldVideo.resolvePlay();
  oldVideo.finish();
  await flush();
  await app.advance();
  assert.equal(oldVideo.paused, true);
  assert.equal(app.video.paused, false);
  assert.equal(app.navigation.next, 0);
});

test('video remains untouched while its subject is paused', async () => {
  const app = await begin({ context: { enabled: false } });
  await app.advance(10_000);
  await app.sample();
  assert.equal(app.video.playCalls, 0);
  assert.equal(app.video.muted, false);
  assert.equal(app.navigation.next, 0);
});

test('video replacement on the same route is started and detached-player events are ignored', async () => {
  const app = await begin();
  const oldVideo = app.replaceVideo();
  await app.advance();
  assert.equal(app.video.playCalls, 1);
  assert.equal(oldVideo.paused, true);
  oldVideo.finish();
  oldVideo.emit('waiting');
  await flush();
  await app.advance();
  assert.equal(app.navigation.next, 0);
  assert.equal(app.video.paused, false);
});

test('video accounting includes real muted playback, not buffering or seeks', async () => {
  const app = await begin();
  await app.sample();
  app.video.currentTime = 10;
  await app.advance(10_000);
  await app.sample();
  assert.equal(app.samples().at(-1).seconds, 10);
  app.video.readyState = 1;
  app.video.emit('waiting');
  await app.advance(10_000);
  await app.sample();
  assert.equal(app.samples().at(-1).seconds, 0);
  app.video.readyState = 4;
  app.video.currentTime = 29;
  app.video.emit('seeking');
  await app.advance(1_000);
  await app.sample();
  assert.equal(app.samples().at(-1).seconds, 0);
});

test('recognized module-complete celebration is dismissed once for an enabled subject', async () => {
  const app = await begin({ dialog: {} });
  await app.advance();
  assert.equal(app.navigation.closed, 1);
  assert.equal(app.navigation.next, 0);
  assert.equal(app.video.playCalls, 1);
});

test('Question and Reflect inside the video are skipped and playback resumes without selecting or submitting answers', async () => {
  for (const title of ['Question', 'Reflect']) {
    const app = await begin({ videoQuestion: { title } });
    assert.equal(app.navigation.skipped, 1);
    assert.equal(app.navigation.questionSubmitted, 0);
    await app.advance();
    assert.equal(app.video.playCalls, 1);
    assert.equal(app.navigation.skipped, 1);
    assert.equal(app.navigation.next, 0);
    assert.equal(app.requests.some(({ type }) => type.startsWith('AI_')), false);
  }
});

test('video questions are not skipped outside the player, for unknown forms or while the subject is paused', async () => {
  for (const options of [
    { videoQuestion: { outsidePlayer: true } }, { videoQuestion: { unknownForm: true } },
    { videoQuestion: { title: 'Consent required' } }, { videoQuestion: { disabled: true } },
    { videoQuestion: {}, context: { enabled: false } },
  ]) {
    const app = await begin(options);
    await app.advance();
    assert.equal(app.navigation.skipped, 0);
    assert.equal(app.navigation.questionSubmitted, 0);
  }
});

test('an inert video Skip is retried twice with a delay and then blocks without selecting an answer', async () => {
  const app = await begin({ videoQuestion: { inert: true } });
  assert.equal(app.navigation.skipped, 1);
  await app.advance(2_001);
  assert.equal(app.navigation.skipped, 2);
  await app.advance(4_001);
  assert.equal(app.navigation.skipped, 3);
  await app.advance(6_001);
  await app.sample();
  assert.match(app.samples().at(-1).page.reason, /двух повторов Skip/u);
  assert.equal(app.navigation.skipped, 3);
  assert.equal(app.navigation.questionSubmitted, 0);
});

test('unknown dialogs and celebrations on paused subjects are not dismissed', async () => {
  for (const options of [
    { dialog: { title: 'Confirm your account' } },
    { dialog: { title: 'Module complete!', closeLabel: 'Agree and close' } },
    { dialog: { closeDisabled: true } },
    { dialog: { hidden: true } },
    { dialog: {}, context: { enabled: false } },
  ]) {
    const app = await begin(options);
    await app.advance();
    assert.equal(app.navigation.closed, 0, JSON.stringify(options));
  }
});
