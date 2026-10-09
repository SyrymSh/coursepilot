import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubject } from '../extension/core/scheduler.js';
import { defaultState, STATE_KEY } from '../extension/core/state.js';

const EXTENSION_ID = 'coursepilot-test-extension';
const START = Date.parse('2026-10-09T10:00:00+05:00');
let importSequence = 0;

function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}

function storageArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    async get(keys) {
      if (keys == null) return structuredClone(values);
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return structuredClone(Object.fromEntries(names.map((key) => [key, values[key]])));
    },
    async set(patch) { Object.assign(values, structuredClone(patch)); },
    async setAccessLevel() {},
    read(key) { return structuredClone(values[key]); },
  };
}

function runningSubject(index, patch = {}) {
  const url = `https://www.coursera.org/learn/course-${index}/home`;
  return {
    ...createSubject({ title: `Subject ${index}`, programUrl: url }, START - 3_600_000).value,
    status: 'running', tabId: index,
    courses: [{ id: `course-${index}`, title: `Course ${index}`, url, status: 'pending', seconds: 0 }],
    ...patch,
  };
}

async function fixture(t, configure = () => {}) {
  let currentTime = START;
  t.mock.method(Date, 'now', () => currentTime);
  const state = { ...defaultState(), subjects: [runningSubject(1), runningSubject(2)] };
  configure(state);
  const local = storageArea({ [STATE_KEY]: state, apiSecret: 'private-test-key' });
  const session = storageArea();
  const tabs = new Map(state.subjects.map((subject, index) => [subject.tabId, { id: subject.tabId, url: `https://www.coursera.org/learn/course-${index + 1}/lecture/lesson`, mutedInfo: { muted: false } }]).filter(([id]) => id !== null));
  const commands = [];
  const tabOperations = [];
  let receiver = async () => ({ ok: true });
  let nextTabId = 20;
  const chrome = {
    runtime: {
      id: EXTENSION_ID, getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
      onMessage: event(), onStartup: event(), onInstalled: event(),
    },
    storage: { local, session },
    permissions: { async contains() { return true; } },
    alarms: { async get() { return { name: 'coursepilot-tick' }; }, async create() {}, onAlarm: event() },
    sidePanel: { async setPanelBehavior() {} },
    tabs: {
      onRemoved: event(),
      async query() { return structuredClone([...tabs.values()]); },
      async get(id) {
        if (!tabs.has(id)) throw new Error('No tab');
        return structuredClone(tabs.get(id));
      },
      async create(options) {
        tabOperations.push({ type: 'create', options: structuredClone(options) });
        const tab = { id: nextTabId++, status: 'loading', active: true, mutedInfo: { muted: false }, ...options };
        tabs.set(tab.id, tab); return structuredClone(tab);
      },
      async update(id, options) {
        tabOperations.push({ type: 'update', id, options: structuredClone(options) });
        if (!tabs.has(id)) throw new Error('No tab');
        const tab = tabs.get(id);
        const { muted, ...changes } = options;
        Object.assign(tab, changes);
        if (typeof muted === 'boolean') tab.mutedInfo = { muted, reason: 'extension', extensionId: EXTENSION_ID };
        return structuredClone(tab);
      },
      async sendMessage(id, message) {
        tabOperations.push({ type: 'message', id, message: structuredClone(message) });
        commands.push({ id, message }); return receiver(id, message);
      },
    },
  };
  const originalChrome = globalThis.chrome;
  globalThis.chrome = chrome;
  t.after(() => { globalThis.chrome = originalChrome; });
  await import(`../extension/background.js?integration=${++importSequence}`);
  assert.equal(chrome.runtime.onMessage.listeners.length, 1);
  const internalSender = { id: EXTENSION_ID, url: chrome.runtime.getURL('panel.html') };
  const send = (message, sender = internalSender) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Background message did not respond')), 12000);
    chrome.runtime.onMessage.listeners[0](message, sender, (result) => { clearTimeout(timer); resolve(result); });
  });
  function sender(index, patch = {}) {
    return { id: EXTENSION_ID, tab: structuredClone(tabs.get(index)), frameId: 0,
      documentId: `document-${index}`, url: `https://www.coursera.org/learn/course-${index}/lecture/lesson`, ...patch };
  }
  function sample(index, patch = {}, senderPatch = {}) {
    const origin = sender(index, senderPatch);
    return send({ type: 'CONTENT_SAMPLE', url: origin.url, seconds: 10, source: 'video',
      page: { kind: 'video' }, ...patch }, origin);
  }
  return {
    send, sample, sender, chrome, commands, tabOperations,
    state: () => local.read(STATE_KEY),
    tabCount: () => tabs.size,
    patchTab: (id, patch) => Object.assign(tabs.get(id), patch),
    setReceiver: (next) => { receiver = next; },
    setNow: (value) => { currentTime = value; },
    async tick() {
      chrome.alarms.onAlarm.listeners[0]({ name: 'coursepilot-tick' });
      await send({ type: 'GET_STATE' });
    },
    async startup() {
      chrome.runtime.onStartup.listeners[0]();
      await send({ type: 'GET_STATE' });
    },
    async installed(details = { reason: 'update', previousVersion: '0.1.2' }) {
      chrome.runtime.onInstalled.listeners[0](details);
      await send({ type: 'GET_STATE' });
    },
    async closeTab(id, isWindowClosing = false) {
      tabs.delete(id);
      chrome.tabs.onRemoved.listeners[0](id, { isWindowClosing });
      await send({ type: 'GET_STATE' });
    },
  };
}

function dialogueRequest(app, index = 1, patch = {}) {
  const url = `https://www.coursera.org/learn/course-${index}/coach/dialogue-${index}`;
  app.patchTab(index, { url });
  return {
    sender: app.sender(index, { url }),
    message: { type: 'AI_DIALOGUE', url, dialogue: { title: 'Practice conversation', prompt: 'Explain one sign of a suspicious email.', history: [] }, ...patch },
  };
}

async function dialogueFixture(t, configure = () => {}) {
  return fixture(t, (state) => {
    state.settings.ai = { ...state.settings.ai, enabled: true, autoDialogue: true, endpoint: 'https://api.example.test/v1/chat/completions', model: 'small-model' };
    configure(state);
  });
}

function dialogueResponse(reply = 'An unexpected request to disclose a password is suspicious.') {
  return { ok: true, async json() { return {
    choices: [{ message: { content: JSON.stringify({ reply }) } }], usage: { total_tokens: 24 },
  }; } };
}

test('parallel subjects persist independent samples without lost storage updates', async (t) => {
  const app = await fixture(t);
  await Promise.all([app.sample(1), app.sample(2)]);
  app.setNow(START + 10000);
  const replies = await Promise.all([app.sample(1), app.sample(2)]);
  assert.ok(replies.every((reply) => reply.ok && reply.context.enabled));
  assert.deepEqual(app.state().subjects.map((subject) => subject.elapsedSeconds), [10, 10]);
  assert.deepEqual(app.state().subjects.map((subject) => subject.courses[0].seconds), [10, 10]);
  const first = app.state().subjects[0];
  await app.send({ type: 'SUBJECT_ACTION', id: first.id, action: 'pause' });
  app.setNow(START + 20000);
  await Promise.all([app.sample(1), app.sample(2)]);
  assert.deepEqual(app.state().subjects.map((subject) => subject.elapsedSeconds), [10, 20]);
  assert.equal(app.state().subjects[0].status, 'paused');
  assert.equal(app.state().subjects[1].status, 'running');
});

test('widget Continue is relayed only for an enabled owned top-level Coursera activity', async (t) => {
  const url = 'https://www.coursera.org/learn/foundations-of-cybersecurity/ungradedWidget/l9B7s/explore-keep-organizations-secure';
  const app = await fixture(t, (state) => {
    state.subjects[0].courses[0].url = 'https://www.coursera.org/learn/foundations-of-cybersecurity/home';
  });
  app.patchTab(1, { url });
  app.setReceiver(async () => ({ ok: true, status: 'clicked' }));
  const request = { type: 'CONTENT_WIDGET_CONTINUE', url };
  const sender = app.sender(1, { url });
  assert.equal((await app.send(request, sender)).status, 'clicked');
  const relays = () => app.commands.filter(({ message }) => message.type === 'WIDGET_CONTINUE').length;
  assert.equal(relays(), 1);
  await app.send(request, { ...sender, frameId: 2 });
  await app.send(request, { ...sender, id: 'another-extension' });
  assert.equal(relays(), 1);
  await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action: 'pause' });
  assert.equal((await app.send(request, sender)).status, 'disabled');
  assert.equal(relays(), 1);
});

