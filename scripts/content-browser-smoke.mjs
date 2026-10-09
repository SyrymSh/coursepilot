import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extensionPath = path.resolve('extension');
const origin = 'https://www.coursera.org';
const programPath = '/specializations/coursepilot-fixture-architecture';
const readingPath = '/learn/cp-architecture/supplement/read/intro';
const quizPath = '/learn/cp-quiz/assignment-submission/check/quiz';

const html = (title, body) => `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title><style>body{font:18px system-ui;margin:32px;line-height:1.6}main{max-width:880px}a{display:block;margin:12px}fieldset{margin:18px 0;padding:22px}label{display:block;padding:12px}</style></head><body><header>Local Coursera fixture — no real account</header><main><h1>${title}</h1>${body}</main></body></html>`;
const fixtures = new Map([
  [programPath, html('Fixture architecture program', `
    <section id="courses"><h2>Courses</h2><ul>
      <li><a href="/learn/cp-architecture">Architecture foundations</a><p>10 hours</p></li>
      <li><a href="/learn/cp-extra">Architecture extension</a><p>15 hours</p></li>
    </ul></section>
    <aside><h2>Recommended for you</h2><a href="/learn/cp-recommended">Unrelated recommendation</a></aside>`) ],
  ['/learn/cp-architecture', html('Architecture foundations', '<a href="/learn/cp-architecture/home">Go to course</a>')],
  ['/learn/cp-architecture/home', html('Architecture course home', `
    <ul><li data-completed="true"><a href="/learn/cp-architecture/lecture/old/completed">Previous lesson — Completed</a></li>
    <li data-completed="false"><a href="${readingPath}">Reading introduction — Not started</a></li>
    <li data-completed="false"><a href="/learn/cp-architecture/lecture/future/next">Later video — Not started</a></li></ul>`) ],
  [readingPath, html('Reading architecture', `
    <h2>Course completed</h2><p>This heading is lesson text. It is deliberately not course completion evidence.</p>
    <p>Read the introduction. An idle tab must never add time. Native content injection will show its own reading control.</p>
    <p>${'A component has a clear contract and explicit dependencies. '.repeat(35)}</p>
    <a href="/learn/cp-architecture/lecture/future/next">Next</a>`) ],
  ['/learn/cp-quiz', html('Quiz fixture', '<a href="/learn/cp-quiz/home">Go to course</a>')],
  ['/learn/cp-quiz/home', html('Quiz course home', `<ul><li><a href="${quizPath}">Knowledge check — Not started</a></li></ul>`) ],
  [quizPath, html('Knowledge check', `<button type="button" data-testid="CoverPageActionButton" onclick="location.assign('${quizPath}/attempt')">Resume assignment</button>`) ],
  [`${quizPath}/attempt`, html('Knowledge check', `
    <form><fieldset><legend>Which design has explicit dependencies?</legend>
      <label><input type="radio" name="question-one" value="one">A constructor receives its dependency.</label>
      <label><input type="radio" name="question-one" value="two">A hidden global provides every dependency.</label>
    </fieldset>
    <label><input id="honor" type="checkbox">I certify this is my own work and accept the Honor Code.</label>
    <button type="submit">Submit</button></form>`) ],
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function eventually(read, predicate, description, timeout = 25_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await read();
    if (predicate(last)) return last;
    await delay(250);
  }
  throw new Error(`${description}: ${JSON.stringify(last)}`);
}

async function within(promise, timeout, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), timeout); })]);
  } finally { clearTimeout(timer); }
}

