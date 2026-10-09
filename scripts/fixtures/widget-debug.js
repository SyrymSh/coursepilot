(() => {
  const byId = (id) => document.getElementById(id);
  const data = { enabled: true, intro: 0, labels: 0, acknowledgements: 0, internalNext: 0, finish: 0, marks: 0, next: 0, ai: 0, errors: [] };
  const pending = new Map();
  let sequence = 0;
  let command;
  byId('widget-frame').src = `${location.origin}/widget-frame.html`;
  function render() {
    byId('counts').textContent = `${data.intro} intro Continue · ${data.labels}/6 labels opened · ${data.acknowledgements}/6 Got it\n${data.internalNext}/5 internal Next · ${data.finish} final Continue · ${data.marks} Mark as completed\n${data.next} next material · ${data.ai} AI requests · ${data.errors.length} errors`;
    byId('summary').textContent = data.errors.length ? data.errors.join(' / ') : data.next ? 'PASS · six labels → success → one mark → one continuation' : data.enabled ? 'Running automatically…' : 'Subject paused';
  }
  const context = () => ({ ok: true, context: { subjectId: 'local-infographic', enabled: data.enabled, allowAI: false } });
  window.chrome = { runtime: { id: 'local-widget-fixture', onMessage: { addListener(listener) { command = listener; } },
    sendMessage(message, callback) {
      if (message.type === 'CONTENT_WIDGET_CONTINUE') {
        const id = ++sequence;
        pending.set(id, callback);
        byId('widget-frame').contentWindow.postMessage({ type: 'fixture:drive', id, enabled: data.enabled }, location.origin);
      } else {
        if (message.type.startsWith('AI_')) data.ai += 1;
        if (message.type === 'CONTENT_SAMPLE' && message.page.reason) { data.errors.push(message.page.reason); data.enabled = false; }
        callback(context());
      }
      render();
    } } };
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== byId('widget-frame').contentWindow) return;
    if (event.data?.type === 'fixture:reply') {
      const callback = pending.get(event.data.id);
      pending.delete(event.data.id);
      callback?.(event.data.response);
    } else if (event.data?.type === 'fixture:counts') {
      for (const key of ['intro', 'labels', 'acknowledgements', 'internalNext', 'finish']) data[key] = event.data.counts[key];
    }
    render();
  });
  byId('completion-form').addEventListener('submit', (event) => {
    event.preventDefault(); data.marks += 1;
    if (data.labels !== 6 || data.acknowledgements !== 6 || data.finish !== 1) data.errors.push('Premature Mark as completed');
    setTimeout(() => {
      byId('item-link').setAttribute('aria-label', 'selected link, Ungraded Plugin, Explore: Keep organizations secure, Completed, 10 min');
      const icon = document.createElement('span');
      icon.setAttribute('data-testid', 'learn-item-success-icon'); icon.textContent = ' ✓';
      byId('item-link').append(icon);
      byId('completion-form').hidden = true; byId('next').hidden = false; render();
    }, 500);
    render();
  });
  byId('next').addEventListener('click', () => {
    data.next += 1;
    history.pushState({}, '', '/learn/foundations-of-cybersecurity/supplement/next/fixture');
    byId('widget-frame').hidden = true; byId('next').hidden = true; byId('next-copy').hidden = false;
    byId('lesson-title').textContent = 'Next local material'; render();
  });
  byId('pause').addEventListener('click', () => { data.enabled = false; command?.({ type: 'COURSE_COMMAND', action: 'pause' }, { id: chrome.runtime.id }, () => {}); render(); });
  byId('resume').addEventListener('click', () => { data.enabled = true; command?.({ type: 'COURSE_COMMAND', action: 'run', explicit: true }, { id: chrome.runtime.id }, () => {}); render(); });
  window.addEventListener('error', (event) => { data.errors.push(event.message); render(); });
  render();
})();