test('manual skip persists one unfinished item and journal entry without altering time, grade or course status', async (t) => {
  const app = await fixture(t);
  const url = 'https://www.coursera.org/learn/course-1/lab/manual/lesson';
  app.patchTab(1, { url });
  const message = { type: 'CONTENT_SKIP_MANUAL', url, code: 'manual', itemTitle: 'Lab', reason: 'Requires separate work.' };
  const sender = app.sender(1, { url });
  const before = app.state().subjects;
  assert.equal((await app.send(message, sender)).context.skipManual, true);
  assert.equal((await app.send(message, sender)).ok, true);
  const after = app.state();
  assert.equal(after.subjects[0].status, 'running');
  assert.equal(after.subjects[0].elapsedSeconds, before[0].elapsedSeconds);
  assert.deepEqual(after.subjects[0].courses, before[0].courses);
  assert.deepEqual(after.subjects[1], before[1]);
  assert.equal(after.subjects[0].skippedItems.length, 1);
  assert.equal(after.subjects[0].skippedItems[0].url, url);
  assert.equal(after.logs.filter(({ message }) => message.startsWith('Пропуск без отметки')).length, 1);
  const exported = await app.send({ type: 'EXPORT_DATA' });
  assert.equal(exported.data.subjects[0].skippedItems.length, 1);
});

test('manual skip denies foreign frames, stale routes, protected pages, disabled settings and paused subjects', async (t) => {
  const app = await fixture(t);
  const url = 'https://www.coursera.org/learn/course-1/coach/manual/lesson';
  app.patchTab(1, { url });
  const message = { type: 'CONTENT_SKIP_MANUAL', url, code: 'unsupported', itemTitle: 'Coach', reason: 'Unsupported format.' };
  const sender = app.sender(1, { url });
  for (const patch of [{ id: 'foreign-extension' }, { frameId: 2 }, { url: 'https://evil.test/learn/course-1/coach/manual' }]) {
    assert.equal((await app.send(message, { ...sender, ...patch })).context, null);
  }
  assert.equal((await app.send({ ...message, code: 'arbitrary' }, sender)).ok, false);
  for (const route of ['home', 'lecture/video', 'login', 'challenge/captcha']) {
    const otherUrl = `https://www.coursera.org/learn/course-1/${route}`;
    app.patchTab(1, { url: otherUrl });
    assert.equal((await app.send({ ...message, url: otherUrl }, app.sender(1, { url: otherUrl }))).ok, false);
  }
  app.patchTab(1, { url });
  const settings = { ...app.state().settings, skipManual: false };
  assert.equal((await app.send({ type: 'UPDATE_SETTINGS', settings })).ok, true);
  assert.equal((await app.send(message, sender)).ok, false);
  await app.send({ type: 'UPDATE_SETTINGS', settings: { ...settings, skipManual: true } });
  await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action: 'pause' });
  assert.equal((await app.send(message, sender)).ok, false);
  assert.equal(app.state().subjects[0].skippedItems, undefined);
});

test('manual skip defaults migrate older settings but an explicit opt-out survives an extension update', async (t) => {
  const app = await fixture(t, (state) => { delete state.settings.skipManual; });
  assert.equal((await app.sample(1)).context.skipManual, true);
  await app.send({ type: 'UPDATE_SETTINGS', settings: { ...app.state().settings, skipManual: false } });
  await app.installed();
  assert.equal((await app.sample(1)).context.skipManual, false);
});

test('unauthorized control messages and untracked content frames cannot mutate state', async (t) => {
  const app = await fixture(t);
  const before = app.state();
  for (const sender of [
    { id: EXTENSION_ID, url: 'https://www.coursera.org' },
    { id: 'foreign-extension', url: `chrome-extension://${EXTENSION_ID}/panel.html` },
    app.sender(1),
  ]) {
    const reply = await app.send({ type: 'ADD_SUBJECT', title: 'Unwanted', programUrl: 'https://www.coursera.org/learn/unwanted' }, sender);
    assert.equal(reply.ok, false);
  }
  for (const patch of [
    { id: 'foreign-extension' },
    { frameId: 1 }, { tab: { id: 999, url: 'https://www.coursera.org/learn/course-1/home' } },
    { url: 'https://www.coursera.org.evil.test/learn/course-1/lecture/lesson' },
  ]) {
    const reply = await app.sample(1, {}, patch);
    assert.equal(reply.context, null);
  }
  assert.deepEqual(app.state(), before);
});

test('reported pages must match the tracked sender course and exact path', async (t) => {
  const app = await fixture(t);
  for (const url of [
    'https://www.coursera.org/learn/course-2/lecture/lesson',
    'https://www.coursera.org/learn/course-1/lecture/other-lesson',
    'https://example.com/learn/course-1/lecture/lesson',
  ]) {
    const reply = await app.sample(1, { url });
    assert.equal(reply.context, null);
  }
  assert.equal(app.state().subjects[0].elapsedSeconds, 0);
  assert.equal(app.state().subjects[0].startDate, null);
});

test('duplicate activity, sleep and daily caps never add unobserved time', async (t) => {
  const app = await fixture(t, (state) => {
    state.subjects[0].startDate = '2026-10-09';
    state.subjects[0].elapsedSeconds = 7195;
    state.subjects[0].dailySeconds = { '2026-10-09': 7195 };
    state.subjects[0].courses[0].seconds = 7195;
  });
  await Promise.all([app.sample(1), app.sample(2)]);
  app.setNow(START + 10000);
  await Promise.all([app.sample(1), app.sample(1), app.sample(2)]);
  assert.deepEqual(app.state().subjects.map((subject) => subject.elapsedSeconds), [7200, 10]);
  const view = await app.send({ type: 'GET_STATE' });
  assert.equal(view.state.metrics[app.state().subjects[0].id].canRun, false);
  app.setNow(START + 86400000);
  await app.sample(1, { seconds: 20 });
  assert.equal(app.state().subjects[0].elapsedSeconds, 7200);
  app.setNow(START + 86410000);
  await app.sample(1);
  assert.equal(app.state().subjects[0].elapsedSeconds, 7210);
  assert.equal(app.state().subjects[0].dailySeconds['2026-10-10'], 10);
});

test('a new document needs a fresh activity lease before any time can accrue', async (t) => {
  const app = await fixture(t);
  await app.sample(1);
  app.setNow(START + 10000);
  await app.sample(1, {}, { documentId: 'new-document' });
  assert.equal(app.state().subjects[0].elapsedSeconds, 0);
  app.setNow(START + 20000);
  await app.sample(1, {}, { documentId: 'new-document' });
  assert.equal(app.state().subjects[0].elapsedSeconds, 10);
});

test('an account switch cannot merge completion, courses or activity into the old profile', async (t) => {
  const app = await fixture(t, (state) => { state.subjects[0].accountKey = 'original-account'; });
  const reply = await app.sample(1, {
    accountKey: 'different-account', completedCourse: true, page: { kind: 'complete' },
  });
  const subject = app.state().subjects[0];
  assert.equal(reply.context.enabled, false);
  assert.equal(subject.status, 'blocked');
  assert.equal(subject.accountKey, 'original-account');
  assert.equal(subject.elapsedSeconds, 0);
  assert.equal(subject.courses[0].status, 'pending');
  assert.equal(subject.lastUrl, null);
  assert.equal(app.state().subjects[1].status, 'running');
});

test('a dashboard opened as an extension tab retains access to its controls', async (t) => {
  const app = await fixture(t);
  const url = app.chrome.runtime.getURL('dashboard.html');
  const reply = await app.send({ type: 'GET_STATE' }, { id: EXTENSION_ID, url, tab: { id: 55, url } });
  assert.equal(reply.ok, true);
  assert.equal(reply.state.subjects.length, 2);
});

