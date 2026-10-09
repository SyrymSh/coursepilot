(() => {
  'use strict';
  const SOURCE = 'https://d10o6em2qtnr4q.cloudfront.net/assets/d96617fd0cc347daaf2a8420f66905f1/tmp/S30P001-security-analysts-en/index.html';
  if (window.top === window || location.href !== SOURCE || !chrome.runtime?.id) return;
  let clicks = 0;
  let lastClick = 0;

  function visible(element) {
    if (!element?.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function text(element) {
    return String(element.innerText || element.textContent || '').replace(/\s+/gu, ' ').trim();
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'WIDGET_CONTINUE' || sender.id !== chrome.runtime.id) return false;
    if (message.enabled !== true) { respond({ ok: true, status: 'disabled' }); return false; }
    const area = document.querySelector('main');
    if (!area) { respond({ ok: false, status: 'loading' }); return false; }
    const controls = [...area.querySelectorAll('button')].filter(visible);
    const heading = [...area.querySelectorAll('h2')].filter(visible);
    if (heading.some((element) => text(element) === 'Learn to keep organizations secure')) {
      respond({ ok: true, status: clicks > 0 ? 'opened' : 'manual' }); return false;
    }
    const intro = heading.length === 1 && text(heading[0]) === 'Explore: Keep organizations secure' &&
      [...area.querySelectorAll('img[alt="Welcome image"]')].some(visible) &&
      text(area).includes('Explore how entry-level security analysts use a range of skills to help keep organizations secure.');
    const button = controls.length === 1 ? controls[0] : null;
    if (!intro || !button || text(button) !== 'Continue' || button.type !== 'button' || button.closest('form')) {
      respond({ ok: true, status: 'manual' }); return false;
    }
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      respond({ ok: false, status: 'loading' }); return false;
    }
    if (clicks >= 3) { respond({ ok: false, status: 'stalled' }); return false; }
    if (clicks > 0 && Date.now() - lastClick < 2_000 * clicks) {
      respond({ ok: true, status: 'clicked' }); return false;
    }
    clicks += 1;
    lastClick = Date.now();
    button.click();
    respond({ ok: true, status: 'clicked' });
    return false;
  });
})();
