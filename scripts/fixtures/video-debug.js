(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const state = {
    phase: 'Generating delayed player', playEvents: 0, pauseEvents: 0, closeClicks: 0,
    nextClicks: 0, endedEvents: 0, injectedPauses: 0, injectedPopups: 0, skipClicks: 0, questionInjected: false, samples: [],
    errors: [], blocked: false, reason: '', recordedSeconds: 0, scriptReady: false,
    enabled: true, pauseInjected: false, popupInjected: false, scenarioRunning: true,
  };
  let video = null;
  let command = null;
  let objectUrl = null;

  function render() {
    byId('play-count').textContent = state.playEvents;
    byId('pause-count').textContent = state.pauseEvents;
    byId('close-count').textContent = state.closeClicks;
    byId('next-count').textContent = state.nextClicks;
    byId('skip-count').textContent = state.skipClicks;
    byId('phase').textContent = state.phase;
    const diagnostics = {
      ...state, contentLoaded: globalThis.__COURSEPILOT_CONTENT__ === true,
      commandListener: Boolean(command), path: location.pathname,
      video: video ? { muted: video.muted, paused: video.paused, ended: video.ended,
        currentTime: Number(video.currentTime.toFixed(2)), playbackRate: video.playbackRate,
        readyState: video.readyState, error: video.error?.code || null } : null,
    };
    byId('compact-state').textContent = `Subject: ${state.enabled ? 'active' : 'paused'} · Player: ${video ? video.ended ? 'ended' : video.paused ? 'paused' : 'playing' : 'loading'} · Muted: ${video?.muted ? 'yes' : 'no'} · Blocked: ${state.blocked ? 'yes' : 'no'} · Errors: ${state.errors.length}`;
    byId('diagnostics').textContent = JSON.stringify(diagnostics, null, 2);
    byId('pause-video').disabled = !video || video.ended || state.nextClicks > 0;
    byId('restart-check').disabled = !video;
  }

  function context() {
    return { ok: true, context: { subjectId: 'local-video-fixture', enabled: state.enabled,
      allowAI: false, canRetryAI: false, autoSubmit: false, autoDialogue: false } };
  }

  window.chrome = { runtime: {
    id: 'video-fixture-extension',
    onMessage: { addListener(listener) { command = listener; state.scriptReady = true; } },
    sendMessage(message, callback) {
      if (message.type === 'CONTENT_SAMPLE') {
        state.samples.push({ kind: message.page.kind, seconds: message.seconds, reason: message.page.reason || '' });
        state.samples = state.samples.slice(-8);
        if (message.page.reason) {
          state.blocked = true;
          state.reason = message.page.reason;
          state.enabled = false;
          state.phase = 'Blocked — inspect the reported reason';
        }
      }
      if (/^AI_/u.test(message.type)) state.errors.push('Unexpected AI request from video fixture');
      callback(context());
      render();
    },
  } };

  function sendCommand(action, explicit = false) {
    command?.({ type: 'COURSE_COMMAND', action, explicit }, { id: chrome.runtime.id }, () => {});
    render();
  }

  function showCelebration() {
    byId('celebration').hidden = false;
    byId('lesson-main').setAttribute('aria-hidden', 'true');
    render();
  }

  function closeCelebration(count = true) {
    if (count && !byId('celebration').hidden) state.closeClicks += 1;
    byId('celebration').hidden = true;
    byId('lesson-main').removeAttribute('aria-hidden');
    render();
  }

  byId('show-celebration').addEventListener('click', showCelebration);
  byId('close-celebration').addEventListener('click', () => closeCelebration());
  byId('pause-video').addEventListener('click', () => { video?.pause(); render(); });
  byId('video-question-skip').addEventListener('click', () => {
    state.skipClicks += 1;
    byId('video-question').hidden = true;
    render();
  });
  byId('video-question-submit').addEventListener('click', () => state.errors.push('Optional question was submitted instead of skipped'));
  byId('pause-subject').addEventListener('click', () => {
    state.enabled = false;
    sendCommand('pause');
    state.phase = 'Subject paused manually';
    render();
  });
  byId('resume-subject').addEventListener('click', () => {
    state.enabled = true;
    state.blocked = false;
    state.reason = '';
    state.phase = 'Subject resumed';
    sendCommand('run', true);
  });
  byId('sample-now').addEventListener('click', () => {
    document.dispatchEvent(new Event('visibilitychange'));
    render();
  });
  byId('next-item').addEventListener('click', () => {
    state.nextClicks += 1;
    if (!video?.ended) state.errors.push('Navigation happened before actual video end');
    state.scenarioRunning = false;
    history.pushState({}, '', '/learn/video-fixture/supplement/next/demo');
    byId('video-slot').hidden = true;
    byId('next-item').hidden = true;
    byId('next-copy').hidden = false;
    byId('lesson-title').textContent = 'Next local material';
    state.phase = 'Completed: actual video end → next item';
    byId('result').hidden = false;
    byId('result').textContent = `${state.playEvents} play events · ${state.injectedPauses} injected pause · ${state.closeClicks} popup closed · ${state.skipClicks} optional question skipped · ${state.endedEvents} true ended event · ${state.nextClicks} next transition · ${state.errors.length} errors`;
    render();
  });
  byId('restart-check').addEventListener('click', () => {
    state.enabled = false;
    sendCommand('pause');
    closeCelebration(false);
    byId('video-question').hidden = true;
    video.pause();
    video.currentTime = 0;
    history.pushState({}, '', '/learn/video-fixture/lecture/check/demo');
    Object.assign(state, { phase: 'Replaying pause + popup scenario', playEvents: 0, pauseEvents: 0,
      closeClicks: 0, nextClicks: 0, endedEvents: 0, injectedPauses: 0, injectedPopups: 0, skipClicks: 0, questionInjected: false,
      blocked: false, reason: '', enabled: true, pauseInjected: false, popupInjected: false,
      scenarioRunning: true, samples: [], errors: [] });
    byId('video-slot').hidden = false;
    byId('result').hidden = true;
    byId('next-copy').hidden = true;
    byId('next-item').hidden = true;
    byId('lesson-title').textContent = 'Local video: delayed player and automatic resume';
    sendCommand('run', true);
  });

  window.addEventListener('error', (event) => {
    state.errors.push(event.message || 'Local fixture resource error');
    render();
  });
  window.addEventListener('unhandledrejection', (event) => {
    state.errors.push(String(event.reason?.message || event.reason));
    render();
  });
  window.addEventListener('pagehide', () => { if (objectUrl) URL.revokeObjectURL(objectUrl); });

  function installVideo(blob) {
    video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-label', 'Locally generated ten-second video');
    objectUrl = URL.createObjectURL(blob);
    video.src = objectUrl;
    video.addEventListener('play', () => { state.playEvents += 1; state.phase = 'Video is playing'; render(); });
    video.addEventListener('pause', () => { state.pauseEvents += 1; render(); });
    video.addEventListener('error', () => { state.errors.push(`Video error ${video.error?.code}`); render(); });
    video.addEventListener('timeupdate', () => {
      if (state.scenarioRunning && state.enabled && !state.pauseInjected && video.currentTime >= 2) {
        state.pauseInjected = true;
        state.injectedPauses += 1;
        video.pause();
      }
      if (state.scenarioRunning && state.enabled && !state.popupInjected && video.currentTime >= 4) {
        state.popupInjected = true;
        state.injectedPopups += 1;
        showCelebration();
      }
      if (state.scenarioRunning && state.enabled && !state.questionInjected && video.currentTime >= 6) {
        state.questionInjected = true;
        video.pause();
        byId('video-question').hidden = false;
      }
      render();
    });
    video.addEventListener('ended', () => {
      state.endedEvents += 1;
      state.phase = 'Actual ended event received; waiting for navigation';
      byId('next-item').hidden = false;
      render();
    });
    byId('loading').hidden = true;
    byId('video-slot').append(video);
    state.phase = 'Delayed player ready; waiting for CoursePilot';
    render();
  }

  function generateClip() {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      state.errors.push('This browser lacks local canvas recording support');
      state.phase = 'Fixture recording unavailable';
      render();
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 300;
    const context2d = canvas.getContext('2d');
    const stream = canvas.captureStream(15);
    const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    const chunks = [];
    const start = performance.now();
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener('stop', () => {
      clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
      installVideo(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
    });
    recorder.addEventListener('error', () => {
      state.errors.push('Local MediaRecorder failed');
      clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
      render();
    });
    const draw = () => {
      const seconds = Math.min(10, (performance.now() - start) / 1000);
      context2d.fillStyle = '#253528';
      context2d.fillRect(0, 0, 640, 300);
      context2d.fillStyle = '#bce586';
      context2d.font = 'bold 30px system-ui';
      context2d.fillText('CoursePilot · local video', 36, 65);
      context2d.fillStyle = '#f1f7ed';
      context2d.font = '60px system-ui';
      context2d.fillText(`${seconds.toFixed(1)} / 10 s`, 36, 163);
      context2d.fillStyle = '#4d6840';
      context2d.fillRect(36, 216, 568, 15);
      context2d.fillStyle = '#bce586';
      context2d.fillRect(36, 216, 568 * seconds / 10, 15);
      state.recordedSeconds = Number(seconds.toFixed(1));
      if (seconds >= 10 && recorder.state === 'recording') recorder.stop();
    };
    draw();
    recorder.start();
    const timer = setInterval(draw, 1000 / 15);
  }

  setInterval(render, 500);
  render();
  generateClip();
})();