test('API requests do not block other subjects and auth failure remains isolated', async (t) => {
  const app = await fixture(t, (state) => {
    state.settings.ai = { ...state.settings.ai, enabled: true, endpoint: 'https://api.example.test/v1/chat/completions', model: 'small-model' };
  });
  await app.sample(2);
  let releaseFetch;
  let notifyFetch;
  const fetchStarted = new Promise((resolve) => { notifyFetch = resolve; });
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { releaseFetch = resolve; notifyFetch(); }));
  const quiz = { questions: [{ id: 'q1', prompt: 'Which number is even?', multiple: false,
    options: [{ id: 'a', text: '2' }, { id: 'b', text: '3' }] }] };
  const origin = app.sender(1);
  const request = app.send({ type: 'AI_QUIZ', url: origin.url, quiz }, origin);
  await fetchStarted;
  app.setNow(START + 10000);
  const other = await app.sample(2);
  assert.equal(other.context.enabled, true);
  assert.equal(app.state().subjects[1].elapsedSeconds, 10);
  releaseFetch({ ok: false, status: 401 });
  const reply = await request;
  assert.equal(reply.ok, false);
  assert.equal(reply.disabled, true);
  assert.equal(app.state().subjects[0].status, 'blocked');
  assert.equal(app.state().subjects[1].status, 'running');
  assert.equal(app.state().settings.ai.enabled, false);
  app.setNow(START + 20000);
  await app.sample(2);
  assert.equal(app.state().subjects[1].elapsedSeconds, 20);
});

test('disabling AI while an answer is pending prevents applying or caching that answer', async (t) => {
  const app = await fixture(t, (state) => {
    state.settings.ai = { ...state.settings.ai, enabled: true, endpoint: 'https://api.example.test/v1/chat/completions', model: 'small-model' };
  });
  let releaseFetch;
  let notifyFetch;
  const fetchStarted = new Promise((resolve) => { notifyFetch = resolve; });
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { releaseFetch = resolve; notifyFetch(); }));
  const quiz = { questions: [{ id: 'q1', prompt: 'Which number is even?', multiple: false,
    options: [{ id: 'a', text: '2' }, { id: 'b', text: '3' }] }] };
  const origin = app.sender(1);
  const request = app.send({ type: 'AI_QUIZ', url: origin.url, quiz }, origin);
  await fetchStarted;
  const settingsReply = await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { enabled: false } } });
  assert.equal(settingsReply.ok, true);
  releaseFetch({ ok: true, async json() { return {
    choices: [{ message: { content: JSON.stringify({ answers: [{ questionId: 'q1', optionIds: ['a'] }] }) } }],
    usage: { total_tokens: 24 },
  }; } });
  const reply = await request;
  assert.equal(reply.ok, false);
  assert.equal(reply.answers, undefined);
  assert.equal(app.state().aiCache.length, 0);
  assert.equal(app.state().subjects[0].status, 'running');
  assert.equal(app.state().subjects[1].status, 'running');
});

test('panel snapshots and exports omit API secrets and answer caches', async (t) => {
  const app = await fixture(t, (state) => { state.aiCache = [{ key: 'private-cache', answers: [] }]; });
  const view = await app.send({ type: 'GET_STATE' });
  const exported = await app.send({ type: 'EXPORT_DATA' });
  assert.equal(view.state.hasApiKey, true);
  assert.equal(view.state.aiCache, undefined);
  assert.equal(exported.data.aiCache, undefined);
  assert.equal(JSON.stringify([view, exported]).includes('private-test-key'), false);
  assert.equal(JSON.stringify([view, exported]).includes('private-cache'), false);
});

test('one bounded retry counts both API requests and stores only a validated answer', async (t) => {
  const app = await fixture(t, (state) => {
    state.settings.ai = { ...state.settings.ai, enabled: true, endpoint: 'https://api.example.test/v1/chat/completions', model: 'small-model' };
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503 };
    return { ok: true, async json() { return {
      choices: [{ message: { content: JSON.stringify({ answers: [{ questionId: 'q1', optionIds: ['a'] }] }) } }],
      usage: { total_tokens: 24 },
    }; } };
  });
  const quiz = { questions: [{ id: 'q1', prompt: 'Which number is even?', multiple: false,
    options: [{ id: 'a', text: '2' }, { id: 'b', text: '3' }] }] };
  const origin = app.sender(1);
  const reply = await app.send({ type: 'AI_QUIZ', url: origin.url, quiz }, origin);
  assert.equal(reply.ok, true);
  assert.equal(calls, 2);
  assert.equal(app.state().aiUsage.requests, 2);
  assert.equal(app.state().aiUsage.tokens, 24);
  assert.equal(app.state().aiCache.length, 1);
  assert.equal(app.state().subjects[0].status, 'running');
  const repeated = await app.send({ type: 'AI_QUIZ', url: origin.url, quiz }, origin);
  assert.equal(repeated.cached, true);
  assert.equal(calls, 2);
});

test('completion requires observed course completion plus both time and calendar conditions', async (t) => {
  const app = await fixture(t, (state) => {
    state.subjects[0].startDate = '2026-09-15';
    state.subjects[0].elapsedSeconds = 180000;
    state.subjects[1].startDate = '2026-09-15';
    state.subjects[1].elapsedSeconds = 180000;
  });
  await app.sample(1, { completedCourse: true, page: { kind: 'complete' } });
  await app.tick();
  assert.equal(app.state().subjects[0].status, 'completed');
  assert.equal(app.state().subjects[0].completedAt, START);
  assert.equal(app.state().subjects[1].status, 'running');
  assert.equal(app.state().subjects[1].completedAt, null);
});

test('completed hours and courses wait for day 25 without becoming permanently blocked', async (t) => {
  const app = await fixture(t, (state) => {
    state.subjects[0].startDate = '2026-09-16';
    state.subjects[0].elapsedSeconds = 180000;
    state.subjects[0].courses[0].status = 'completed';
  });
  await app.tick();
  assert.equal(app.state().subjects[0].status, 'running');
  assert.equal(app.state().subjects[0].completedAt, null);
  assert.equal(app.state().subjects[0].elapsedSeconds, 180000);
  app.setNow(START + 86400000);
  await app.tick();
  assert.equal(app.state().subjects[0].status, 'completed');
  assert.equal(app.state().subjects[0].completedAt, START + 86400000);
  assert.equal(app.state().subjects[0].elapsedSeconds, 180000);
});

test('startup reuses restored course tabs and starts fresh observation leases', async (t) => {
  const app = await fixture(t);
  await app.sample(1);
  app.setNow(START + 10000);
  await app.startup();
  assert.equal(app.tabCount(), 2);
  assert.deepEqual(app.state().subjects.map((subject) => subject.tabId), [1, 2]);
  await app.sample(1);
  assert.equal(app.state().subjects[0].elapsedSeconds, 0);
  app.setNow(START + 20000);
  await app.sample(1);
  assert.equal(app.state().subjects[0].elapsedSeconds, 10);
  assert.equal((await app.chrome.tabs.get(1)).mutedInfo.muted, true);
  assert.equal((await app.chrome.tabs.get(2)).mutedInfo.muted, true);
});

test('new managed tabs are muted before Coursera navigation without changing activation semantics', async (t) => {
  for (const action of ['start', 'open']) {
    await t.test(action, async (t) => {
      const app = await fixture(t, (state) => { state.subjects[0].tabId = null; });
      const reply = await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action });
      assert.equal(reply.ok, true);
      const subject = app.state().subjects[0];
      const tab = await app.chrome.tabs.get(subject.tabId);
      assert.deepEqual(app.tabOperations.slice(0, 3), [
        { type: 'create', options: { url: 'about:blank', ...(action === 'start' ? { active: false } : {}) } },
        { type: 'update', id: tab.id, options: { muted: true } },
        { type: 'update', id: tab.id, options: { url: subject.programUrl } },
      ]);
      assert.equal(tab.mutedInfo.muted, true);
      assert.equal(tab.active, action === 'open');
      assert.equal(tab.url, subject.programUrl);
      assert.equal(app.tabCount(), 2);
      assert.equal(app.commands.some((item) => item.id === tab.id), false);
    });
  }
});

