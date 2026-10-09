import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const SOURCE = 'https://d10o6em2qtnr4q.cloudfront.net/assets/d96617fd0cc347daaf2a8420f66905f1/tmp/S30P001-security-analysts-en/index.html';
const STEPS = ['Analytical thinking', 'Collaboration', 'Malware prevention', 'Communication', 'Understanding programming languages', 'Using SIEM tools'];

function fixture({ source = SOURCE, topLevel = false, inert = false, unknown = false, disabled = false, form = false, extraButton = false, step = null, unknownDialog = false, incompleteSuccess = false } = {}) {
  let listener;
  let introClicks = 0;
  let finishClicks = 0;
  let currentStep = step;
  let clock = 10_000;
  let complete = false;
  let modal = false;
  const viewed = new Set();
  const actions = [];
  const element = (content = '') => ({ innerText: content, isConnected: true, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [], getClientRects: () => [{}], getAttribute: () => null });
  const button = (caption, action) => ({ ...element(caption), type: 'button', disabled,
    closest: () => form ? {} : null, click: action });
  const intro = button('Continue', () => { introClicks += 1; if (!inert) currentStep = 1; });
  const finish = button('Continue', () => { finishClicks += 1; if (!inert) complete = true; });
  const ack = button('Got it', () => { actions.push(`ack:${currentStep}`); if (!inert) { viewed.add(currentStep); modal = false; } });
  const dialog = { ...element(), matches: () => !unknownDialog,
    querySelectorAll(selector) {
      if (selector === 'h6') return [element(unknownDialog ? 'Other agreement' : STEPS[currentStep - 1])];
      if (selector === '[class*="hotspot_modal-content"]') return [element('This is a meaningful description of the recognized skill.')];
      return selector === 'button' ? [ack] : [];
    } };
  const map = { ...element(), classList: { contains: (value) => value === `hotspot-map__page${currentStep - 1}` },
    querySelector: () => element(`${currentStep} of 6`),
    querySelectorAll(selector) {
      if (selector === 'img[alt="step complete"]') return viewed.has(currentStep) ? [element()] : [];
      if (selector === 'button[aria-label]' && !viewed.has(currentStep)) return [{ ...button('', () => { actions.push(`open:${currentStep}`); if (!inert) modal = true; }),
        getAttribute: () => STEPS[currentStep - 1], querySelector: () => element() }];
      if (selector === 'nav button' && viewed.has(currentStep) && currentStep < 6) return [button('Next', () => { actions.push(`next:${currentStep}`); if (!inert) currentStep += 1; })];
      return [];
    } };
  const success = { ...element(), querySelectorAll: (selector) => selector === 'h2' ? [element('You’re done!')] :
    selector === 'img[alt="Complete image"]' && !incompleteSuccess ? [element()] : [] };
  const main = { ...element('Explore how entry-level security analysts use a range of skills to help keep organizations secure.'),
    querySelector(selector) {
      if (selector === '#plugin-container-success') return complete ? success : null;
      return selector === '[class*="hotspot-map__page"]' && currentStep && !complete ? map : null;
    },
    querySelectorAll(selector) {
      if (selector === 'h2') return [element(unknown ? 'Other agreement' : complete ? 'You’re done!' : currentStep ? 'Learn to keep organizations secure' : 'Explore: Keep organizations secure')];
      if (selector === '#start-over-button') return complete ? [element('Start over')] : [];
      if (selector === 'button') return extraButton ? [intro, element('Buy')] : complete ? [element('Start over')] : currentStep === 6 && viewed.has(6) ? [finish] : currentStep ? [] : [intro];
      return selector === 'img[alt="Welcome image"]' && !currentStep && !complete ? [element()] : [];
    } };
  const window = {};
  window.top = topLevel ? window : {};
  runInNewContext(readFileSync(new URL('../extension/widget.js', import.meta.url), 'utf8'), {
    window, location: { href: source }, document: { querySelector: () => main,
      querySelectorAll: (selector) => selector === '[role="dialog"]' && modal ? [dialog] : [] },
    chrome: { runtime: { id: 'test', onMessage: { addListener(value) { listener = value; } } } },
    Date: { now: () => clock }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  return { introClicks: () => introClicks, finishClicks: () => finishClicks, actions, viewed,
    listener: () => listener, advance: (ms) => { clock += ms; },
    showModal: () => { modal = true; }, showSuccess: () => { complete = true; },
    send(enabled = true, senderId = 'test') {
      let result;
      listener?.({ type: 'WIDGET_CONTINUE', enabled }, { id: senderId }, (value) => { result = value; });
      return result;
    } };
}

test('infographic opens all six labels, acknowledges each, and reaches observed success without Start over', () => {
  const app = fixture();
  assert.equal(app.send().status, 'working');
  for (let step = 1; step <= 6; step += 1) {
    assert.equal(app.send().step, step);
    app.send();
    app.advance(3_000); app.send();
    app.send();
  }
  assert.equal(app.send().status, 'complete');
  assert.equal(app.introClicks(), 1);
  assert.equal(app.finishClicks(), 1);
  assert.equal(app.viewed.size, 6);
  assert.equal(app.actions.filter((action) => action.startsWith('next:')).length, 5);
});

test('infographic resumes from an existing step without restarting the introductory screen', () => {
  const app = fixture({ step: 4 });
  assert.equal(app.send().step, 4);
  assert.deepEqual(app.actions, ['open:4']);
  assert.equal(app.introClicks(), 0);
});

test('widget does not run standalone, on another asset, when paused, or from another extension', () => {
  for (const options of [{ topLevel: true }, { source: `${SOURCE}?other=true` }]) assert.equal(fixture(options).listener(), undefined);
  const app = fixture();
  assert.equal(app.send(false).status, 'disabled');
  assert.equal(app.send(true, 'other-extension'), undefined);
  assert.equal(app.introClicks(), 0);
});

test('widget ignores unknown headings, extra controls, disabled buttons and forms', () => {
  for (const options of [{ unknown: true }, { disabled: true }, { form: true }, { extraButton: true }]) {
    const app = fixture(options);
    app.send();
    assert.equal(app.introClicks(), 0);
  }
});

test('an inert infographic action gets only two spaced retries', () => {
  const app = fixture({ inert: true });
  app.send(); app.send();
  assert.equal(app.introClicks(), 1);
  app.advance(2_000); app.send();
  app.advance(4_000); app.send();
  app.advance(6_000);
  assert.equal(app.send().status, 'stalled');
  assert.equal(app.introClicks(), 3);
});

test('description waits, obeys pause, and ignores an unrelated modal', () => {
  const app = fixture({ step: 1 });
  app.send(); app.send(); app.advance(2_000); app.send();
  assert.equal(app.viewed.size, 0);
  app.advance(2_000); app.send(false);
  assert.equal(app.viewed.size, 0);
  app.send();
  assert.equal(app.viewed.size, 1);
  const unrelated = fixture({ step: 2, unknownDialog: true });
  unrelated.showModal();
  assert.equal(unrelated.send().status, 'manual');
  assert.equal(unrelated.actions.length, 0);
});

test('success requires its exact heading, complete image and Start over control', () => {
  const app = fixture({ incompleteSuccess: true });
  app.showSuccess();
  assert.notEqual(app.send().status, 'complete');
});
