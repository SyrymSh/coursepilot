import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extensionPath = path.resolve('extension');
await mkdir('tmp/browser', { recursive: true });
const profile = await mkdtemp(path.resolve('tmp/browser/profile-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_EXECUTABLE,
  headless: true,
  viewport: { width: 1440, height: 1080 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  await page.waitForSelector('#total-hours');
  const call = (message) => page.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
  const initial = await call({ type: 'GET_STATE' });
  assert.equal(initial.ok, true);
  assert.equal(initial.state.subjects.length, 0);
  for (const [title, programUrl] of [
    ['Software Architecture', 'https://www.coursera.org/specializations/software-design-architecture'],
    ['Information Security Fundamentals', 'https://www.coursera.org/professional-certificates/google-cybersecurity'],
    ['Software Quality Assurance and Testing', 'https://www.coursera.org/specializations/packt-selenium-webdriver-with-java-basics-to-advanced-and-frameworks'],
    ['IT Entrepreneurship & Startup', 'https://www.coursera.org/specializations/it-entrepreneurship-startup'],
  ]) {
    assert.equal((await call({ type: 'ADD_SUBJECT', title, programUrl })).ok, true);
  }
  await page.waitForFunction(() => document.querySelectorAll('.subject-card').length === 4);
  assert.equal(await page.locator('#connection-error').isVisible(), false);
  const exportResult = await call({ type: 'EXPORT_DATA' });
  assert.equal(exportResult.data.subjects.length, 4);
  assert.equal(exportResult.data.subjects.reduce((sum, subject) => sum + subject.targetSeconds, 0), 720000);
  assert.equal(JSON.stringify(exportResult).includes('apiSecret'), false);
  const snapshot = await call({ type: 'GET_STATE' });
  assert.equal(snapshot.state.settings.maxParallel, 4);
  await page.click('#settings-open');
  await page.fill('#window-start', '08:30');
  await page.fill('#window-end', '20:30');
  await page.selectOption('#max-parallel', '3');
  await page.click('#settings-form button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
  assert.equal((await call({ type: 'GET_STATE' })).state.settings.maxParallel, 3);
  await page.click('#add-open');
  await page.fill('#subject-title', '<img src=x onerror=alert(1)>');
  await page.fill('#subject-url', 'https://www.coursera.org/learn/ui-fixture');
  await page.click('#add-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelectorAll('.subject-card').length === 5);
  assert.equal(await page.locator('.subject-title').last().textContent(), '<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('.subject-title img').count(), 0);
  const withExtra = (await call({ type: 'GET_STATE' })).state;
  await call({ type: 'SUBJECT_ACTION', id: withExtra.subjects.at(-1).id, action: 'remove' });
  await page.waitForFunction(() => document.querySelectorAll('.subject-card').length === 4);
  await page.screenshot({ path: 'tmp/browser/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'tmp/browser/dashboard-narrow.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ extensionId: id, checks: ['MV3 worker loaded', 'dashboard messages', 'four subject budgets', 'secret-free export', 'settings form persists', 'add form escapes titles', '390px layout', 'no page errors'], screenshots: ['tmp/browser/dashboard-desktop.png', 'tmp/browser/dashboard-narrow.png'] }, null, 2));
} finally { await context.close(); }