test('resume mutes its owned tab before run and never changes unrelated tab audio or focus', async (t) => {
  const app = await fixture(t);
  const unrelated = await app.chrome.tabs.create({ url: 'https://example.com/', active: false });
  app.patchTab(1, { active: false });
  app.patchTab(2, { url: 'https://example.com/unrelated', active: true });
  app.tabOperations.length = 0;
  await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action: 'resume' });
  assert.deepEqual(app.tabOperations.slice(0, 2), [
    { type: 'update', id: 1, options: { muted: true } },
    { type: 'message', id: 1, message: { type: 'COURSE_COMMAND', action: 'run', explicit: true } },
  ]);
  assert.equal((await app.chrome.tabs.get(1)).active, false);
  assert.equal((await app.chrome.tabs.get(2)).mutedInfo.muted, false);
  assert.equal((await app.chrome.tabs.get(unrelated.id)).mutedInfo.muted, false);
  assert.equal(app.tabOperations.some((item) => item.type === 'update' && item.id !== 1), false);
});

test('open and scan silence existing owned tabs while preserving a manual pause', async (t) => {
  const app = await fixture(t, (state) => { state.subjects[0].status = 'paused'; });
  for (const action of ['open', 'scan']) {
    app.patchTab(1, { mutedInfo: { muted: false }, active: false });
    app.tabOperations.length = 0;
    const result = await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action });
    assert.equal(result.ok, true);
    assert.deepEqual(app.tabOperations.slice(0, 3), [
      { type: 'update', id: 1, options: { muted: true } },
      { type: 'update', id: 1, options: { active: true } },
      { type: 'message', id: 1, message: { type: 'COURSE_COMMAND', action: 'inspect' } },
    ]);
    assert.equal(app.state().subjects[0].status, 'paused');
    assert.equal((await app.chrome.tabs.get(1)).mutedInfo.muted, true);
  }
});

test('mute failures isolate one running subject and never send its run command', async (t) => {
  const app = await fixture(t);
  const update = app.chrome.tabs.update;
  t.mock.method(app.chrome.tabs, 'update', async (id, changes) => {
    if (id === 1 && changes.muted === true) throw new Error('Cannot mute tab');
    return update(id, changes);
  });
  await app.tick();
  assert.equal(app.state().subjects[0].status, 'blocked');
  assert.match(app.state().subjects[0].reason, /выключить звук.*Открыть/u);
  assert.equal(app.state().subjects[1].status, 'running');
  assert.equal(app.commands.some((item) => item.id === 1 && item.message.action === 'run'), false);
  assert.equal(app.commands.some((item) => item.id === 1 && item.message.action === 'pause'), true);
  assert.equal(app.commands.some((item) => item.id === 2 && item.message.action === 'run'), true);
});

test('failed mute keeps a newly created tab blank for explicit retry without duplicates', async (t) => {
  const app = await fixture(t, (state) => { state.subjects[0].tabId = null; });
  const update = app.chrome.tabs.update;
  let muteFails = true;
  t.mock.method(app.chrome.tabs, 'update', async (id, changes) => {
    if (id >= 20 && changes.muted === true && muteFails) throw new Error('Cannot mute new tab');
    return update(id, changes);
  });
  const id = app.state().subjects[0].id;
  const first = await app.send({ type: 'SUBJECT_ACTION', id, action: 'open' });
  assert.equal(first.ok, false);
  assert.match(first.error, /выключить звук/u);
  const tabId = app.state().subjects[0].tabId;
  assert.equal((await app.chrome.tabs.get(tabId)).url, 'about:blank');
  assert.equal(app.state().subjects[0].status, 'blocked');
  const second = await app.send({ type: 'SUBJECT_ACTION', id, action: 'open' });
  assert.equal(second.ok, false);
  assert.equal(app.state().subjects[0].tabId, tabId);
  assert.equal(app.tabCount(), 2);
  muteFails = false;
  assert.equal((await app.send({ type: 'SUBJECT_ACTION', id, action: 'open' })).ok, true);
  assert.equal(app.tabCount(), 2);
  assert.equal((await app.chrome.tabs.get(tabId)).mutedInfo.muted, true);
  assert.equal((await app.chrome.tabs.get(tabId)).url, app.state().subjects[0].programUrl);
  assert.equal(app.state().subjects[0].status, 'blocked');
});

test('content hello and samples must mute the owned page before granting automation or counting activity', async (t) => {
  const app = await fixture(t);
  const sender = app.sender(1);
  const hello = await app.send({ type: 'CONTENT_HELLO', url: sender.url }, sender);
  assert.equal(hello.context.enabled, true);
  assert.equal((await app.chrome.tabs.get(1)).mutedInfo.muted, true);
  await app.sample(1);
  app.setNow(START + 10000);
  const update = app.chrome.tabs.update;
  t.mock.method(app.chrome.tabs, 'update', async (id, changes) => {
    if (id === 1 && changes.muted === true) throw new Error('Cannot mute tab');
    return update(id, changes);
  });
  const reply = await app.sample(1);
  assert.equal(reply.context.enabled, false);
  assert.equal(app.state().subjects[0].elapsedSeconds, 0);
  assert.equal(app.state().subjects[0].status, 'blocked');
});

test('program discovery and completed-course navigation mute before the destination loads', async (t) => {
  for (const page of ['program', 'complete']) {
    await t.test(page, async (t) => {
      const app = await fixture(t, (state) => {
        const subject = state.subjects[0];
        if (page === 'program') subject.programUrl = 'https://www.coursera.org/specializations/test-program';
        else subject.courses.push({ id: 'next-course', title: 'Next course', url: 'https://www.coursera.org/learn/next-course/home', status: 'pending', seconds: 0 });
      });
      const subject = app.state().subjects[0];
      const url = page === 'program' ? subject.programUrl : app.sender(1).url;
      app.patchTab(1, { url });
      const reply = await app.sample(1, { url, completedCourse: page === 'complete', page: { kind: page } }, { url });
      assert.equal(reply.ok, true);
      const updates = app.tabOperations.filter((item) => item.type === 'update' && item.id === 1);
      const destination = page === 'program' ? subject.courses[0].url : subject.courses[1].url;
      assert.deepEqual(updates.slice(-2), [
        { type: 'update', id: 1, options: { muted: true } },
        { type: 'update', id: 1, options: { url: destination } },
      ]);
      assert.equal((await app.chrome.tabs.get(1)).mutedInfo.muted, true);
      assert.equal((await app.chrome.tabs.get(1)).url, destination);
    });
  }
});

test('closing a single tab pauses only its subject while window shutdown remains resumable', async (t) => {
  const app = await fixture(t);
  await app.closeTab(1);
  await app.closeTab(2, true);
  assert.equal(app.state().subjects[0].status, 'paused');
  assert.equal(app.state().subjects[1].status, 'running');
  await app.startup();
  const subjects = app.state().subjects;
  assert.equal(subjects[0].tabId, null);
  assert.equal(subjects[0].status, 'paused');
  assert.ok(Number.isInteger(subjects[1].tabId));
  assert.equal(subjects[1].status, 'running');
  assert.equal(app.tabCount(), 1);
  assert.equal(subjects[1].elapsedSeconds, 0);
});

test('explicit quiz retry resumes only its owned blocked subject without spending API requests', async (t) => {
  const app = await fixture(t, (state) => {
    state.settings.ai.enabled = true;
    state.subjects[0].status = 'blocked';
    state.subjects[0].reason = 'Interrupted request';
  });
  const sender = app.sender(1, { url: 'https://www.coursera.org/learn/course-1/assignment-submission/id/title/attempt' });
  app.patchTab(1, { url: sender.url });
  const reply = await app.send({ type: 'CONTENT_RETRY_QUIZ', url: sender.url }, sender);
  assert.equal(reply.ok, true);
  assert.equal(reply.context.enabled, true);
  assert.equal(app.state().subjects[0].status, 'running');
  assert.equal(app.state().subjects[0].reason, '');
  assert.equal(app.state().aiUsage.requests, 0);
  assert.equal(app.state().subjects[1].status, 'running');
});