await mkdir('tmp/browser', { recursive: true });
const profile = await mkdtemp(path.resolve('tmp/browser/content-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_EXECUTABLE,
  headless: true,
  viewport: { width: 1440, height: 1080 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
const errors = [];
const unexpectedRequests = [];
const requestedPaths = [];
const subjectIds = [];
let call;
let worker;
try {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (!['www.coursera.org', 'coursera.org'].includes(url.hostname)) return route.abort();
    requestedPaths.push(url.pathname);
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    const fixture = fixtures.get(url.pathname);
    if (!fixture) {
      unexpectedRequests.push(url.pathname);
      return route.fulfill({ status: 404, contentType: 'text/html', body: html('Unexpected fixture request', '<p>No external network request was made.</p>') });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  const dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await dashboard.waitForSelector('#total-hours');
  call = (message) => dashboard.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
  const getState = async () => (await call({ type: 'GET_STATE' })).state;
  const bindFixtureTab = async (subjectId, url) => {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector('main');
    await worker.evaluate(async ({ id, fixtureUrl }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((item) => item.url === fixtureUrl);
      if (!tab) throw new Error('Known fixture tab is missing');
      const stored = await chrome.storage.local.get('coursepilotState');
      const subject = stored.coursepilotState.subjects.find((item) => item.id === id);
      subject.tabId = tab.id;
      subject.lastUrl = fixtureUrl;
      await chrome.storage.local.set(stored);
    }, { id: subjectId, fixtureUrl: url });
    return page;
  };
  const settingsResult = await call({ type: 'UPDATE_SETTINGS', settings: { timeZone: 'UTC', windowStart: '00:00', windowEnd: '23:59', maxParallel: 4 } });
  assert.equal(settingsResult.ok, true);

  const added = await call({ type: 'ADD_SUBJECT', title: 'Architecture fixture', programUrl: origin + programPath });
  assert.equal(added.ok, true);
  const architectureId = added.state.subjects[0].id;
  subjectIds.push(architectureId);
  await bindFixtureTab(architectureId, origin + programPath);
  assert.equal((await call({ type: 'SUBJECT_ACTION', id: architectureId, action: 'open' })).ok, true);
  await eventually(getState, (state) => state.subjects.find((subject) => subject.id === architectureId).courses.length === 2, 'Curriculum scan did not produce exactly two courses');
  const scanned = (await getState()).subjects.find((subject) => subject.id === architectureId);
  assert.deepEqual(scanned.courses.map((course) => course.url), [`${origin}/learn/cp-architecture/home`, `${origin}/learn/cp-extra/home`]);

  const start = await within(call({ type: 'SUBJECT_ACTION', id: architectureId, action: 'start' }), 6_000, 'Start action deadlocked against a content command');
  assert.equal(start.ok, true);
  await eventually(async () => context.pages().map((page) => page.url()), (urls) => urls.includes(origin + readingPath), 'Overview did not navigate to the first pending lesson');
  const readingPage = context.pages().find((page) => page.url() === origin + readingPath);
  await readingPage.waitForSelector('#coursepilot-helper');
  await dashboard.bringToFront();
  await delay(11_000);
  const idle = (await getState()).subjects.find((subject) => subject.id === architectureId);
  assert.equal(idle.status, 'running');
  assert.equal(idle.courses.reduce((total, course) => total + course.seconds, 0), 0);
  assert.equal(idle.courses.some((course) => course.status === 'completed'), false);
  assert.equal(requestedPaths.includes('/learn/cp-architecture/lecture/old/completed'), false);
  assert.equal(requestedPaths.includes('/learn/cp-recommended'), false);
  await readingPage.screenshot({ path: 'tmp/browser/content-reading.png', fullPage: true });

  const addedQuiz = await call({ type: 'ADD_SUBJECT', title: 'Quiz fixture', programUrl: `${origin}/learn/cp-quiz` });
  assert.equal(addedQuiz.ok, true);
  const quizId = addedQuiz.state.subjects.find((subject) => subject.title === 'Quiz fixture').id;
  subjectIds.push(quizId);
  await bindFixtureTab(quizId, `${origin}/learn/cp-quiz/home`);
  assert.equal((await within(call({ type: 'SUBJECT_ACTION', id: quizId, action: 'start' }), 6_000, 'Parallel subject start deadlocked')).ok, true);
  const blocked = await eventually(getState, (state) => state.subjects.find((subject) => subject.id === quizId).status === 'blocked', 'Unavailable AI did not pause its own subject');
  assert.equal(blocked.subjects.find((subject) => subject.id === architectureId).status, 'running');
  assert.match(blocked.subjects.find((subject) => subject.id === quizId).reason, /ИИ|тест/iu);
  const quizPage = context.pages().find((page) => page.url() === origin + quizPath + '/attempt');
  assert.ok(quizPage, 'The quiz fixture must remain open for manual work');
  assert.equal(await quizPage.locator('#honor').isChecked(), false);
  assert.equal(await quizPage.locator('input[type="radio"]:checked').count(), 0);
  assert.equal(blocked.subjects.find((subject) => subject.id === architectureId).courses.reduce((sum, course) => sum + course.seconds, 0), 0);
  for (const id of subjectIds) assert.equal((await within(call({ type: 'SUBJECT_ACTION', id, action: 'pause' }), 6_000, 'Pause command deadlocked')).ok, true);
  assert.deepEqual(unexpectedRequests, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    extensionId,
    checks: [
      'Actual MV3 content injection on routed local Coursera fixtures',
      'Curriculum discovery excludes recommended courses',
      'Start and pause commands do not deadlock',
      'Overview skips completed lesson and opens first pending item',
      'Idle reading contributes zero seconds',
      'Lesson heading cannot imply course completion',
      'Unavailable AI blocks only its own parallel subject',
      'Assignment-submission cover opens attempt before manual fallback',
      'Honor-code checkbox and unanswered quiz remain unchanged',
      'All Coursera requests intercepted; no real account used',
      'No unexpected navigation or page errors',
    ],
    screenshot: 'tmp/browser/content-reading.png',
  }, null, 2));
} catch (error) {
  const pages = [];
  for (const page of context.pages().filter((item) => item.url().startsWith(origin))) {
    pages.push(await page.evaluate(() => ({
      url: location.href, title: document.title, readyState: document.readyState,
      curriculum: document.querySelector('#courses')?.outerHTML || null,
      anchors: [...document.querySelectorAll('a[href]')].map((anchor) => ({ href: anchor.href, label: anchor.textContent })),
      widget: Boolean(document.getElementById('coursepilot-helper')),
      body: document.body?.innerText.slice(0, 1500),
    })).catch((readError) => ({ error: readError.message })));
    await page.screenshot({ path: `tmp/browser/content-failure-${pages.length}.png`, fullPage: true }).catch(() => {});
  }
  const inspections = worker && await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: ['https://www.coursera.org/*', 'https://coursera.org/*'] });
    return Promise.all(tabs.map(async (tab) => {
      try {
        const reply = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { type: 'COURSE_COMMAND', action: 'inspect' }),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2000)),
        ]);
        return { tabId: tab.id, url: tab.url, reply };
      } catch (inspectionError) { return { tabId: tab.id, url: tab.url, error: inspectionError.message }; }
    }));
  }).catch((inspectionError) => ({ error: inspectionError.message }));
  console.error(JSON.stringify({ failure: error.message, requestedPaths, unexpectedRequests, errors, pages, inspections }, null, 2));
  throw error;
} finally {
  if (call) for (const id of subjectIds) {
    await within(call({ type: 'SUBJECT_ACTION', id, action: 'pause' }), 4_000, 'Cleanup pause timed out').catch(() => {});
  }
  await context.close();
}
