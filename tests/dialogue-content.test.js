import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const pure = { URL };
runInNewContext(source, pure);
const { dialoguePath, dialogueComplete, dialogueUnavailable, dialogueLimit, fingerprint } = pure.__COURSEPILOT_TEST__;
const COACH_URL = 'https://www.coursera.org/learn/fixture/coach/task/conversation';
const STORE_KEY = `coursepilot:dialogue:${fingerprint(`owned||${COACH_URL}`)}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function coachFixture({ context = {}, prompts = ['What is phishing?'], draft = '', storage = new Map(), busy = false, actionsReady = true, completion = null } = {}) {
  const created = [];
  function element(tag = 'div', content = '') {
    const attributes = new Map();
    const node = {
      tag, textContent: content, isConnected: true, hidden: false, children: [],
      getAttribute: (name) => attributes.get(name) || null,
      setAttribute: (name, value) => attributes.set(name, value),
      closest: () => null, matches: () => false, querySelector: () => null, querySelectorAll: () => [],
      getClientRects() { return this.hidden ? [] : [{}]; }, addEventListener: () => {}, dispatchEvent: () => true,
      append(...children) { this.children.push(...children); },
      attachShadow() { this.shadow = element('shadow'); return this.shadow; },
    };
    created.push(node);
    return node;
  }
  class TextArea {
    get value() { return this.currentValue || ''; }
    set value(value) { this.currentValue = String(value); }
  }
  const input = Object.assign(new TextArea(), element('textarea'), { disabled: false, readOnly: false });
  input.value = draft;
  input.hidden = Boolean(completion && !completion.composer);
  const sent = [];
  const sendButton = Object.assign(element('button', 'Send message'), {
    disabled: false, click() { sent.push(input.value); input.value = ''; },
  });
  const composer = element('div');
  composer.querySelector = (selector) => selector.startsWith('textarea') ? input : selector.startsWith('button') ? sendButton : null;
  const heading = element('h1', 'Coach fixture');
  const toolbar = element('div');
  const messages = [];
  const addPrompt = (prompt) => {
    const markdown = element('div', prompt);
    const message = element('div');
    message.querySelector = (selector) => selector.includes('coach-message-markdown') ? markdown : selector.includes('Message actions') && actionsReady ? toolbar : null;
    messages.push(message);
  };
  prompts.forEach(addPrompt);
  const coach = element('div');
  coach.querySelector = (selector) => selector.includes('Chat message composer') ? composer : null;
  coach.querySelectorAll = (selector) => selector === '[data-testid="chat-message-llm"]' ? messages : selector.includes('typing-indicator') && busy ? [toolbar] : [];
  const area = element('section');
  area.querySelector = (selector) => selector.includes('coursera-coach-item') ? coach : selector === 'h1,h2' ? heading : null;
  const ended = element('div', completion?.message ?? 'The Dialogue has ended. Start a new chat to clear your chat history and start fresh.');
  const endButtons = element('div');
  const badge = element('div', completion?.status ?? 'Completed');
  const completeHeading = element('h2', completion?.heading || '');
  const retryButton = element('button', 'Try again');
  const navigation = { next: 0, retry: 0 };
  retryButton.click = () => { navigation.retry += 1; };
  const nextButton = Object.assign(element('button', 'Go to next item'), { type: 'button', click() { navigation.next += 1; } });
  for (const node of [ended, endButtons, badge, completeHeading]) {
    node.hidden = completion?.hidden === true;
    node.closest = (selector) => completion?.inHistory && selector.includes('ai-coach-chat-messages') ? coach :
      node === badge && completion?.statusInButton && selector === 'button,a,[role="button"]' ? retryButton : null;
  }
  endButtons.querySelectorAll = (selector) => selector === 'div,span,[role="status"]' ? [badge] : [];
  area.querySelectorAll = (selector) => {
    if (selector === 'textarea[aria-label="Send a message"]') return [input];
    if (!completion) return [];
    if (selector === 'h1,h2,h3,[role="status"]') return [heading, completeHeading];
    if (selector === '[data-testid="chat-ended-message"]') return completion.marker === false ? [] : [ended];
    if (selector === '[data-testid="chat-end-buttons"]') return completion.buttons === false ? [] : [endButtons];
    return [];
  };
  const main = element('main');
  main.querySelectorAll = (selector) => selector === 'h1' ? [heading] : selector === 'a[href],button' && completion ? [retryButton, nextButton] : [];
  const document = {
    title: 'Coach fixture', body: main, documentElement: element('html'), visibilityState: 'visible',
    hasFocus: () => true, getElementById: () => null, addEventListener: () => {}, createElement: element,
    querySelector: (selector) => selector.includes('dialogue-content') ? area : selector === 'main,[role="main"]' ? main : null,
    querySelectorAll: () => [],
  };
  const timers = new Map();
  const intervals = new Map();
  const requests = [];
  const pending = [];
  let timerId = 0;
  let clock = 100_000;
  let command;
  let response = { ok: true, context: { subjectId: 'owned', enabled: true, allowAI: true, autoDialogue: true, dialogueMaxTurns: 12, autoSubmit: false, ...context } };
  const runtime = {
    id: 'coach-fixture', onMessage: { addListener(listener) { command = listener; } },
    sendMessage(message, callback) {
      requests.push(message);
      if (message.type === 'AI_DIALOGUE') pending.push(callback);
      else callback(response);
    },
  };
  runInNewContext(source, {
    URL, document, window: { addEventListener: () => {} }, chrome: { runtime }, location: new URL(COACH_URL),
    HTMLTextAreaElement: TextArea, Event: class { constructor(type) { this.type = type; } },
    Date: { now: () => clock }, performance: { now: () => clock }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, at: clock + delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id), setInterval: (callback, ms) => intervals.set(ms, callback), queueMicrotask,
  });
  return {
    input, sent, requests, storage, sendButton, addPrompt, navigation,
    aiRequests: () => requests.filter((message) => message.type === 'AI_DIALOGUE'),
    notice: () => created.map((node) => node.textContent).join('\n'),
    setBusy(value) { busy = value; }, setActionsReady(value) { actionsReady = value; },
    replyWith(value) { response = value; },
    async sample() { intervals.get(10_000)(); await flush(); },
    async advance(milliseconds, pulse = true) {
      clock += milliseconds;
      if (pulse) intervals.get(1_000)();
      await flush();
      for (let round = 0; round < 20; round += 1) {
        const due = [...timers].filter(([, timer]) => timer.at <= clock);
        if (!due.length) break;
        for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
        await flush();
      }
    },
    async answer(reply = 'A fraudulent message tries to obtain confidential information.') {
      assert.ok(pending.length, 'Expected an AI request before replying');
      pending.shift()({ ok: true, autoDialogue: true, reply });
      await flush();
    },
    async pause() { command({ type: 'COURSE_COMMAND', action: 'pause' }, { id: runtime.id }, () => {}); await flush(); },
  };
}

async function begin(options) {
  const app = coachFixture(options);
  await flush();
  await app.advance(2_500);
  return app;
}

async function finishReply(app, reply) {
  await app.answer(reply);
  await app.advance(150, false);
}

test('Coach helpers recognize exact routes, explicit completion, unavailability and bounded limits', () => {
  assert.equal(dialoguePath('/learn/course/coach/task/title'), true);
  for (const route of ['/learn/course/coach/', '/learn/course/ungradedWidget/task', '/other/learn/course/coach/task']) assert.equal(dialoguePath(route), false);
  for (const text of ['You completed this dialogue!', 'Dialogue completed', 'Диалог завершён']) assert.equal(dialogueComplete(text), true);
  for (const text of ['Almost completed this dialogue', 'If this dialogue is complete', 'Grade: 100%', 'Completed quiz']) assert.equal(dialogueComplete(text), false);
  assert.equal(dialogueUnavailable("I'm currently offline. Come back later."), true);
  assert.equal(dialogueUnavailable('What would you do if a service is offline?'), false);
  assert.equal(dialogueLimit(undefined), 12);
  assert.equal(dialogueLimit(0), 1);
  assert.equal(dialogueLimit(100), 30);
});

test('Coach sends no request without AI and dialogue opt-in', async () => {
  for (const context of [{ autoDialogue: false }, { allowAI: false }, { enabled: false }]) {
    const app = await begin({ context });
    assert.equal(app.aiRequests().length, 0);
    assert.equal(app.sent.length, 0);
  }
});

test('Coach recognizes the live ended-message and Completed badge and advances once without AI or Try again', async () => {
  for (const context of [{}, { allowAI: false, autoDialogue: false }]) {
    const app = await begin({ completion: {}, context });
    await app.advance(10_000);
    assert.deepEqual(app.navigation, { next: 1, retry: 0 });
    assert.equal(app.aiRequests().length, 0);
    assert.equal(app.sent.length, 0);
  }
});

test('Coach does not advance for missing, hidden, historical, active or ambiguous completion signals', async () => {
  for (const completion of [
    { marker: false }, { buttons: false }, { status: '' }, { status: 'Not Completed' },
    { status: 'Almost Completed' }, { status: 'Completed quiz' }, { message: 'The Dialogue is still running.' },
    { hidden: true }, { inHistory: true }, { statusInButton: true }, { composer: true },
    { heading: 'Dialogue completed', inHistory: true }, { heading: 'Dialogue completed', composer: true },
  ]) {
    const app = await begin({ completion, context: { allowAI: false } });
    await app.advance(10_000);
    assert.deepEqual(app.navigation, { next: 0, retry: 0 }, JSON.stringify(completion));
    assert.equal(app.aiRequests().length, 0);
  }
});

test('Coach retains explicit completion-heading support but never advances a paused subject', async () => {
  const complete = await begin({ completion: { heading: 'Dialogue completed', marker: false, buttons: false } });
  assert.equal(complete.navigation.next, 1);
  const paused = await begin({ completion: {}, context: { enabled: false } });
  assert.deepEqual(paused.navigation, { next: 0, retry: 0 });
  assert.equal(paused.aiRequests().length, 0);
});

test('Coach handles two distinct turns with history and never duplicates a waiting turn', async () => {
  const app = await begin();
  assert.equal(app.aiRequests().length, 1);
  await app.advance(10_000);
  assert.equal(app.aiRequests().length, 1);
  await finishReply(app, 'First answer.');
  assert.deepEqual(app.sent, ['First answer.']);
  await app.advance(10_000);
  assert.equal(app.aiRequests().length, 1);
  app.addPrompt('How can phishing be reported?');
  await app.advance(1_000);
  await app.advance(2_500);
  assert.equal(app.aiRequests().length, 2);
  const payload = app.aiRequests()[1].dialogue;
  assert.equal(payload.history.length, 1);
  assert.equal(payload.history[0].reply, 'First answer.');
  await finishReply(app, 'Second answer.');
  assert.deepEqual(app.sent, ['First answer.', 'Second answer.']);
});

test('Coach preserves drafts before generation, during an API request and before clicking send', async () => {
  const existing = await begin({ draft: 'My own draft' });
  assert.equal(existing.aiRequests().length, 0);
  assert.equal(existing.input.value, 'My own draft');
  const duringRequest = await begin();
  duringRequest.input.value = 'Typed while waiting';
  await finishReply(duringRequest, 'Generated response');
  assert.equal(duringRequest.input.value, 'Typed while waiting');
  assert.equal(duringRequest.sent.length, 0);
  const beforeSend = await begin();
  await beforeSend.answer('Generated response');
  beforeSend.input.value = 'Edited by me';
  await beforeSend.advance(150, false);
  assert.equal(beforeSend.input.value, 'Edited by me');
  assert.equal(beforeSend.sent.length, 0);
});

test('Coach drops stale replies after pause, lost ownership and opt-out', async () => {
  for (const loss of ['pause', 'ownership', 'opt-out']) {
    const app = await begin();
    assert.equal(app.aiRequests().length, 1);
    if (loss === 'pause') await app.pause();
    else {
      app.replyWith(loss === 'ownership' ? { ok: true, context: null } : { ok: true, context: { subjectId: 'owned', enabled: true, allowAI: true, autoDialogue: false } });
      await app.sample();
    }
    await finishReply(app, 'Stale response');
    assert.equal(app.input.value, '');
    assert.equal(app.sent.length, 0);
  }
});

test('Coach respects the per-task limit and stops repeated earlier prompts', async () => {
  const limited = await begin({ context: { dialogueMaxTurns: 1 } });
  await finishReply(limited, 'First answer');
  limited.addPrompt('A second question');
  await limited.advance(3_000);
  assert.equal(limited.aiRequests().length, 1);
  assert.match(limited.notice(), /лимит автоответов/u);
  const repeated = await begin();
  await finishReply(repeated, 'First answer');
  repeated.addPrompt('A second question');
  await repeated.advance(1_000);
  await repeated.advance(2_500);
  await finishReply(repeated, 'Second answer');
  repeated.addPrompt('What is phishing?');
  await repeated.advance(3_000);
  assert.equal(repeated.aiRequests().length, 2);
  assert.match(repeated.notice(), /повторил уже обработанный/u);
});

test('Coach rechecks a lowered turn limit after generation and immediately before sending', async () => {
  for (const phase of ['pending-api', 'prepared-draft']) {
    const app = await begin();
    await finishReply(app, 'First answer');
    app.addPrompt('A second question');
    await app.advance(1_000);
    await app.advance(2_500);
    assert.equal(app.aiRequests().length, 2);
    const lowered = { ok: true, context: { subjectId: 'owned', enabled: true, allowAI: true, autoDialogue: true, dialogueMaxTurns: 1, autoSubmit: false } };
    if (phase === 'pending-api') {
      app.replyWith(lowered);
      await finishReply(app, 'Do not send beyond the new limit');
      assert.equal(app.input.value, '', 'The post-response hello must refresh the limit before filling the composer');
    } else {
      await app.answer('Prepared before the limit changed');
      assert.equal(app.input.value, 'Prepared before the limit changed');
      app.replyWith(lowered);
      await app.sample();
      await app.advance(150, false);
      assert.equal(app.input.value, 'Prepared before the limit changed', 'A prepared draft remains available for manual review');
    }
    assert.deepEqual(app.sent, ['First answer']);
    assert.equal(app.aiRequests().length, 2);
    assert.match(app.notice(), /лимит автоответов/u);
    assert.equal(JSON.parse(app.storage.get(STORE_KEY)).turns, 1);
  }
});

test('Coach uses the latest visible prompt rather than historical offline notices', async () => {
  const recovered = await begin({ prompts: ["I'm currently offline. Come back later.", 'What is phishing?'] });
  assert.equal(recovered.aiRequests().length, 1);
  assert.equal(recovered.aiRequests()[0].dialogue.prompt, 'What is phishing?');
  const unavailable = await begin({ prompts: ['What is phishing?', "I'm currently offline. Come back later."] });
  assert.equal(unavailable.aiRequests().length, 0);
  assert.match(unavailable.notice(), /Coach сейчас недоступен/u);
});

test('Coach waits for streaming and the completed-message action toolbar', async () => {
  const app = await begin({ busy: true, actionsReady: false });
  assert.equal(app.aiRequests().length, 0);
  app.setBusy(false);
  await app.advance(10_000);
  assert.equal(app.aiRequests().length, 0);
  app.setActionsReady(true);
  await app.advance(1_000);
  assert.equal(app.aiRequests().length, 0);
  await app.advance(2_500);
  assert.equal(app.aiRequests().length, 1);
});

test('Coach timeouts and reloads never repeat an already sent turn', async () => {
  const app = await begin();
  await finishReply(app, 'Already sent');
  await app.advance(120_001);
  assert.equal(app.aiRequests().length, 1);
  assert.equal(app.sent.length, 1);
  assert.match(app.notice(), /не подтвердил новый вопрос/u);
  const reloaded = await begin({ storage: app.storage });
  assert.equal(reloaded.aiRequests().length, 0);
  assert.equal(reloaded.sent.length, 0);
});

test('Coach reload with pending or corrupt saved state fails closed', async () => {
  const pending = await begin();
  const reloaded = await begin({ storage: pending.storage });
  assert.equal(reloaded.aiRequests().length, 0);
  assert.match(reloaded.notice(), /прерван или не отправлен/u);
  for (const raw of ['', '{', 'null', JSON.stringify({ history: [], sent: [], turns: 1, pending: { status: 'sent', key: fingerprint('What is phishing?') } })]) {
    const app = await begin({ storage: new Map([[STORE_KEY, raw]]) });
    assert.equal(app.aiRequests().length, 0);
    assert.equal(app.sent.length, 0);
    assert.match(app.notice(), /поврежд/u);
  }
});

test('Coach stops before API or sending when its duplicate guard cannot be persisted', async () => {
  class QuotaStore extends Map {
    failWrites = false;
    set(key, value) {
      if (this.failWrites && key === STORE_KEY) throw new Error('QuotaExceededError');
      return super.set(key, value);
    }
  }
  const unavailable = new QuotaStore();
  unavailable.failWrites = true;
  const beforeRequest = await begin({ storage: unavailable });
  assert.equal(beforeRequest.aiRequests().length, 0);
  assert.equal(beforeRequest.sent.length, 0);
  assert.equal(beforeRequest.input.value, '');
  assert.match(beforeRequest.notice(), /Хранилище автоответов недоступно/u);
  await beforeRequest.advance(10_000);
  assert.equal(beforeRequest.aiRequests().length, 0);

  const exhausted = new QuotaStore();
  const beforeSend = await begin({ storage: exhausted });
  assert.equal(beforeSend.aiRequests().length, 1);
  await beforeSend.answer('Keep this prepared draft for manual review.');
  assert.equal(beforeSend.input.value, 'Keep this prepared draft for manual review.');
  exhausted.failWrites = true;
  await beforeSend.advance(150, false);
  assert.equal(beforeSend.sent.length, 0);
  assert.equal(beforeSend.input.value, 'Keep this prepared draft for manual review.');
  assert.equal(JSON.parse(exhausted.get(STORE_KEY)).pending.status, 'pending');
  assert.match(beforeSend.notice(), /Не удалось сохранить защиту от повторной отправки/u);
  await beforeSend.advance(10_000);
  assert.equal(beforeSend.aiRequests().length, 1);
  assert.equal(beforeSend.sent.length, 0);
});

test('Coach bounds outgoing history to six recent pairs and 16000 characters', async () => {
  const history = Array.from({ length: 12 }, (_, index) => ({ prompt: `Old prompt ${index} ${'p'.repeat(3_000)}`, reply: `Reply ${index} ${'r'.repeat(1_000)}` }));
  const raw = JSON.stringify({ history, sent: Array.from({ length: 40 }, (_, index) => `old-${index}`), turns: 12, pending: null });
  const app = await begin({ storage: new Map([[STORE_KEY, raw]]), context: { dialogueMaxTurns: 30 } });
  const payload = app.aiRequests()[0].dialogue;
  assert.ok(payload.history.length <= 6);
  assert.ok(JSON.stringify(payload).length <= 16_000);
  assert.ok(payload.history.at(-1).prompt.startsWith('Old prompt 11'));
  const record = JSON.parse(app.storage.get(STORE_KEY));
  assert.ok(record.history.length <= 6);
  assert.ok(record.sent.length <= 30);
});