test('quiz retry cannot override explicit pause, wrong routes, unknown tabs or time limits', async (t) => {
  const app = await fixture(t, (state) => {
    state.settings.ai.enabled = true;
    state.subjects[0].status = 'paused';
    state.subjects[1].status = 'blocked';
    state.subjects[1].elapsedSeconds = 180000;
  });
  for (const [index, patch] of [[1, {}], [2, {}], [1, { tab: { id: 999 } }], [1, { frameId: 1 }]]) {
    const sender = app.sender(index, { url: `https://www.coursera.org/learn/course-${index}/quiz/id/title`, ...patch });
    app.patchTab(index, { url: sender.url });
    const reply = await app.send({ type: 'CONTENT_RETRY_QUIZ', url: sender.url }, sender);
    assert.equal(Boolean(reply.context?.enabled), false);
  }
  const sender = app.sender(1);
  app.patchTab(1, { url: sender.url });
  assert.equal((await app.send({ type: 'CONTENT_RETRY_QUIZ', url: sender.url }, sender)).ok, false);
  assert.deepEqual(app.state().subjects.map((subject) => subject.status), ['paused', 'blocked']);
});

test('quiz retry does not resume after the visible account changes', async (t) => {
  const app = await fixture(t, (state) => {
    state.settings.ai.enabled = true;
    state.subjects[0].status = 'blocked';
    state.subjects[0].accountKey = 'original-account';
  });
  const sender = app.sender(1, { url: 'https://www.coursera.org/learn/course-1/quiz/id/title' });
  app.patchTab(1, { url: sender.url });
  const reply = await app.send({ type: 'CONTENT_RETRY_QUIZ', url: sender.url, accountKey: 'different-account' }, sender);
  assert.equal(reply.context.enabled, false);
  assert.equal(app.state().subjects[0].status, 'blocked');
  assert.equal(app.state().subjects[0].accountKey, 'original-account');
});

test('a missing page receiver is visible and only its subject blocks until an explicit resume', async (t) => {
  const app = await fixture(t);
  app.setReceiver(async (id) => {
    if (id === 1) throw new Error('Receiving end does not exist');
    return { ok: true };
  });
  await app.tick();
  assert.equal(app.state().subjects[0].status, 'blocked');
  assert.match(app.state().subjects[0].reason, /Нет связи.*Обновите/u);
  assert.equal(app.state().subjects[1].status, 'running');
  const view = await app.send({ type: 'GET_STATE' });
  assert.equal(view.state.metrics[app.state().subjects[0].id].canRun, false);
  assert.equal(view.state.metrics[app.state().subjects[1].id].canRun, true);
  assert.equal(app.state().logs.filter((entry) => /Нет связи/u.test(entry.message)).length, 1);
  app.setReceiver(async () => ({ ok: true }));
  const reply = await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action: 'resume' });
  assert.equal(reply.ok, true);
  assert.equal(app.state().subjects[0].status, 'running');
  assert.equal(app.state().subjects[0].reason, '');
});

test('an unresponsive page times out with an actionable reason without blocking other subjects', async (t) => {
  const app = await fixture(t);
  app.setReceiver((id) => id === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true }));
  await app.tick();
  assert.equal(app.state().subjects[0].status, 'blocked');
  assert.match(app.state().subjects[0].reason, /не отвечает.*Обновите/u);
  assert.equal(app.state().subjects[1].status, 'running');
});

test('new and loading owned tabs wait for page load before checking their receiver', async (t) => {
  const app = await fixture(t, (state) => { state.subjects[0].tabId = null; });
  app.setReceiver(async (id) => {
    if (id !== 2) throw new Error('Receiving end does not exist');
    return { ok: true };
  });
  const id = app.state().subjects[0].id;
  const opened = await app.send({ type: 'SUBJECT_ACTION', id, action: 'open' });
  assert.equal(opened.ok, true);
  const tabId = app.state().subjects[0].tabId;
  assert.ok(Number.isInteger(tabId));
  assert.equal(app.state().subjects[0].status, 'running');
  assert.equal(app.commands.some((item) => item.id === tabId), false);
  app.patchTab(tabId, { url: 'https://example.com/', pendingUrl: app.state().subjects[0].programUrl });
  await app.tick();
  assert.equal(app.state().subjects[0].status, 'running');
  assert.equal(app.commands.some((item) => item.id === tabId), false);
  app.patchTab(tabId, { url: app.state().subjects[0].programUrl, pendingUrl: undefined, status: 'complete' });
  await app.tick();
  assert.equal(app.state().subjects[0].status, 'blocked');
  assert.match(app.state().subjects[0].reason, /Нет связи/u);
});

test('a failed scan reports connection failure without overriding a manual pause', async (t) => {
  const app = await fixture(t, (state) => { state.subjects[0].status = 'paused'; });
  app.setReceiver(async (id) => id === 1 ? undefined : { ok: true });
  const reply = await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action: 'scan' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Нет связи.*Обновите/u);
  assert.equal(reply.state.subjects[0].status, 'paused');
  assert.match(reply.state.subjects[0].reason, /Нет связи/u);
  assert.equal(app.state().subjects[1].status, 'running');
  assert.equal(app.state().aiUsage.requests, 0);
});

test('same-document navigation keeps ownership when sender.url retains the initial page', async (t) => {
  const app = await fixture(t);
  const initialUrl = app.state().subjects[0].programUrl;
  const currentUrl = 'https://www.coursera.org/learn/course-1/assignment-submission/id/title/attempt';
  const sender = app.sender(1, { url: initialUrl });
  app.patchTab(1, { url: currentUrl });
  const hello = await app.send({ type: 'CONTENT_HELLO', url: currentUrl }, sender);
  assert.equal(hello.context.enabled, true);
  await app.send({ type: 'CONTENT_SAMPLE', url: currentUrl, seconds: 10, source: 'activity', page: { kind: 'quiz' } }, sender);
  app.setNow(START + 10000);
  const sample = await app.send({ type: 'CONTENT_SAMPLE', url: currentUrl, seconds: 10, source: 'activity', page: { kind: 'quiz' } }, sender);
  assert.equal(sample.context.enabled, true);
  assert.equal(app.state().subjects[0].elapsedSeconds, 10);
  assert.equal(app.state().subjects[0].lastUrl, currentUrl);
});

test('current browser URL rejects stale, foreign, pending-navigation and inactive-document messages', async (t) => {
  const app = await fixture(t);
  const sender = app.sender(1);
  const before = app.state();
  for (const tabPatch of [
    { url: 'https://www.coursera.org/learn/course-1/lecture/another' },
    { url: 'https://www.coursera.org/learn/course-2/lecture/lesson' },
    { url: 'https://example.com/' },
    { url: sender.url, pendingUrl: 'https://www.coursera.org/learn/course-1/lecture/another' },
  ]) {
    app.patchTab(1, { pendingUrl: undefined, ...tabPatch });
    const reply = await app.send({ type: 'CONTENT_SAMPLE', url: sender.url, seconds: 10, source: 'video', page: { kind: 'video' } }, sender);
    assert.equal(reply.context, null);
  }
  app.patchTab(1, { url: sender.url, pendingUrl: undefined });
  for (const patch of [
    { url: sender.url.replace('www.coursera.org', 'coursera.org') },
    { documentLifecycle: 'cached' },
    { documentLifecycle: 'prerender' },
  ]) {
    const reply = await app.send({ type: 'CONTENT_HELLO', url: sender.url }, { ...sender, ...patch });
    assert.equal(reply.context, null);
  }
  assert.deepEqual(app.state(), before);
});

test('a pending AI response is discarded if its tab navigates to another lesson', async (t) => {
  const app = await fixture(t, (state) => {
    state.settings.ai = { ...state.settings.ai, enabled: true, endpoint: 'https://api.example.test/v1/chat/completions', model: 'small-model' };
  });
  let releaseFetch;
  let notifyFetch;
  const fetchStarted = new Promise((resolve) => { notifyFetch = resolve; });
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { releaseFetch = resolve; notifyFetch(); }));
  const quiz = { questions: [{ id: 'q1', prompt: 'Which number is even?', multiple: false,
    options: [{ id: 'a', text: '2' }, { id: 'b', text: '3' }] }] };
  const sender = app.sender(1);
  const request = app.send({ type: 'AI_QUIZ', url: sender.url, quiz }, sender);
  await fetchStarted;
  app.patchTab(1, { url: 'https://www.coursera.org/learn/course-1/lecture/another' });
  releaseFetch({ ok: true, async json() { return {
    choices: [{ message: { content: JSON.stringify({ answers: [{ questionId: 'q1', optionIds: ['a'] }] }) } }],
    usage: { total_tokens: 24 },
  }; } });
  const reply = await request;
  assert.equal(reply.ok, false);
  assert.equal(reply.answers, undefined);
  assert.equal(app.state().aiCache.length, 0);
  assert.equal(app.state().subjects[0].status, 'running');
});

