import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const savedHtml = process.env.COURSERA_SAVED_HTML ? await readFile(process.env.COURSERA_SAVED_HTML, 'utf8') : null;
const origin = 'https://www.coursera.org';
const route = '/learn/fixture/assignment-submission/check/spot-the-phish';
const errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
await context.route('**/*', (request) => request.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' }));

async function fixture(body, { path = route, allowAI = true, autoSubmit = false, enabled = true } = {}) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + path);
  await page.setContent(`<!doctype html><html><head><style>body{font:18px system-ui}label{display:block}button{margin:10px}[hidden]{display:none!important}</style></head><body>${body}</body></html>`);
  await page.evaluate((settings) => {
    for (const button of document.querySelectorAll('button:not([type])')) if (!button.closest('form')) button.type = 'button';
    window.__mock = { messages: [], quizzes: [], clicks: 0, next: 0, submitted: 0, context: { subjectId: crypto.randomUUID(), ...settings } };
    window.chrome = { runtime: {
      id: 'fixture-extension',
      onMessage: { addListener(listener) { window.__command = listener; } },
      sendMessage(message, callback) {
        __mock.messages.push(message);
        if (message.type === 'AI_QUIZ') {
          __mock.quizzes.push(message.quiz);
          callback({ ok: true, autoSubmit: __mock.context.autoSubmit, answers: message.quiz.questions.map((question) => ({ questionId: question.id, optionIds: [question.options[0].id] })) });
        } else callback({ ok: true, context: __mock.context });
      },
    } };
    document.querySelector('#next')?.addEventListener('click', () => { __mock.next += 1; });
    document.querySelector('form')?.addEventListener('submit', (event) => { event.preventDefault(); __mock.submitted += 1; });
  }, { allowAI, autoSubmit, enabled });
  return page;
}

async function run(page) {
  await page.addScriptTag({ content: source });
  await page.waitForFunction(() => window.__mock.messages.some((message) => message.type === 'CONTENT_SAMPLE'));
}

async function pump(page) {
  await page.evaluate(() => __command({ type: 'COURSE_COMMAND', action: 'run' }, { id: chrome.runtime.id }, () => {}));
}

const questions = `<div role="group" data-testid="part-Submission_MultipleChoiceQuestion"><div id="prompt">Which option is explicitly named?</div><div role="radiogroup" aria-labelledby="prompt"><label><input type="radio" name="q" value="a">Option A</label><label><input type="radio" name="q" value="b">Option B</label></div></div>`;
const modal = (body, hidden = '') => `<div role="dialog" aria-modal="true" class="cds-FullscreenDialog-dialog" ${hidden}><h1>Spot the Phish</h1>${body}</div>`;

