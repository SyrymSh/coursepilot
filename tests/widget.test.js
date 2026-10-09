import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const SOURCE = 'https://d10o6em2qtnr4q.cloudfront.net/assets/d96617fd0cc347daaf2a8420f66905f1/tmp/S30P001-security-analysts-en/index.html';

function fixture({ source = SOURCE, topLevel = false, inert = false, unknown = false, disabled = false, form = false, extraButton = false } = {}) {
  let listener;
  let clicks = 0;
  let opened = false;
  let clock = 10_000;
  const element = (content) => ({ innerText: content, isConnected: true, closest: () => null,
    getClientRects: () => [{}], getAttribute: () => null });
  const button = { ...element('Continue'), type: 'button', disabled, closest: () => form ? {} : null,
    click() { clicks += 1; if (!inert) opened = true; } };
  const main = { ...element('Explore how entry-level security analysts use a range of skills to help keep organizations secure.'),
    querySelectorAll(selector) {
      if (selector === 'h2') return [element(opened ? 'Learn to keep organizations secure' : unknown ? 'Other agreement' : 'Explore: Keep organizations secure')];
      if (selector === 'button') return extraButton ? [button, element('Buy')] : [button];
      return selector === 'img[alt="Welcome image"]' ? [element('')] : [];
    } };
  const window = {};
  window.top = topLevel ? window : {};
  runInNewContext(readFileSync(new URL('../extension/widget.js', import.meta.url), 'utf8'), {
    window, location: { href: source }, document: { querySelector: () => main },
    chrome: { runtime: { id: 'test', onMessage: { addListener(value) { listener = value; } } } },
    Date: { now: () => clock }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  return { clicks: () => clicks, listener: () => listener, advance: (ms) => { clock += ms; },
    send(enabled = true, senderId = 'test') {
      let result;
      listener?.({ type: 'WIDGET_CONTINUE', enabled }, { id: senderId }, (value) => { result = value; });
      return result;
    } };
}

test('known infographic Continue opens once and only an observed next screen confirms it', () => {
  const app = fixture();
  assert.equal(app.send().status, 'clicked');
  assert.equal(app.send().status, 'opened');
  assert.equal(app.clicks(), 1);
});

test('widget Continue does not run standalone, on another asset, when paused, or from another extension', () => {
  for (const options of [{ topLevel: true }, { source: `${SOURCE}?other=true` }]) assert.equal(fixture(options).listener(), undefined);
  const app = fixture();
  assert.equal(app.send(false).status, 'disabled');
  assert.equal(app.send(true, 'other-extension'), undefined);
  assert.equal(app.clicks(), 0);
});

test('widget ignores unknown headings, extra controls, disabled buttons and forms', () => {
  for (const options of [{ unknown: true }, { disabled: true }, { form: true }, { extraButton: true }]) {
    const app = fixture(options);
    assert.notEqual(app.send().status, 'clicked');
    assert.equal(app.clicks(), 0);
  }
});

test('an inert widget Continue gets only two spaced retries', () => {
  const app = fixture({ inert: true });
  app.send();
  app.send();
  assert.equal(app.clicks(), 1);
  app.advance(2_000); app.send();
  app.advance(4_000); app.send();
  app.advance(6_000);
  assert.equal(app.send().status, 'stalled');
  assert.equal(app.clicks(), 3);
});