test('only explicit start or resume resets the selected page launch guards', async (t) => {
  const app = await fixture(t);
  const id = app.state().subjects[0].id;
  for (const action of ['start', 'resume']) {
    app.commands.length = 0;
    const reply = await app.send({ type: 'SUBJECT_ACTION', id, action });
    assert.equal(reply.ok, true);
    assert.equal(app.commands.find((item) => item.id === 1 && item.message.action === 'run')?.message.explicit, true);
    assert.equal(app.commands.find((item) => item.id === 2 && item.message.action === 'run')?.message.explicit, undefined);
  }
  app.commands.length = 0;
  await app.tick();
  await app.startup();
  await app.send({ type: 'UPDATE_SETTINGS', settings: {} });
  await app.send({ type: 'SUBJECT_ACTION', id, action: 'open' });
  await app.send({ type: 'SUBJECT_ACTION', id, action: 'scan' });
  assert.ok(app.commands.some((item) => item.message.action === 'run'));
  assert.ok(app.commands.every((item) => item.message.explicit !== true));
});

test('opening a newly created tab does not check the receiver in the same action', async (t) => {
  const app = await fixture(t, (state) => { state.subjects[0].tabId = null; });
  const create = app.chrome.tabs.create;
  t.mock.method(app.chrome.tabs, 'create', async (options) => {
    const tab = await create(options);
    app.patchTab(tab.id, { status: 'complete' });
    return { ...tab, status: 'complete' };
  });
  app.setReceiver(async (id) => {
    if (id !== 2) throw new Error('Receiving end does not exist');
    return { ok: true };
  });
  const reply = await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action: 'open' });
  assert.equal(reply.ok, true);
  assert.equal(app.state().subjects[0].status, 'running');
  assert.equal(app.commands.some((item) => item.id === app.state().subjects[0].tabId), false);
});

test('an extension update preserves API settings, stored key and progress without exposing the key', async (t) => {
  const app = await fixture(t, (state) => {
    state.settings.ai = { ...state.settings.ai, enabled: true, endpoint: 'https://api.example.test/v1/chat/completions', model: 'saved-small-model' };
    state.aiUsage = { date: '2026-10-09', requests: 3, tokens: 240 };
    state.subjects[0].elapsedSeconds = 600;
    state.subjects[0].startDate = '2026-10-09';
    state.subjects[0].dailySeconds = { '2026-10-09': 600 };
    state.subjects[0].courses[0].seconds = 600;
  });
  const before = app.state();
  await app.installed();
  assert.deepEqual(app.state(), before);
  assert.equal(app.chrome.storage.local.read('apiSecret'), 'private-test-key');
  const view = await app.send({ type: 'GET_STATE' });
  const exported = await app.send({ type: 'EXPORT_DATA' });
  assert.equal(view.state.hasApiKey, true);
  assert.equal(view.state.settings.ai.endpoint, before.settings.ai.endpoint);
  assert.equal(view.state.settings.ai.model, before.settings.ai.model);
  assert.equal(JSON.stringify([view, exported]).includes('private-test-key'), false);
  assert.equal(app.commands.length, 0);
});

test('saving settings without a replacement API key preserves the saved key across updates', async (t) => {
  const app = await fixture(t, (state) => {
    state.settings.ai = { ...state.settings.ai, enabled: true, endpoint: 'https://api.example.test/v1/chat/completions', model: 'saved-small-model' };
  });
  const replaced = await app.send({ type: 'UPDATE_SETTINGS', settings: {}, apiKey: '  replacement-test-key  ' });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.state.hasApiKey, true);
  const saved = await app.send({ type: 'UPDATE_SETTINGS', settings: { windowStart: '08:00', ai: { dailyRequests: 25 } } });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.hasApiKey, true);
  assert.equal(saved.state.settings.ai.endpoint, 'https://api.example.test/v1/chat/completions');
  assert.equal(saved.state.settings.ai.model, 'saved-small-model');
  assert.equal(saved.state.settings.ai.dailyRequests, 25);
  assert.equal(app.chrome.storage.local.read('apiSecret'), 'replacement-test-key');
  await app.installed();
  await app.startup();
  assert.equal(app.chrome.storage.local.read('apiSecret'), 'replacement-test-key');
  const view = await app.send({ type: 'GET_STATE' });
  assert.equal(view.state.hasApiKey, true);
  assert.equal(view.state.settings.windowStart, '08:00');
  assert.equal(view.state.settings.ai.model, 'saved-small-model');
  assert.equal(JSON.stringify(view).includes('replacement-test-key'), false);
});

test('only a valid explicit key clear removes the stored key', async (t) => {
  const app = await fixture(t);
  const invalid = await app.send({ type: 'UPDATE_SETTINGS', settings: { windowStart: '22:00', windowEnd: '09:00' }, apiKey: '' });
  assert.equal(invalid.ok, false);
  assert.equal(app.chrome.storage.local.read('apiSecret'), 'private-test-key');
  const unchanged = await app.send({ type: 'UPDATE_SETTINGS', settings: {} });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.state.hasApiKey, true);
  const cleared = await app.send({ type: 'UPDATE_SETTINGS', settings: {}, apiKey: '' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.state.hasApiKey, false);
  assert.equal(app.chrome.storage.local.read('apiSecret'), '');
  await app.installed();
  assert.equal((await app.send({ type: 'GET_STATE' })).state.hasApiKey, false);
});

test('old installations receive disabled dialogue defaults without changing saved API settings', async (t) => {
  const app = await fixture(t, (state) => {
    state.settings.ai.enabled = true;
    state.settings.ai.autoSubmit = true;
    state.settings.ai.endpoint = 'https://api.example.test/v1/chat/completions';
    state.settings.ai.model = 'saved-model';
    delete state.settings.ai.autoDialogue;
    delete state.settings.ai.autoHonorCode;
    delete state.settings.ai.dialogueMaxTurns;
  });
  const view = await app.send({ type: 'GET_STATE' });
  assert.equal(view.state.settings.ai.autoDialogue, false);
  assert.equal(view.state.settings.ai.autoHonorCode, false);
  assert.equal(view.state.settings.ai.dialogueMaxTurns, 12);
  assert.equal(view.state.settings.ai.autoSubmit, true);
  assert.equal(view.state.settings.ai.model, 'saved-model');
  assert.equal(view.state.hasApiKey, true);
  await app.installed();
  assert.equal(app.state().settings.ai.autoDialogue, false);
  assert.equal(app.state().settings.ai.dialogueMaxTurns, 12);
  const sender = app.sender(1);
  const hello = await app.send({ type: 'CONTENT_HELLO', url: sender.url }, sender);
  assert.equal(hello.context.autoDialogue, false);
  assert.equal(hello.context.autoHonorCode, false);
  assert.equal(hello.context.dialogueMaxTurns, 12);
});

test('dialogue settings validate opt-in and bounded turn limits', async (t) => {
  const app = await fixture(t);
  for (const dialogueMaxTurns of [0, 31, 1.5, '12', null]) {
    const reply = await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { dialogueMaxTurns } } });
    assert.equal(reply.ok, false);
  }
  assert.equal((await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { autoDialogue: 'true' } } })).ok, false);
  const saved = await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { autoDialogue: true, dialogueMaxTurns: 30, autoSubmit: true } } });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.settings.ai.autoDialogue, true);
  assert.equal(saved.state.settings.ai.dialogueMaxTurns, 30);
  assert.equal(saved.state.settings.ai.autoSubmit, true);
});

