(() => {
  'use strict';
  const SOURCE = 'https://d10o6em2qtnr4q.cloudfront.net/assets/d96617fd0cc347daaf2a8420f66905f1/tmp/S30P001-security-analysts-en/index.html';
  if (window.top === window || location.href !== SOURCE || !chrome.runtime?.id) return;
  const STEPS = ['Analytical thinking', 'Collaboration', 'Malware prevention', 'Communication', 'Understanding programming languages', 'Using SIEM tools'];
  const attempts = new Map();
  let modalSeen = null;

  function visible(element) {
    if (!element?.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function text(element) {
    return String(element?.innerText || element?.textContent || '').replace(/\s+/gu, ' ').trim();
  }

  function elements(root, selector) {
    return [...root.querySelectorAll(selector)].filter(visible);
  }

  function act(button, key, step = null) {
    if (!button || !visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true' || button.closest('form')) {
      return { ok: false, status: 'loading' };
    }
    const previous = attempts.get(key);
    if (previous && Date.now() - previous.at < 2_000 * previous.clicks) return { ok: true, status: 'working', step };
    if (previous?.clicks >= 3) return { ok: false, status: 'stalled' };
    attempts.set(key, { clicks: (previous?.clicks || 0) + 1, at: Date.now() });
    button.click();
    return { ok: true, status: 'working', step };
  }

  function completed(area) {
    const success = area.querySelector('#plugin-container-success');
    return visible(success) && elements(success, 'h2').some((heading) => /^You[’']re done!$/u.test(text(heading))) &&
      elements(success, 'img[alt="Complete image"]').length === 1 &&
      elements(area, '#start-over-button').some((button) => text(button) === 'Start over');
  }

  function stepInfo(area) {
    const map = area.querySelector('[class*="hotspot-map__page"]');
    const count = text(map?.querySelector('[class*="linear-navigation_count"]')).match(/^([1-6]) of 6$/u);
    const step = count ? Number(count[1]) : null;
    if (!map || !step || !map.classList.contains(`hotspot-map__page${step - 1}`)) return null;
    const headings = [...area.querySelectorAll('h2')];
    if (!headings.some((heading) => text(heading) === 'Learn to keep organizations secure')) return null;
    return { map, step, name: STEPS[step - 1] };
  }

  function closeDescription(dialog, info) {
    const headings = elements(dialog, 'h6');
    const copy = elements(dialog, '[class*="hotspot_modal-content"]');
    const buttons = elements(dialog, 'button');
    if (!dialog.matches('.MuiDialog-paper') || headings.length !== 1 || text(headings[0]) !== info.name ||
      copy.length !== 1 || text(copy[0]).length < 20 || buttons.length !== 1 || !/^Got it$/iu.test(text(buttons[0]))) {
      return { ok: true, status: 'manual' };
    }
    if (modalSeen?.dialog !== dialog) modalSeen = { dialog, at: Date.now() };
    if (Date.now() - modalSeen.at < 3_000) return { ok: true, status: 'working', step: info.step };
    return act(buttons[0], `ack:${info.step}`, info.step);
  }

  function advanceInfographic(area, info) {
    const incomplete = elements(info.map, 'button[aria-label]')
      .filter((button) => button.getAttribute('aria-label') === info.name && button.querySelector('img[alt="step incomplete"]'));
    if (incomplete.length === 1) return act(incomplete[0], `open:${info.step}`, info.step);
    if (incomplete.length > 1 || elements(info.map, 'img[alt="step complete"]').length !== 1) return { ok: true, status: 'manual' };
    if (info.step < 6) {
      const next = elements(info.map, 'nav button').filter((button) => /^Next$/iu.test(text(button)));
      return next.length === 1 ? act(next[0], `next:${info.step}`, info.step) : { ok: false, status: 'loading' };
    }
    const finish = elements(area, 'button').filter((button) => text(button) === 'Continue');
    return finish.length === 1 ? act(finish[0], 'finish', info.step) : { ok: false, status: 'loading' };
  }

  function drive() {
    const area = document.querySelector('main');
    if (!area) return { ok: false, status: 'loading' };
    if (completed(area)) return { ok: true, status: 'complete' };
    const dialogs = elements(document, '[role="dialog"]');
    const info = stepInfo(area);
    if (dialogs.length) {
      return info && dialogs.length === 1 ? closeDescription(dialogs[0], info) : { ok: true, status: 'manual' };
    }
    modalSeen = null;
    if (info) return advanceInfographic(area, info);
    const headings = elements(area, 'h2');
    const buttons = elements(area, 'button');
    const intro = headings.length === 1 && text(headings[0]) === 'Explore: Keep organizations secure' &&
      elements(area, 'img[alt="Welcome image"]').length === 1 &&
      text(area).includes('Explore how entry-level security analysts use a range of skills to help keep organizations secure.');
    if (!headings.length || !buttons.length) return { ok: false, status: 'loading' };
    return intro && buttons.length === 1 && text(buttons[0]) === 'Continue' && buttons[0].type === 'button'
      ? act(buttons[0], 'intro') : { ok: true, status: 'manual' };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'WIDGET_CONTINUE' || sender.id !== chrome.runtime.id) return false;
    if (message.enabled !== true) { respond({ ok: true, status: 'disabled' }); return false; }
    respond(drive());
    return false;
  });
})();