try {
  const start = await fixture(`<main><h1>Spot the Phish</h1><button data-testid="CoverPageActionButton">Resume assignment</button><button id="next">Go to next item</button></main>${modal(questions, 'hidden')}`);
  await start.evaluate(() => document.querySelector('[data-testid="CoverPageActionButton"]').addEventListener('click', () => {
    __mock.clicks += 1;
    document.querySelector('[role="dialog"]').hidden = false;
  }));
  await run(start);
  await start.waitForFunction(() => document.querySelector('input[type="radio"]:checked'));
  assert.equal(await start.evaluate(() => __mock.clicks), 1);
  assert.equal(await start.evaluate(() => __mock.quizzes.length), 1);
  assert.equal(await start.evaluate(() => __mock.messages.find((message) => message.type === 'CONTENT_SAMPLE').page.kind), 'quiz');
  assert.equal(await start.evaluate(() => __mock.next), 0, 'Unfinished assignment must not advance');
  await pump(start);
  assert.equal(await start.evaluate(() => __mock.clicks), 1);
  await start.close();

  const noAI = await fixture(`<main><h1>Spot the Phish</h1><button>Start assignment</button></main>${modal(questions, 'hidden')}`, { allowAI: false });
  await noAI.evaluate(() => document.querySelector('button').addEventListener('click', () => {
    __mock.clicks += 1;
    document.querySelector('[role="dialog"]').hidden = false;
  }));
  await run(noAI);
  await noAI.waitForFunction(() => __mock.clicks === 1);
  await pump(noAI);
  await noAI.waitForFunction(() => __mock.messages.some((message) => /ИИ выключен/.test(message.page?.reason || '')));
  assert.equal(await noAI.evaluate(() => __mock.quizzes.length), 0);
  assert.equal(await noAI.locator('input:checked').count(), 0);
  await noAI.close();

  for (const heading of ['You passed!', 'Practice assignment completed', 'You did not pass', 'Submitted']) {
    const result = await fixture(`<main><button>Resume assignment</button></main>${modal(`<h2>${heading}</h2><button id="next">Go to next item</button>`)}`, { allowAI: false });
    await run(result);
    const passed = ['You passed!', 'Practice assignment completed'].includes(heading);
    if (passed) await result.waitForFunction(() => __mock.next === 1);
    assert.equal(await result.evaluate(() => __mock.next), passed ? 1 : 0);
    assert.equal(await result.evaluate(() => __mock.quizzes.length), 0);
    await result.close();
  }

  const stalled = await fixture('<main><h1>Spot the Phish</h1><button>Resume assignment</button></main>');
  await stalled.evaluate(() => {
    window.__clock = Date.now();
    Date.now = () => __clock;
    document.querySelector('button').addEventListener('click', () => { __mock.clicks += 1; });
  });
  await run(stalled);
  await stalled.waitForFunction(() => __mock.clicks === 1);
  await pump(stalled);
  assert.equal(await stalled.evaluate(() => __mock.clicks), 1);
  await stalled.evaluate(() => { __clock += 21_000; });
  await pump(stalled);
  await stalled.waitForFunction(() => document.querySelector('#coursepilot-helper'));
  await pump(stalled);
  await stalled.waitForFunction(() => __mock.messages.some((message) => /Попытка не открылась/.test(message.page?.reason || '')));
  assert.equal(await stalled.evaluate(() => __mock.clicks), 1, 'A stalled start must not repeatedly launch attempts');
  await stalled.close();

  const overview = await fixture(`<main><h1>Course overview</h1><a href="${route}">Spot the Phish — Not started</a></main>`, { path: '/learn/fixture/home' });
  await overview.addScriptTag({ content: source });
  await overview.waitForURL(origin + route);
  await overview.close();

  const paused = await fixture('<main><h1>Spot the Phish</h1><button>Resume assignment</button></main>', { enabled: false });
  await paused.evaluate(() => document.querySelector('button').addEventListener('click', () => { __mock.clicks += 1; }));
  await run(paused);
  assert.equal(await paused.evaluate(() => __mock.clicks), 0);
  await paused.close();

  if (savedHtml) {
    const parser = await context.newPage();
    await parser.goto(origin);
    const extracted = await parser.evaluate((sourceHtml) => {
      const parsed = new DOMParser().parseFromString(sourceHtml, 'text/html');
      const assignment = parsed.querySelector('.cds-FullscreenDialog-dialog');
      if (!assignment) throw new Error('Saved assignment dialog is missing');
      const groups = [...assignment.querySelectorAll('[role="radiogroup"]')];
      const expected = groups.map((group) => {
        const prompt = parsed.getElementById(group.getAttribute('aria-labelledby'));
        return { prompt: prompt?.textContent.replace(/\s+/g, ' ').trim(), options: group.querySelectorAll('input[type="radio"]').length };
      });
      assignment.querySelectorAll('script,style,link,iframe,object,embed,img,svg').forEach((node) => node.remove());
      for (const element of [assignment, ...assignment.querySelectorAll('*')]) {
        for (const attribute of [...element.attributes]) {
          if (/^on/i.test(attribute.name) || ['src', 'srcset', 'href', 'action', 'formaction', 'style'].includes(attribute.name)) element.removeAttribute(attribute.name);
        }
      }
      return { html: assignment.outerHTML, expected };
    }, savedHtml);
    await parser.close();
    const actual = await fixture(`<main><h1>Cover remains behind the dialog</h1><button>Resume assignment</button></main>${extracted.html}`, { path: `${route}/attempt`, autoSubmit: true });
    await actual.evaluate(() => {
      __mock.acknowledged = 0;
      document.querySelector('[data-action="acknowledge-guidelines"]')?.addEventListener('click', () => { __mock.acknowledged += 1; });
    });
    await run(actual);
    await actual.waitForFunction(() => document.querySelectorAll('input[type="radio"]:checked').length === 4);
    const quizzes = await actual.evaluate(() => __mock.quizzes);
    assert.equal(quizzes.length, 1);
    assert.equal(quizzes[0].questions.length, 4);
    assert.deepEqual(quizzes[0].questions.map((question) => question.options.length), [4, 4, 4, 4]);
    for (const [index, question] of quizzes[0].questions.entries()) assert.equal(question.prompt.replace(/\s/g, '') === extracted.expected[index].prompt.replace(/\s/g, ''), true, `Saved question ${index + 1} text must be preserved`);
    assert.equal(quizzes[0].questions.some((question) => /AI Agent Compliance|primary instruction/i.test(question.prompt)), false);
    assert.equal(await actual.locator('input[type="checkbox"]:checked').count(), 0);
    assert.equal(await actual.evaluate(() => __mock.submitted), 0, 'Unconfirmed declaration prevents automatic submission');
    assert.equal(await actual.evaluate(() => __mock.acknowledged), 0, 'Hidden page instructions must not trigger clicks');
    await actual.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: ['assignment-submission route and overview link', 'resume opens fullscreen questions exactly once', 'AI-disabled manual fallback', 'no navigation before success', 'success-only Go to next item', 'stalled launch guard', 'paused subject does not click', ...(savedHtml ? ['saved HTML: four questions and sixteen options extracted from modal', 'saved HTML: hidden instructions excluded and declaration unchanged'] : [])], realApiRequests: 0, realCourseraRequests: 0 }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