test('Honor Code opt-in validates, persists and reaches owned tabs without changing API credentials', async (t) => {
  const app = await fixture(t);
  for (const autoHonorCode of ['true', 1, null]) {
    assert.equal((await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { autoHonorCode } } })).ok, false);
  }
  const saved = await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { autoHonorCode: true } } });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.settings.ai.autoHonorCode, true);
  assert.equal(saved.state.hasApiKey, true);
  await app.installed();
  assert.equal(app.state().settings.ai.autoHonorCode, true);
  const sender = app.sender(1);
  const hello = await app.send({ type: 'CONTENT_HELLO', url: sender.url }, sender);
  assert.equal(hello.context.autoHonorCode, true);
});

test('Coach requests require opt-in, current coach route, account ownership and a running subject', async (t) => {
  const app = await dialogueFixture(t, (state) => { state.subjects[0].accountKey = 'original-account'; });
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches += 1; return dialogueResponse(); });
  const { message, sender } = dialogueRequest(app);
  for (const senderPatch of [{ frameId: 1 }, { id: 'foreign-extension' }, { tab: { id: 999 } }]) {
    assert.equal((await app.send(message, { ...sender, ...senderPatch })).ok, false);
  }
  assert.equal((await app.send({ ...message, accountKey: 'other-account' }, sender)).ok, false);
  assert.equal((await app.send({ ...message, dialogue: { prompt: '' } }, sender)).ok, false);
  const lecture = 'https://www.coursera.org/learn/course-1/lecture/lesson';
  app.patchTab(1, { url: lecture });
  assert.equal((await app.send({ ...message, url: lecture }, { ...sender, url: lecture })).ok, false);
  app.patchTab(1, { url: message.url });
  await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { autoDialogue: false } } });
  assert.equal((await app.send(message, sender)).ok, false);
  await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { autoDialogue: true, enabled: false } } });
  assert.equal((await app.send(message, sender)).ok, false);
  await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { enabled: true } } });
  await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action: 'pause' });
  assert.equal((await app.send(message, sender)).ok, false);
  assert.equal(fetches, 0);
  assert.equal(app.state().aiUsage.requests, 0);
});

test('plain-text Coach replies pass through the provider pipeline and cache without extra requests', async (t) => {
  const app = await dialogueFixture(t, (state) => {
    state.settings.ai.endpoint = 'https://api.openai.com/v1/chat/completions';
    state.settings.ai.model = 'gpt-6-luna';
  });
  let fetches = 0;
  const answer = 'Maven uses "pom.xml".\nIt manages dependency versions and transitive dependencies.';
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    fetches += 1;
    assert.equal(JSON.parse(options.body).model, 'gpt-6-luna');
    return { ok: true, async json() { return { choices: [{ finish_reason: 'stop', message: { content: answer } }], usage: { total_tokens: 24 } }; } };
  });
  const { message, sender } = dialogueRequest(app);
  const first = await app.send(message, sender);
  assert.equal(first.ok, true);
  assert.equal(first.reply, answer);
  assert.equal(first.autoDialogue, true);
  assert.equal(app.state().subjects[0].status, 'running');
  const cached = await app.send(message, sender);
  assert.equal(cached.cached, true);
  assert.equal(cached.reply, answer);
  assert.equal(fetches, 1);
  assert.equal(app.state().aiUsage.requests, 1);
  assert.equal(app.state().aiUsage.tokens, 24);
});

test('invalid Coach output is retried twice and then blocks only its subject', async (t) => {
  const app = await dialogueFixture(t);
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches += 1;
    return { ok: true, async json() { return { choices: [{ finish_reason: 'stop', message: { content: '{"reply":"private broken reply' } }] }; } };
  });
  const { message, sender } = dialogueRequest(app);
  const result = await app.send(message, sender);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.reply, undefined);
  assert.equal(fetches, 3);
  assert.equal(app.state().aiUsage.requests, 3);
  assert.equal(app.state().aiCache.length, 0);
  assert.equal(app.state().subjects[0].status, 'blocked');
  assert.equal(app.state().subjects[1].status, 'running');
  assert.doesNotMatch(JSON.stringify([result, app.state().logs]), /private broken reply/u);
});

test('dialogue and quiz share quotas but keep separate cached result types', async (t) => {
  const app = await dialogueFixture(t, (state) => { state.settings.ai.dailyRequests = 2; state.settings.ai.autoSubmit = true; });
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    fetches += 1;
    const payload = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (payload.prompt) return dialogueResponse();
    return { ok: true, async json() { return {
      choices: [{ message: { content: JSON.stringify({ answers: [{ questionId: 'q1', optionIds: ['a'] }] }) } }], usage: { total_tokens: 10 },
    }; } };
  });
  const { message, sender } = dialogueRequest(app);
  const first = await app.send(message, sender);
  assert.equal(first.ok, true);
  assert.equal(typeof first.reply, 'string');
  assert.equal(first.answers, undefined);
  assert.equal(first.autoSubmit, true);
  assert.equal(first.autoDialogue, true);
  const cached = await app.send(message, sender);
  assert.equal(cached.cached, true);
  assert.equal(cached.reply, first.reply);
  const quizUrl = 'https://www.coursera.org/learn/course-1/quiz/quiz-id';
  app.patchTab(1, { url: quizUrl });
  const quiz = { questions: [{ id: 'q1', prompt: 'Which number is even?', multiple: false, options: [{ id: 'a', text: '2' }, { id: 'b', text: '3' }] }] };
  const quizReply = await app.send({ type: 'AI_QUIZ', url: quizUrl, quiz }, { ...sender, url: quizUrl });
  assert.equal(quizReply.ok, true);
  assert.equal(quizReply.reply, undefined);
  assert.equal(quizReply.answers.length, 1);
  assert.deepEqual(app.state().aiCache.map((entry) => entry.kind).sort(), ['dialogue', 'quiz']);
  assert.equal(app.state().aiUsage.requests, 2);
  assert.equal(app.state().aiUsage.tokens, 34);
  app.patchTab(1, { url: message.url });
  const exhausted = await app.send({ ...message, dialogue: { ...message.dialogue, prompt: 'Name another sign.' } }, sender);
  assert.equal(exhausted.ok, false);
  assert.match(exhausted.error, /лимит/u);
  assert.equal(fetches, 2);
  const view = await app.send({ type: 'GET_STATE' });
  const exported = await app.send({ type: 'EXPORT_DATA' });
  assert.equal(JSON.stringify([view, exported]).includes(first.reply), false);
});

test('only one dialogue request per task is in flight while another subject remains independent', async (t) => {
  const app = await dialogueFixture(t);
  const releases = [];
  let started;
  let notifyStarted;
  started = new Promise((resolve) => { notifyStarted = resolve; });
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { releases.push(resolve); notifyStarted(); }));
  const one = dialogueRequest(app, 1);
  const two = dialogueRequest(app, 2);
  const first = app.send(one.message, one.sender);
  await started;
  const duplicate = await app.send({ ...one.message, dialogue: { ...one.message.dialogue, prompt: 'Another prompt on the same task.' } }, one.sender);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /уже выполняется/u);
  started = new Promise((resolve) => { notifyStarted = resolve; });
  const second = app.send(two.message, two.sender);
  await started;
  assert.equal(releases.length, 2);
  assert.equal(app.state().aiUsage.requests, 2);
  releases.forEach((release) => release(dialogueResponse()));
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal((await app.send(one.message, one.sender)).cached, true);
});

test('a dialogue auth error disables AI without changing other subjects', async (t) => {
  const app = await dialogueFixture(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401 }));
  const { message, sender } = dialogueRequest(app);
  const reply = await app.send(message, sender);
  assert.equal(reply.ok, false);
  assert.equal(reply.disabled, true);
  assert.equal(app.state().settings.ai.enabled, false);
  assert.equal(app.state().subjects[0].status, 'blocked');
  assert.equal(app.state().subjects[1].status, 'running');
  assert.equal(app.state().aiCache.length, 0);
});

