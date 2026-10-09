(() => {
  'use strict';

  const scenario = new URLSearchParams(location.search).get('scenario') || 'chain';
  const stages = scenario === 'chain' ? ['passed', 'unsupported', 'timed'] : [scenario];
  const byId = (id) => document.getElementById(id);
  const pathFor = (stage) => `/learn/navigation-fixture/assignment-submission/${stage}/cover`;
  const names = { passed: 'Test your knowledge: The history of cybersecurity', unsupported: 'Unknown interaction at end of Module 2', timed: 'Graded Exam', done: 'Navigation regression complete' };
  const state = {
    scenario, stage: stages[0], index: 0, nextClicks: 0, starts: 0, cancellations: 0,
    continues: 0, consumedAttempts: 0, aiRequests: 0, submissions: 0,
    completionMarks: 0, restartedAttempts: 0, feedbackClicks: 0, blockedNextClicks: 0,
    skippedItems: [], transitions: [], messages: [], samples: [], errors: [], reason: '', blocked: false,
    context: { subjectId: `navigation-${scenario}`, enabled: true, skipManual: true, allowAI: true, canRetryAI: true, autoSubmit: true, autoDialogue: false, autoHonorCode: false },
  };

  function render() {
    const completed = state.stage === 'done';
    const expectedSkips = scenario === 'chain' ? 2 : scenario === 'passed' ? 0 : 1;
    const expectedCancel = stages.includes('timed') ? 1 : 0;
    const safe = state.continues === 0 && state.consumedAttempts === 0 && state.aiRequests === 0 && state.submissions === 0 && state.completionMarks === 0 && state.restartedAttempts === 0 && state.errors.length === 0;
    const verified = completed && safe && state.nextClicks === stages.length && state.skippedItems.length === expectedSkips && state.cancellations === expectedCancel;
    byId('result-line').textContent = `${verified ? 'PASS' : completed ? 'CHECK COUNTERS' : state.blocked ? 'BLOCKED' : 'RUNNING'} · ${state.nextClicks}/${stages.length} transitions · ${state.skippedItems.length}/${expectedSkips} unfinished records · ${state.cancellations}/${expectedCancel} cancellations · ${state.consumedAttempts} consumed attempts · ${state.aiRequests} AI requests`;
    byId('resume-fixture').disabled = completed;
    byId('diagnostics').textContent = JSON.stringify({
      ...state, currentPath: location.pathname, verified, expectedSkips, expectedCancel,
      ready: { harness: true, content: window.__COURSEPILOT_CONTENT__ === true, commandListener: typeof window.navigationCommand === 'function' },
      samples: state.samples.slice(-5), messages: state.messages.slice(-12),
    }, null, 2);
  }

  function showStage(stage) {
    state.stage = stage;
    byId('fixture-title').textContent = names[stage] || 'Unknown fixture scenario';
    byId('assignment-type').textContent = stage === 'timed' ? 'Graded Assignment' : 'Practice Assignment';
    byId('passed-cover').hidden = stage !== 'passed';
    byId('unsupported-cover').hidden = stage !== 'unsupported';
    byId('timed-cover').hidden = stage !== 'timed';
    byId('terminal').hidden = stage !== 'done';
    byId('footer-next').hidden = stage === 'done';
    byId('timed-modal').hidden = stage !== 'timed';
    byId('outline').innerHTML = [
      ['Module 1', 'passed'], ['Module 2', 'unsupported'], ['Module 3', 'timed'], ['Module 4', 'done'],
    ].map(([module, item]) => `<section><h2>${module}</h2><ul><li${item === 'passed' ? ' data-completed="true"' : ''}><a href="${pathFor(item)}"${stage === item ? ' aria-current="page"' : ''}${item === 'passed' ? ' aria-label="Practice Assignment, The history of cybersecurity, Completed, Grade: 100%"' : ''}>${names[item]}</a></li></ul></section>`).join('');
    render();
  }

  function response() { return { ok: true, context: { ...state.context } }; }

  window.chrome = { runtime: {
    id: 'navigation-fixture-extension',
    onMessage: { addListener(listener) { window.navigationCommand = listener; } },
    sendMessage(message, callback) {
      state.messages.push(message.type);
      if (state.messages.length > 100) state.messages.shift();
      if (message.type === 'CONTENT_SAMPLE') {
        state.samples.push({ kind: message.page.kind, reason: message.page.reason || '', seconds: message.seconds });
        if (state.samples.length > 100) state.samples.shift();
        if (message.page.reason) {
          state.reason = message.page.reason;
          state.blocked = true;
          state.context.enabled = false;
        }
      }
      if (message.type === 'CONTENT_SKIP_MANUAL') {
        if (!state.context.enabled || !state.context.skipManual) {
          callback({ ok: false, error: 'Fixture skip was requested without enabled context.' });
          render(); return;
        }
        if (!state.skippedItems.some((item) => item.url === message.url)) state.skippedItems.push({ url: message.url, title: message.itemTitle, reason: message.reason, code: message.code });
      }
      if (message.type === 'AI_QUIZ' || message.type === 'AI_DIALOGUE') {
        state.aiRequests += 1;
        state.errors.push('Unexpected AI call in a navigation-only fixture.');
        callback({ ok: false, error: 'No fixture API configured; no request sent.' });
        render(); return;
      }
      if (['CONTENT_RETRY_QUIZ', 'CONTENT_RETRY_DIALOGUE'].includes(message.type)) {
        state.blocked = false; state.reason = ''; state.context.enabled = true;
      }
      callback(response());
      render();
    },
  } };

  function next() {
    if (!byId('timed-modal').hidden) {
      state.blockedNextClicks += 1;
      state.errors.push('Next was clicked before cancelling the timed dialog.');
      render(); return;
    }
    state.nextClicks += 1;
    state.transitions.push({ from: state.stage, module: state.index + 1 });
    state.index += 1;
    const stage = stages[state.index] || 'done';
    if (stage === 'done') state.context.enabled = false;
    history.pushState({}, '', `${pathFor(stage)}?scenario=${encodeURIComponent(scenario)}`);
    showStage(stage);
  }

  for (const id of ['next-top', 'next-bottom', 'unsupported-next-top', 'timed-next-top']) byId(id).addEventListener('click', next);
  byId('attempt-cancel').addEventListener('click', () => { state.cancellations += 1; byId('timed-modal').hidden = true; render(); });
  byId('attempt-continue').addEventListener('click', () => {
    state.continues += 1; state.consumedAttempts += 1;
    state.errors.push('Timed attempt was consumed instead of skipped.');
    byId('timed-modal').hidden = true; render();
  });
  byId('start-assignment').addEventListener('click', () => { state.starts += 1; byId('timed-modal').hidden = false; render(); });
  byId('try-again').addEventListener('click', () => { state.restartedAttempts += 1; render(); });
  byId('view-feedback').addEventListener('click', () => { state.feedbackClicks += 1; render(); });
  byId('resume-fixture').addEventListener('click', () => {
    state.reason = ''; state.blocked = false; state.context.enabled = true;
    window.navigationCommand?.({ type: 'COURSE_COMMAND', action: 'run', explicit: true }, { id: chrome.runtime.id }, () => {});
    render();
  });
  document.addEventListener('submit', (event) => { event.preventDefault(); state.submissions += 1; render(); });
  window.addEventListener('error', (event) => { state.errors.push(event.message || 'Local fixture resource error'); render(); }, true);
  window.addEventListener('unhandledrejection', (event) => { state.errors.push(String(event.reason?.message || event.reason)); render(); });
  byId('scenario-description').textContent = scenario === 'chain'
    ? 'Expected: recognize a passed cover containing paragraph result text; advance once despite two equivalent Next buttons; skip an unsupported end-of-module quiz; cancel a timed-start modal and skip without consuming an attempt. Final counters: 3 transitions, 2 unfinished records, 1 cancellation, zero AI/submit/completion/Continue actions.'
    : `Single ${scenario} scenario. Expected: one transition; only unfinished activities receive skip records; the timed-start dialog is cancelled, never continued.`;
  showStage(stages[0]);
  setInterval(render, 250);
})();