test('pending dialogue replies do not apply after pause, navigation, account change or opt-out', async (t) => {
  for (const change of ['pause', 'navigation', 'account', 'opt-out']) {
    await t.test(change, async (caseTest) => {
      const app = await dialogueFixture(caseTest, (state) => { state.subjects[0].accountKey = 'original-account'; });
      let releaseFetch;
      let notifyFetch;
      const started = new Promise((resolve) => { notifyFetch = resolve; });
      caseTest.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { releaseFetch = resolve; notifyFetch(); }));
      const { message, sender } = dialogueRequest(app, 1, { accountKey: 'original-account' });
      const request = app.send(message, sender);
      await started;
      if (change === 'pause') await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action: 'pause' });
      if (change === 'navigation') app.patchTab(1, { url: 'https://www.coursera.org/learn/course-1/coach/another' });
      if (change === 'account') await app.send({ type: 'CONTENT_HELLO', url: message.url, accountKey: 'other-account' }, sender);
      if (change === 'opt-out') await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { autoDialogue: false } } });
      releaseFetch(dialogueResponse());
      const reply = await request;
      assert.equal(reply.ok, false);
      assert.equal(reply.reply, undefined);
      assert.equal(app.state().aiCache.length, 0);
    });
  }
});

test('explicit dialogue retry resumes only an opted-in owned blocked task within schedule', async (t) => {
  const app = await dialogueFixture(t, (state) => {
    state.subjects[0].status = 'blocked';
    state.subjects[0].reason = 'Coach response was interrupted';
    state.subjects[1].status = 'paused';
  });
  const one = dialogueRequest(app, 1);
  const two = dialogueRequest(app, 2);
  const retry = { ...one.message, type: 'CONTENT_RETRY_DIALOGUE' };
  const reply = await app.send(retry, one.sender);
  assert.equal(reply.ok, true);
  assert.equal(reply.context.enabled, true);
  assert.equal(reply.context.autoDialogue, true);
  assert.equal(app.state().subjects[0].status, 'running');
  assert.equal(app.state().subjects[0].reason, '');
  assert.equal((await app.send({ ...two.message, type: 'CONTENT_RETRY_DIALOGUE' }, two.sender)).ok, false);
  assert.equal(app.state().subjects[1].status, 'paused');
  await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { autoDialogue: false } } });
  assert.equal((await app.send(retry, one.sender)).ok, false);
  await app.send({ type: 'UPDATE_SETTINGS', settings: { ai: { autoDialogue: true }, windowStart: '20:00', windowEnd: '21:00' } });
  assert.equal((await app.send(retry, one.sender)).ok, false);
  assert.equal(app.state().aiUsage.requests, 0);
});

test('dialogue reasons block only their subject and observed activity uses normal leases', async (t) => {
  const app = await dialogueFixture(t);
  const { message, sender } = dialogueRequest(app);
  const sample = { type: 'CONTENT_SAMPLE', url: message.url, seconds: 10, source: 'activity', page: { kind: 'dialogue' } };
  await app.send(sample, sender);
  app.setNow(START + 10000);
  await app.send(sample, sender);
  assert.equal(app.state().subjects[0].elapsedSeconds, 10);
  app.setNow(START + 20000);
  await app.send({ ...sample, seconds: 0, page: { kind: 'dialogue', reason: 'Conversation turn limit reached.' } }, sender);
  assert.equal(app.state().subjects[0].elapsedSeconds, 10);
  assert.equal(app.state().subjects[0].status, 'blocked');
  assert.equal(app.state().subjects[1].status, 'running');
});

test('dialogue recovers after two failures and counts all three requests against the shared daily limit', async (t) => {
  const app = await dialogueFixture(t);
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches += 1;
    return fetches <= 2 ? { ok: false, status: 503 } : dialogueResponse();
  });
  const { message, sender } = dialogueRequest(app);
  const reply = await app.send(message, sender);
  assert.equal(reply.ok, true);
  assert.equal(fetches, 3);
  assert.equal(app.state().aiUsage.requests, 3);
  assert.equal(app.state().aiCache.length, 1);
  assert.equal(app.state().aiCache[0].kind, 'dialogue');
  assert.equal(app.state().aiCache[0].reply, reply.reply);
});

test('AI retry stops when the daily budget is exhausted and does not consume a fourth request', async (t) => {
  const app = await dialogueFixture(t, (state) => { state.settings.ai.dailyRequests = 2; });
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches += 1; return { ok: false, status: 503 }; });
  const { message, sender } = dialogueRequest(app);
  const result = await app.send(message, sender);
  assert.equal(result.ok, false);
  assert.match(result.error, /Дневной лимит/u);
  assert.equal(fetches, 2);
  assert.equal(app.state().aiUsage.requests, 2);
});

test('AI retry is canceled after pausing the subject or changing its key, without another provider call', async (t) => {
  for (const change of ['pause', 'key']) {
    await t.test(change, async (subtest) => {
      const app = await dialogueFixture(subtest);
      let notifyFailed;
      const failed = new Promise((resolve) => { notifyFailed = resolve; });
      let fetches = 0;
      subtest.mock.method(globalThis, 'fetch', async () => { fetches += 1; notifyFailed(); return { ok: false, status: 503 }; });
      const { message, sender } = dialogueRequest(app);
      const pending = app.send(message, sender);
      await failed;
      if (change === 'pause') await app.send({ type: 'SUBJECT_ACTION', id: app.state().subjects[0].id, action: 'pause' });
      else await app.send({ type: 'UPDATE_SETTINGS', settings: {}, apiKey: 'replacement-key' });
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(fetches, 1);
      assert.equal(app.state().aiUsage.requests, 1);
    });
  }
});

test('dialogue cache shares the 60-entry limit and expires after 24 hours', async (t) => {
  const app = await dialogueFixture(t, (state) => {
    state.aiCache = Array.from({ length: 60 }, (_, index) => ({ key: `old-${index}`, kind: index % 2 ? 'quiz' : 'dialogue', expiresAt: START + 86400000, reply: 'old' }));
  });
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches += 1; return dialogueResponse(); });
  const { message, sender } = dialogueRequest(app);
  assert.equal((await app.send(message, sender)).ok, true);
  assert.equal(app.state().aiCache.length, 60);
  assert.equal(app.state().aiCache[0].expiresAt, START + 86400000);
  assert.equal(app.state().aiCache.some((entry) => entry.key === 'old-59'), false);
  assert.equal((await app.send(message, sender)).cached, true);
  app.setNow(START + 86400001);
  assert.equal((await app.send(message, sender)).ok, true);
  assert.equal(fetches, 2);
  assert.equal(app.state().aiCache.length, 1);
  assert.equal(app.state().aiUsage.date, '2026-10-10');
  assert.equal(app.state().aiUsage.requests, 1);
});

for (const previousStatus of [200, 401]) {
  test(`replacing an API key discards a pending HTTP ${previousStatus} result without disabling the new key`, async (t) => {
    const app = await dialogueFixture(t);
    let releaseFirst;
    let notifyStarted;
    let fetches = 0;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    t.mock.method(globalThis, 'fetch', (_url, options) => {
      fetches += 1;
      if (fetches === 1) {
        assert.equal(options.headers.Authorization, 'Bearer private-test-key');
        return new Promise((resolve) => { releaseFirst = resolve; notifyStarted(); });
      }
      assert.equal(options.headers.Authorization, 'Bearer new-valid-test-key');
      return Promise.resolve(dialogueResponse('Reply using the new credential.'));
    });
    const { message, sender } = dialogueRequest(app);
    const original = app.send(message, sender);
    await started;
    const updated = await app.send({ type: 'UPDATE_SETTINGS', settings: {}, apiKey: 'new-valid-test-key' });
    assert.equal(updated.ok, true);
    releaseFirst(previousStatus === 200 ? dialogueResponse('Stale response.') : { ok: false, status: previousStatus });
    const stale = await original;
    assert.equal(stale.ok, false);
    assert.equal(stale.reply, undefined);
    assert.equal(stale.disabled, undefined);
    assert.match(stale.error, /Ключ API изменился/u);
    assert.equal(app.state().settings.ai.enabled, true);
    assert.equal(app.state().subjects[0].status, 'running');
    assert.equal(app.state().aiCache.length, 0);
    assert.equal(app.chrome.storage.local.read('apiSecret'), 'new-valid-test-key');
    const fresh = await app.send(message, sender);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.reply, 'Reply using the new credential.');
    assert.equal(fetches, 2);
    assert.equal(app.state().aiUsage.requests, 2);
    assert.doesNotMatch(JSON.stringify([stale, fresh, app.state().logs]), /private-test-key|new-valid-test-key/u);
  });
}
