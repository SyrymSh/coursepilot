(() => {
  'use strict';

  const SAMPLE_MS = 10_000;
  const MAX_SAMPLE_SECONDS = 20;
  const ACTIVE_WINDOW_MS = 45_000;
  const VIDEO_WAIT_MS = 120_000;
  const VIDEO_PLAY_MS = 15_000;
  const VIDEO_RETRY_MS = 2_000;
  const WIDGET_SOURCE = 'https://d10o6em2qtnr4q.cloudfront.net/assets/d96617fd0cc347daaf2a8420f66905f1/tmp/S30P001-security-analysts-en/index.html';
  const WIDGET_PATH = /^\/learn\/foundations-of-cybersecurity\/ungradedWidget\/l9B7s\/explore-keep-organizations-secure\/?$/u;
  const ATTEMPT_PREFIX = 'coursepilot:quiz:';
  const DIALOGUE_PREFIX = 'coursepilot:dialogue:';
  const DIALOGUE_STABLE_MS = 2_500;
  const DIALOGUE_WAIT_MS = 120_000;
  const MAX_QUESTIONS = 30;
  const MAX_OPTIONS = 20;
  const ATTESTATION = /honou?r\s*code|academic\s*integrity|i\s*(?:agree|certify|confirm|understand|pledge)|^i\s*,[^,]{1,160},\s*understand\s+and\s+agree[.!]?$|my\s*own\s*work|verify\s*(?:my|your)\s*identity|кодекс\s*чести|подтверждаю|соглашаюсь|самостоятельно|личност/iu;
  const HONOR_CODE_STATEMENT = 'By clicking Submit, you confirm this work is your own. Submitting work created with AI tools may result in course failure or account deactivation according to Coursera Honor Code policy.';
  const COMPLETE = /^(?:congratulations[,!]?\s*)?(?:you(?:'ve| have)\s+(?:successfully\s+)?completed\s+(?:this|the)\s+course|(?:this\s+)?course\s+(?:is\s+)?complete(?:d)?|курс\s+(?:успешно\s+)?(?:завершён|завершен|пройден))[.!]?$/iu;
  const NEXT = /^(?:(?:go\s+to\s+(?:the\s+)?)?next(?:\s+(?:item|lesson|video|activity))?|далее|следующ(?:ий|ее|ая)(?:\s+(?:материал|урок|видео|задание))?)(?:\s*[→›»])?$/iu;
  const OPEN_ATTEMPT = /^(?:(?:start|resume|continue)\s+(?:assignment|quiz|attempt)|(?:начать|продолжить|возобновить)\s+(?:задание|тест|попытку))$/iu;
  const SUBMIT = /^(?:submit(?:\s+(?:quiz|answers|assignment))?|отправить(?:\s+(?:ответы|тест|задание))?)$/iu;
  const LESSON_PATH = /^\/learn\/([a-z0-9-]+)\/(lecture|supplement|quiz|exam|assignment-submission|ungradedLab|ungradedWidget|coach|gradedProgramming|programming|peer|reading|assignment|lab)\/[^/]+(?:\/|$)/i;

  function clean(value, limit = 4_000) {
    return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, limit);
  }

  function courseUrl(href, base = 'https://www.coursera.org') {
    try {
      const url = new URL(href, base);
      if (url.protocol !== 'https:' || !/^(?:www\.)?coursera\.org$/iu.test(url.hostname)) return null;
      const match = url.pathname.match(/^\/learn\/([a-z0-9-]+)\/?$/iu);
      return match ? `${url.origin}/learn/${match[1]}` : null;
    } catch {
      return null;
    }
  }

  function courseSlug(href) {
    try {
      return new URL(href, 'https://www.coursera.org').pathname.match(/^\/learn\/([a-z0-9-]+)(?:\/|$)/iu)?.[1] || null;
    } catch {
      return null;
    }
  }

  function courseOverviewPath(pathname) {
    return /^\/learn\/[^/]+(?:\/(?:home|welcome)(?:\/.*)?)?\/?$/iu.test(pathname);
  }

  function completedHeading(value) {
    return COMPLETE.test(clean(value, 500));
  }

  function quizPath(pathname) {
    return /^\/learn\/[^/]+\/(?:quiz|exam|assignment-submission)\/[^/]+(?:\/|$)/iu.test(pathname);
  }

  function manualActivityReason(pathname) {
    const type = pathname.match(/^\/learn\/[^/]+\/(coach|ungradedWidget)\/[^/]+(?:\/|$)/iu)?.[1].toLowerCase();
    if (type === 'coach') return 'Диалог Coursera Coach требует ручного ответа. Продолжите диалог на Coursera, затем возобновите предмет в панели расширения.';
    if (type === 'ungradedwidget') return 'Интерактивное задание требует ручной работы. Выполните его на Coursera, откройте следующий материал и возобновите предмет в панели расширения.';
    return '';
  }

  function dialoguePath(pathname) {
    return /^\/learn\/[^/]+\/coach\/[^/]+(?:\/|$)/iu.test(pathname);
  }

  function dialogueComplete(value) {
    return /^(?:(?:you(?:'ve| have)? )?(?:successfully )?completed (?:this|the) dialogue|(?:this )?dialogue (?:is )?complete(?:d)?|диалог (?:успешно )?заверш[её]н)[.!]?$/iu.test(clean(value, 300));
  }

  function dialogueUnavailable(value) {
    return /^(?:i(?:'m| am) (?:currently )?(?:offline|unavailable)|(?:coursera )?(?:coach|ai) is (?:currently )?(?:offline|unavailable)|you (?:have )?reached (?:the|your) (?:message|daily) limit)/iu.test(clean(value, 6_000));
  }

  function dialogueLimit(value) {
    return Number.isInteger(value) ? Math.max(1, Math.min(30, value)) : 12;
  }

  function resetQuizLaunch(attemptState) {
    attemptState.quizLaunch = null;
    attemptState.quizLoadingSince = null;
  }

  function connectionState(response, managedBefore = false) {
    const replied = response?.ok === true && Object.hasOwn(response, 'context');
    const context = replied && typeof response.context?.subjectId === 'string' ? response.context : null;
    return {
      context,
      managedBefore: managedBefore || Boolean(context),
      connectionNotice: context ? '' : replied
        ? 'Эта вкладка больше не связана с предметом CoursePilot. Откройте предмет через панель расширения и возобновите его.'
        : clean(response?.error, 350) || 'Нет связи с расширением CoursePilot. Перезагрузите расширение и обновите страницу Coursera.',
    };
  }

  function quizOutcome(value) {
    const heading = clean(value, 300);
    if (/^(?:you (?:did not|didn't) pass|failed|тест не пройден|вы не прошли тест)[!.]?$/iu.test(heading)) return 'failed';
    if (/^(?:you (?:have )?passed|passed|(?:practice )?assignment (?:is )?completed|тест пройден|вы прошли тест|(?:практическое )?задание (?:успешно )?завершено)[!.]?$/iu.test(heading)) return 'passed';
    return null;
  }

  function quizGradeOutcome(gradeLabel, bannerText) {
    const grade = clean(gradeLabel, 101).match(/^Your grade:\s*(\d+(?:[.,]\d+)?)\s*%$/iu);
    const summary = clean(bannerText, 1_001);
    const thresholds = [...summary.matchAll(/\bTo pass you need at least\s+(\d+(?:[.,]\d+)?)\s*%\./giu)];
    if (!grade || summary.length > 1_000 || thresholds.length !== 1) return null;
    const score = Number(grade[1].replace(',', '.'));
    const threshold = Number(thresholds[0][1].replace(',', '.'));
    if (![score, threshold].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) return null;
    return score >= threshold ? 'passed' : 'failed';
  }

  function videoSeconds(previous, current) {
    if (!previous || !current || !previous.playing || current.seeking || current.interrupted) return 0;
    const wall = (current.wall - previous.wall) / 1_000;
    const monotonic = (current.monotonic - previous.monotonic) / 1_000;
    const played = current.media - previous.media;
    if (wall <= 0 || wall > MAX_SAMPLE_SECONDS || Math.abs(wall - monotonic) > 2) return 0;
    if (current.identity !== previous.identity || current.rate !== 1 || previous.rate !== 1) return 0;
    if ((!current.playing && !current.ended) || !Number.isFinite(played) || played < 0 || played > wall + 0.75) return 0;
    return Math.max(0, Math.min(wall, played));
  }

  function activeSeconds(previous, current, activeSince, lastActivity) {
    if (!previous || !previous.foreground || !current.foreground) return 0;
    const elapsed = current.wall - previous.wall;
    if (elapsed <= 0 || elapsed > MAX_SAMPLE_SECONDS * 1_000) return 0;
    if (Math.abs(elapsed - (current.monotonic - previous.monotonic)) > 2_000) return 0;
    const start = Math.max(previous.wall, activeSince);
    const end = Math.min(current.wall, lastActivity + ACTIVE_WINDOW_MS);
    return Math.max(0, Math.min(MAX_SAMPLE_SECONDS, (end - start) / 1_000));
  }

  function validateAnswers(quiz, answers) {
    if (!Array.isArray(answers) || answers.length !== quiz.questions.length) return false;
    const questions = new Map(quiz.questions.map((question) => [question.id, question]));
    const seen = new Set();
    for (const answer of answers) {
      if (!answer || typeof answer.questionId !== 'string' || seen.has(answer.questionId)) return false;
      const question = questions.get(answer.questionId);
      if (!question || !Array.isArray(answer.optionIds) || answer.optionIds.length === 0) return false;
      if (!question.multiple && answer.optionIds.length !== 1) return false;
      const options = new Set(question.options.map((option) => option.id));
      if (new Set(answer.optionIds).size !== answer.optionIds.length) return false;
      if (answer.optionIds.some((id) => typeof id !== 'string' || !options.has(id))) return false;
      seen.add(question.id);
    }
    return seen.size === questions.size;
  }

  function fingerprint(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  const helpers = { clean, courseUrl, courseSlug, courseOverviewPath, completedHeading, quizPath, quizOutcome, quizGradeOutcome, dialoguePath, dialogueComplete, dialogueUnavailable, dialogueLimit, manualActivityReason, resetQuizLaunch, connectionState, lessonPath: (value) => LESSON_PATH.test(value), nextLabel: (value) => NEXT.test(clean(value)), attemptLabel: (value) => OPEN_ATTEMPT.test(clean(value)), videoSeconds, activeSeconds, validateAnswers, fingerprint };
  if (typeof document === 'undefined') {
    globalThis.__COURSEPILOT_TEST__ = helpers;
    return;
  }
  if (!globalThis.chrome?.runtime?.id || globalThis.__COURSEPILOT_CONTENT__) return;
  globalThis.__COURSEPILOT_CONTENT__ = true;

  const state = {
    context: null, managedBefore: false, connectionNotice: '', url: location.href, epoch: 0, tickRunning: null, driveRunning: null,
    lastActivity: 0, readingSince: 0, readingActive: false, previousClock: null,
    video: null, previousVideo: null, videoInterrupted: false, videoOwned: false,
    videoNotice: '', videoWaitingSince: null, videoAttempt: null, videoRetryAt: 0,
    videoFailures: 0, videoRecovery: null,
    observedVideos: new WeakSet(), celebrationClicks: new WeakMap(),
    videoQuestionClicks: new WeakMap(),
    widgetOpeningSince: null, widgetRetryAt: 0, widgetFailures: 0,
    reason: '', quizNotice: '', quizFingerprint: null, quizBusy: false, quizLaunch: null, quizLoadingSince: null,
    dialogueBusy: false, dialogueCandidate: null, dialogueLoadingSince: null, dialogueBusySince: null, dialogues: new Map(),
    pendingNavigation: null, visited: new Set(), visitedKey: '', attempts: new Map(), widget: null,
  };

  function send(message) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ ok: false, error: 'Истекло время ответа расширения. Проверьте его панель.' }), ['AI_QUIZ', 'AI_DIALOGUE'].includes(message.type) ? 90_000 : 20_000);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) resolve({ ok: false, error: 'Расширение недоступно. Обновите страницу.' });
          else resolve(response || { ok: false, error: 'Нет ответа расширения.' });
        });
      } catch {
        clearTimeout(timeout);
        resolve({ ok: false, error: 'Расширение обновлено. Обновите страницу.' });
      }
    });
  }

  function isVisible(element) {
    if (!element || !element.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function text(element, limit = 4_000) {
    return clean(element?.innerText || element?.textContent || '', limit);
  }

  function label(element) {
    return clean(element.getAttribute('aria-label') || text(element) || element.getAttribute('title'), 300);
  }

  function mainArea() {
    if (quizPath(location.pathname)) {
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(isVisible);
      const assignment = dialogs.findLast((dialog) => dialog.matches('.cds-FullscreenDialog-dialog') || dialog.querySelector('[role="radiogroup"],[data-testid^="part-Submission_"],fieldset'));
      if (assignment) return assignment;
    }
    return document.querySelector('main,[role="main"]') || document.body;
  }

  function accountKey() {
    const menus = document.querySelectorAll('[data-testid="user-menu"],[data-testid="header-user-menu"],[aria-label="User menu"],[aria-label="Account menu"]');
    for (const menu of menus) {
      const links = menu.matches('a[href]') ? [menu] : menu.querySelectorAll('a[href]');
      for (const anchor of links) {
        try {
          const url = new URL(anchor.href, location.href);
          const match = url.pathname.match(/^\/user\/([a-z0-9_-]+)\/?$/iu);
          if (url.origin === location.origin && match) return `profile:${match[1]}`;
        } catch { /* A malformed link is not account evidence. */ }
      }
    }
    return null;
  }

  function discoverCourses() {
    const courses = new Map();
    const anchors = curriculumRoots().flatMap((root) => [...root.querySelectorAll('a[href]')]);
    for (const anchor of anchors) {
      if (anchor.closest('[data-testid*="recommend"],[class*="recommend"],[aria-label*="recommend" i]')) continue;
      const url = courseUrl(anchor.href, location.href);
      if (!url || courses.has(url)) continue;
      const title = text(anchor, 300) || clean(anchor.getAttribute('aria-label'), 300);
      if (!title) continue;
      const card = anchor.closest('article,li,[data-testid*="course-card"]');
      const hoursMatch = card && text(card, 2_000).match(/\b(\d+(?:[.,]\d+)?)\s*(?:hours?|hrs?|час(?:а|ов)?)\b/iu);
      const estimatedHours = hoursMatch ? Number(hoursMatch[1].replace(',', '.')) : null;
      courses.set(url, { title, url, estimatedHours: estimatedHours > 0 ? estimatedHours : null });
    }
    return [...courses.values()].slice(0, 150);
  }

  function curriculumRoots() {
    const matches = [...document.querySelectorAll('#courses,#courses-content,[data-testid="courses"],[data-testid="courses-section"],[data-testid="program-courses"]')];
    const headingPattern = /^(?:courses?(?:\s*\(\d+\))?|\d+\s*course\s*series|courses? in (?:this|the) (?:specialization|professional certificate|program)|курсы(?:\s*\(\d+\))?|курсы (?:этой специализации|программы))$/iu;
    for (const heading of visibleElements('h2,h3', mainArea())) {
      if (!headingPattern.test(text(heading, 200))) continue;
      let root = heading.parentElement;
      for (let depth = 0; root && depth < 5 && root !== mainArea() && root !== document.body; depth += 1, root = root.parentElement) {
        const links = [...root.querySelectorAll('a[href]')].filter((anchor) => courseUrl(anchor.href, location.href));
        if (links.length) { matches.push(root); break; }
      }
    }
    return [...new Set(matches)].filter((root) => {
      const headings = [...root.querySelectorAll('h2,h3')].map((heading) => text(heading, 200)).join(' ');
      return !/recommended for you|you might also like|related courses|рекомендуем|вам также/iu.test(headings);
    });
  }

  function visibleElements(selector, area = document) {
    return [...area.querySelectorAll(selector)].filter(isVisible);
  }

  function inspectPage() {
    const area = mainArea();
    const heading = visibleElements('h1', area)[0];
    const itemTitle = text(heading, 300) || clean(document.title, 300);
    const page = { kind: 'unknown', courses: [], itemTitle };
    const bodyText = text(area, 24_000);
    const pathname = location.pathname;
    if (visibleElements('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],input[name*="captcha"]').length || /verify you are human|complete the captcha|подтвердите,? что вы не робот/iu.test(bodyText)) {
      return { ...page, kind: 'challenge', reason: 'На странице требуется проверка CAPTCHA. Выполните её самостоятельно.' };
    }
    if (/^\/(?:login|signin)(?:\/|$)/iu.test(pathname) || visibleElements('input[type="password"]').length) {
      return { ...page, kind: 'login', reason: 'Войдите в свой аккаунт Coursera и возобновите предмет.' };
    }
    if (/\/learn\//iu.test(pathname) && visibleElements('[role="dialog"]')
      .some((dialog) => /subscribe|purchase|payment|upgrade|оплат|подписк/iu.test(text(dialog, 3_000)))) {
      return { ...page, reason: 'Материал закрыт оплатой или подпиской. Проверьте доступ на Coursera.' };
    }
    const completionSelector = courseOverviewPath(pathname) ? 'h1,h2,[role="status"],[data-testid*="course-complete"]' : '[data-testid*="course-complete"]';
    if (courseSlug(location.href) && visibleElements(completionSelector, area)
      .some((element) => completedHeading(text(element, 500)))) return { ...page, kind: 'complete' };
    if (/^\/(?:specializations|professional-certificates)\//iu.test(pathname)) {
      return { ...page, kind: 'program', courses: discoverCourses() };
    }
    if (quizPath(pathname)) return { ...page, kind: 'quiz' };
    if (dialoguePath(pathname)) return { ...page, kind: 'dialogue' };
    if (WIDGET_PATH.test(pathname)) return { ...page, kind: 'widget' };
    const manualReason = manualActivityReason(pathname);
    if (manualReason) return { ...page, kind: 'lab', reason: manualReason };
    if (/\/learn\/[^/]+\/(?:ungradedLab|gradedProgramming|programming|peer|lab|assignment)\//iu.test(pathname)) {
      return { ...page, kind: 'lab', reason: 'Проект, лаборатория или взаимная проверка требуют отдельной работы. Откройте задание.' };
    }
    if (visibleElements('video', area).length || /\/learn\/[^/]+\/lecture\//iu.test(pathname)) return { ...page, kind: 'video' };
    if (/\/learn\/[^/]+\/(?:supplement|reading)\//iu.test(pathname)) return { ...page, kind: 'reading' };
    if (courseOverviewPath(pathname)) return { ...page, kind: 'overview' };
    return { ...page, reason: 'Формат страницы пока не распознан. Откройте материал курса или продолжите вручную.' };
  }

  function updateContext(response) {
    const next = connectionState(response, state.managedBefore);
    if (state.context && (!next.context || state.context.subjectId !== next.context.subjectId ||
      (state.context.enabled && !next.context.enabled) || (state.context.allowAI && !next.context.allowAI) ||
      (state.context.autoDialogue && !next.context.autoDialogue))) {
      state.epoch += 1;
      state.quizBusy = false;
      state.dialogueBusy = false;
      state.previousClock = null;
      if (!next.context) {
        state.reason = '';
        state.quizNotice = '';
      }
    }
    Object.assign(state, next);
    const context = state.context;
    const visitedKey = context?.subjectId ? `coursepilot:visited:${context.subjectId}:${accountKey() || ''}` : '';
    if (visitedKey && visitedKey !== state.visitedKey) {
      state.visitedKey = visitedKey;
      try {
        const visited = JSON.parse(sessionStorage.getItem(visitedKey) || '[]');
        state.visited = new Set(Array.isArray(visited) ? visited.filter((item) => typeof item === 'string').slice(-500) : []);
      } catch { state.visited = new Set(); }
    }
    if (!state.context?.enabled) {
      state.readingActive = false;
      stopVideo();
      state.previousVideo = null;
    }
    renderWidget();
  }

  async function hello() {
    const epoch = state.epoch;
    const result = await send({ type: 'CONTENT_HELLO', url: location.href, title: document.title, accountKey: accountKey() });
    if (epoch === state.epoch) updateContext(result);
    return result;
  }

  function clockSnapshot() {
    return { wall: Date.now(), monotonic: performance.now(), foreground: document.visibilityState === 'visible' && document.hasFocus(), lastActivity: state.lastActivity };
  }

  function currentVideo() {
    const videos = visibleElements('video', mainArea());
    return videos.find((video) => !video.paused) || videos[0] || null;
  }

  function stopVideo() {
    state.videoAttempt = null;
    if (state.videoOwned && state.video) state.video.pause();
    state.videoOwned = false;
  }

  function resetVideoWait() {
    state.videoWaitingSince = null;
    state.videoRetryAt = 0;
    state.videoNotice = '';
    state.videoFailures = 0;
    state.videoRecovery = null;
  }

  function attachVideo(video) {
    if (state.video === video) return;
    stopVideo();
    state.video = video;
    if (video) {
      state.videoFailures = 0;
      state.videoRecovery = null;
    }
    state.previousVideo = null;
    state.videoInterrupted = true;
    state.videoOwned = false;
    if (!video || state.observedVideos.has(video)) return;
    state.observedVideos.add(video);
    for (const eventName of ['seeking', 'ratechange', 'waiting', 'emptied']) {
      video.addEventListener(eventName, () => {
        if (state.video === video) state.videoInterrupted = true;
      });
    }
    video.addEventListener('ended', () => {
      if (state.video === video && location.href === state.url) void tick();
    });
  }

  function dismissCelebration() {
    if (!state.context?.enabled) return false;
    for (const dialog of visibleElements('[role="dialog"]')) {
      const complete = visibleElements('h2', dialog).some((heading) => /^Module complete!$/u.test(text(heading, 100)));
      if (!complete) continue;
      const close = visibleElements('button[aria-label="Close celebration dialog"]', dialog)
        .find((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true');
      if (!close) continue;
      const lastClick = state.celebrationClicks.get(dialog);
      if (lastClick === undefined || Date.now() - lastClick >= VIDEO_RETRY_MS) {
        state.celebrationClicks.set(dialog, Date.now());
        close.click();
      }
      return true;
    }
    return false;
  }

  function skipVideoQuestion() {
    if (!state.context?.enabled || !/\/learn\/[^/]+\/lecture\//iu.test(location.pathname)) return false;
    const dialogs = visibleElements('[data-testid="playerContainer"] [role="dialog"][data-testid="scroll-container"]');
    for (const dialog of dialogs) {
      const headings = visibleElements('h2', dialog);
      if (headings.length !== 1 || !/^(?:Question|Reflect)$/u.test(text(headings[0], 100))) continue;
      if (!dialog.querySelector('fieldset.rc-VideoQuizQuestionArea') ||
        !dialog.querySelector('button[data-testid="VideoQuizSubmission-Button"]')) continue;
      const buttons = visibleElements('button', dialog).filter((button) => label(button) === 'Skip');
      if (buttons.length !== 1 || buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true') continue;
      const key = fingerprint(text(dialog, 16_000));
      const previous = state.videoQuestionClicks.get(dialog);
      const attempt = previous?.key === key ? previous : { key, clicks: 0, at: 0 };
      if (attempt.clicks && Date.now() - attempt.at < VIDEO_RETRY_MS * attempt.clicks) return true;
      if (attempt.clicks >= 3) {
        setReason('Вопрос поверх видео не закрылся после двух повторов Skip. Закройте его вручную и возобновите предмет.');
        return true;
      }
      attempt.clicks += 1;
      attempt.at = Date.now();
      state.videoQuestionClicks.set(dialog, attempt);
      state.videoNotice = 'Пропускаю необязательный вопрос в плеере. Видео продолжится автоматически…';
      buttons[0].click();
      return true;
    }
    return false;
  }

  function sampleSeconds(page) {
    const now = clockSnapshot();
    let seconds = 0;
    let source = 'activity';
    if (page.kind === 'video') {
      source = 'video';
      const video = currentVideo();
      attachVideo(video);
      if (video) {
        const snapshot = {
          ...now, identity: video.currentSrc || video.src, media: video.currentTime,
          rate: video.playbackRate, playing: !video.paused && video.readyState >= 2,
          ended: video.ended, seeking: video.seeking, interrupted: state.videoInterrupted,
        };
        seconds = videoSeconds(state.previousVideo, snapshot);
        state.previousVideo = snapshot;
        state.videoInterrupted = false;
      }
    } else {
      state.previousVideo = null;
      if (page.kind === 'reading') {
        source = 'reading';
        if (state.readingActive) seconds = activeSeconds(state.previousClock, now, state.readingSince, state.previousClock?.lastActivity || 0);
      } else if (page.kind === 'quiz' || page.kind === 'dialogue') {
        const lastActivity = state.previousClock?.lastActivity || 0;
        seconds = activeSeconds(state.previousClock, now, lastActivity, lastActivity);
      }
    }
    state.previousClock = now;
    return { seconds: state.context?.enabled ? seconds : 0, source };
  }

  async function tick() {
    const epoch = state.epoch;
    if (state.tickRunning === epoch) return;
    state.tickRunning = epoch;
    try {
      dismissCelebration();
      const page = inspectPage();
      if (state.reason) page.reason = state.reason;
      const sample = sampleSeconds(page);
      const response = await send({
        type: 'CONTENT_SAMPLE', url: location.href, title: document.title, accountKey: accountKey(),
        ...sample, page, ...(page.kind === 'complete' ? { completedCourse: true } : {}),
      });
      if (epoch !== state.epoch) return;
      updateContext(response);
      void drive(page).catch(() => setReason('Не удалось выполнить действие на странице. Проверьте материал вручную.'));
    } finally {
      if (state.tickRunning === epoch) state.tickRunning = null;
      renderWidget();
    }
  }

  function setReason(reason) {
    state.reason = reason;
    renderWidget();
  }

  function normalizedUrl(href) {
    try {
      const url = new URL(href, location.href);
      return `${url.origin}${url.pathname}`;
    } catch { return ''; }
  }

  function navigate(href, explicit = false) {
    if (!state.context?.enabled || state.pendingNavigation) return false;
    let url;
    try { url = new URL(href, location.href); } catch { return false; }
    if (url.origin !== location.origin || url.protocol !== 'https:' || !courseSlug(url.href)) return false;
    const target = normalizedUrl(url.href);
    if (target === normalizedUrl(location.href) || (!explicit && state.visited.has(target))) return false;
    state.visited.add(normalizedUrl(location.href));
    saveVisited();
    state.pendingNavigation = { target, since: Date.now() };
    state.reason = '';
    location.assign(url.href);
    return true;
  }

  function saveVisited() {
    if (!state.visitedKey) return;
    try { sessionStorage.setItem(state.visitedKey, JSON.stringify([...state.visited].slice(-500))); } catch { /* Navigation still uses the current document's visit guard. */ }
  }

  function isLessonLink(anchor) {
    try {
      const url = new URL(anchor.href, location.href);
      return url.origin === location.origin && LESSON_PATH.test(url.pathname) && courseSlug(url.href) === courseSlug(location.href);
    } catch { return false; }
  }

  function completionMark(anchor) {
    const row = anchor.closest('li,[data-testid*="item"],[role="listitem"]') || anchor;
    const value = `${anchor.getAttribute('aria-label') || ''} ${row.getAttribute('data-completed') || ''} ${text(row, 600)}`;
    if (/not started|not completed|in progress|incomplete|не начат|не заверш|в процессе/iu.test(value)) return 0;
    if (row.getAttribute('data-completed') === 'true' || /\bcompleted\b|\bfinished\b|завершено|пройдено/iu.test(value)) return 2;
    return 1;
  }

  function nextFromOverview() {
    const currentCourse = courseUrl(location.href);
    if (currentCourse) {
      if (navigate(`${currentCourse}/home`)) return true;
      setReason('Coursera вернула страницу описания курса. Запишитесь на курс или проверьте доступ к материалам.');
      return false;
    }
    const links = visibleElements('a[href]', mainArea())
      .filter(isLessonLink)
      .filter((anchor) => !state.visited.has(normalizedUrl(anchor.href)) && completionMark(anchor) !== 2)
      .sort((left, right) => completionMark(left) - completionMark(right));
    if (links.length) return navigate(links[0].href);
    setReason('Не найден доступный следующий материал. Откройте модуль или урок вручную.');
    return false;
  }

  function nextMaterial(explicit = false) {
    if (!state.context?.enabled || state.pendingNavigation) return false;
    const controls = visibleElements('a[href],button', mainArea())
      .filter((element) => NEXT.test(label(element)) || (element.matches('a[href]') && /^(?:continue|продолжить)$/iu.test(label(element))));
    for (const control of controls) {
      if (control.disabled || control.getAttribute('aria-disabled') === 'true') continue;
      if (control.matches('a[href]')) {
        if (isLessonLink(control) && navigate(control.href, explicit)) return true;
      } else {
        if (control.type === 'submit' || control.closest('form')) continue;
        state.pendingNavigation = { target: null, since: Date.now() };
        state.visited.add(normalizedUrl(location.href));
        saveVisited();
        control.click();
        return true;
      }
    }
    const overview = visibleElements('a[href]', mainArea()).find((anchor) => {
      try {
        const url = new URL(anchor.href, location.href);
        return url.origin === location.origin && courseSlug(url.href) === courseSlug(location.href) && /^\/learn\/[^/]+\/home(?:\/.*)?$/iu.test(url.pathname);
      } catch { return false; }
    });
    if (overview && navigate(overview.href, true)) return true;
    setReason('Следующий материал не найден. Перейдите к нему вручную на странице курса.');
    return false;
  }

  function waitForVideo(notice) {
    state.videoWaitingSince ??= Date.now();
    state.videoNotice = notice;
    if (Date.now() - state.videoWaitingSince >= VIDEO_WAIT_MS) {
      retryVideo('Видео не удалось загрузить или запустить. Проверьте соединение, обновите страницу и возобновите предмет.', Boolean(state.video));
      return false;
    }
    renderWidget();
    return true;
  }

  function retryVideo(reason, reload = false) {
    stopVideo();
    state.videoFailures += 1;
    if (state.videoFailures > 2) {
      state.videoRecovery = null;
      setReason(`${reason} Выполнены два автоматических повтора.`);
      return;
    }
    state.videoWaitingSince = Date.now();
    state.videoRetryAt = Date.now() + VIDEO_RETRY_MS * state.videoFailures;
    state.videoRecovery = reload ? state.video : null;
    state.videoNotice = `Ошибка видео. Повтор ${state.videoFailures} из 2 через ${2 * state.videoFailures} сек…`;
    renderWidget();
  }

  function startVideo(video) {
    const attempt = { video, epoch: state.epoch, since: Date.now() };
    state.videoAttempt = attempt;
    state.videoOwned = true;
    const current = () => attempt.epoch === state.epoch && state.video === video && video.isConnected &&
      location.href === state.url && state.context?.enabled;
    const failed = (error) => {
      if (!current() || state.videoAttempt !== attempt) return;
      if (error?.name === 'NotAllowedError') {
        retryVideo('Chrome запретил даже беззвучный автозапуск. Нажмите Play в плеере и возобновите предмет.');
      } else if (error?.name === 'NotSupportedError') {
        retryVideo('Формат или источник видео недоступен. Обновите страницу Coursera и возобновите предмет.', true);
      } else retryVideo('Плеер не смог запустить видео. Обновите страницу Coursera и возобновите предмет.');
    };
    try {
      Promise.resolve(video.play()).then(() => {
        if (!current()) { video.pause(); return; }
        if (state.videoAttempt !== attempt) return;
        state.videoAttempt = null;
        if (!video.paused && video.readyState >= 3) resetVideoWait();
      }, failed);
    } catch (error) { failed(error); }
  }

  function runVideo() {
    if (state.reason) return;
    const video = currentVideo();
    attachVideo(video);
    if (!video) {
      waitForVideo('Ожидаю загрузку видеоплеера. Запуск продолжится автоматически…');
      return;
    }
    video.muted = true;
    if (video.playbackRate !== 1) video.playbackRate = 1;
    if (video.ended) {
      resetVideoWait();
      nextMaterial();
      return;
    }
    if (Date.now() < state.videoRetryAt) return;
    if (state.videoRecovery === video) {
      state.videoRecovery = null;
      try { video.load(); }
      catch { retryVideo('Не удалось перезагрузить источник видео. Обновите страницу Coursera и возобновите предмет.', true); }
      return;
    }
    if (video.error && [2, 3, 4].includes(video.error.code)) {
      retryVideo('Ошибка загрузки или декодирования видео. Обновите страницу Coursera и возобновите предмет.', true);
      return;
    }
    if (state.videoAttempt && Date.now() - state.videoAttempt.since >= VIDEO_PLAY_MS) {
      if (!video.paused && video.readyState >= 3) state.videoAttempt = null;
      else {
        retryVideo('Плеер не подтвердил запуск видео. Обновите страницу Coursera и возобновите предмет.');
        return;
      }
    }
    if (!video.paused) {
      state.videoOwned = true;
      if (video.readyState >= 3) resetVideoWait();
      else waitForVideo('Видео буферизуется. Ожидаю продолжения воспроизведения…');
      return;
    }
    if (!waitForVideo('Запускаю видео без звука. Следующий материал откроется после окончания ролика…')) return;
    if (state.videoAttempt || Date.now() < state.videoRetryAt) return;
    if (video.readyState === 0 && !video.currentSrc && !video.getAttribute('src') && !video.querySelector('source[src]')) return;
    startVideo(video);
  }

  async function drive(page) {
    const epoch = state.epoch;
    if (!state.context?.enabled || state.driveRunning === epoch || state.pendingNavigation) return;
    state.driveRunning = epoch;
    try {
      if (dismissCelebration()) return;
      if (page.kind === 'video' && skipVideoQuestion()) return;
      if (['login', 'challenge', 'lab', 'unknown'].includes(page.kind)) {
        setReason(page.reason || 'Для этого материала требуется действие на странице.');
      } else if (page.kind === 'program') {
        if (!page.courses.length) setReason('Не найден надёжно распознаваемый список курсов программы. Добавьте ссылки её курсов в панели расширения.');
      } else if (page.kind === 'overview') nextFromOverview();
      else if (page.kind === 'video') await runVideo();
      else if (page.kind === 'quiz') await runQuiz();
      else if (page.kind === 'dialogue') await runDialogue();
      else if (page.kind === 'widget') await runWidget();
      else if (page.kind === 'reading') state.reason = '';
    } finally { if (state.driveRunning === epoch) state.driveRunning = null; }
  }

  async function runWidget() {
    if (state.reason || Date.now() < state.widgetRetryAt) return;
    state.widgetOpeningSince ??= Date.now();
    const frames = visibleElements('iframe[data-testid="widget-iframe"]', mainArea())
      .filter((frame) => frame.getAttribute('src') === WIDGET_SOURCE);
    if (frames.length !== 1) {
      if (Date.now() - state.widgetOpeningSince > 30_000) setReason('Не найден поддерживаемый iframe инфографики. Откройте материал вручную.');
      return;
    }
    const epoch = state.epoch;
    const response = await send({ type: 'CONTENT_WIDGET_CONTINUE', url: location.href, accountKey: accountKey() });
    if (epoch !== state.epoch || location.href !== state.url || !state.context?.enabled) return;
    if (response?.ok && response.status === 'opened') {
      setReason('Вводная кнопка Continue нажата. Открыта интерактивная инфографика: изучите её метки и завершите материал вручную. Один Continue не означает завершение задания.');
      return;
    }
    if (response?.ok && response.status === 'manual') {
      setReason('В инфографике уже открыты интерактивные элементы. Продолжите работу вручную; повторный Continue не требуется.');
      return;
    }
    if (response?.ok && response.status === 'clicked') {
      state.widgetRetryAt = Date.now() + 1_000;
      return;
    }
    if (response?.status === 'disabled') {
      if (state.context) state.context.enabled = false;
      renderWidget();
      return;
    }
    state.widgetFailures += 1;
    if (state.widgetFailures > 2) {
      setReason('Не удалось открыть инфографику после двух повторов. Проверьте доступ расширения к её iframe или нажмите Continue вручную.');
    } else state.widgetRetryAt = Date.now() + VIDEO_RETRY_MS * state.widgetFailures;
  }

  function inputText(input) {
    const labels = [...(input.labels || [])].map((element) => text(element, 2_000)).filter(Boolean);
    if (labels.length) return clean(labels.join(' '), 2_000);
    if (input.getAttribute('aria-label')) return clean(input.getAttribute('aria-label'), 2_000);
    const ids = (input.getAttribute('aria-labelledby') || '').split(/\s+/u).filter(Boolean);
    return clean(ids.map((id) => text(document.getElementById(id), 2_000)).join(' '), 2_000);
  }

  function inputVisible(input) {
    return isVisible(input) || [...(input.labels || [])].some(isVisible);
  }

  function questionPrompt(root, controls) {
    const specific = root.querySelector('legend,[data-testid*="prompt"],[data-test*="prompt"],h2,h3,h4');
    if (specific && text(specific)) return text(specific, 5_000);
    const labelledBy = (root.getAttribute('aria-labelledby') || '').split(/\s+/u).filter(Boolean);
    if (labelledBy.length) return clean(labelledBy.map((id) => text(document.getElementById(id))).join(' '), 5_000);
    let prompt = text(root, 8_000);
    for (const control of controls) prompt = prompt.replace(inputText(control), '');
    return clean(prompt, 5_000);
  }

  function extractQuiz() {
    const selector = 'fieldset,[role="radiogroup"],[role="group"],[data-testid*="question"],[data-test*="question"],[class*="FormPartsQuestion"]';
    const groups = new Map();
    const inputs = [...mainArea().querySelectorAll('input[type="radio"],input[type="checkbox"]')]
      .filter((input) => !input.disabled && inputVisible(input) && !ATTESTATION.test(inputText(input)));
    for (const input of inputs) {
      const root = input.closest(selector);
      if (!root || !isVisible(root)) continue;
      const key = input.type === 'radio' && input.name ? `${input.type}:${input.name}` : root;
      if (!groups.has(key)) groups.set(key, { root, controls: [] });
      groups.get(key).controls.push(input);
    }
    const questions = [];
    const references = new Map();
    for (const { root, controls } of groups.values()) {
      if (controls.length < 2 || controls.length > MAX_OPTIONS || new Set(controls.map((input) => input.type)).size !== 1) return null;
      const prompt = questionPrompt(root, controls);
      const id = `q-${questions.length + 1}`;
      const options = controls.map((input, index) => ({ id: `o-${index + 1}`, text: inputText(input) }));
      if (!prompt || options.some((option) => !option.text)) return null;
      questions.push({ id, prompt, options, multiple: controls[0].type === 'checkbox' });
      references.set(id, new Map(controls.map((input, index) => [`o-${index + 1}`, input])));
    }
    if (!questions.length || questions.length > MAX_QUESTIONS) return null;
    const quiz = { title: inspectPage().itemTitle, questions };
    if (questions.some((question) => question.prompt.length > 3000 || question.options.some((option) => option.text.length > 1500)) || JSON.stringify(quiz).length > 16_000) return null;
    return { quiz, references };
  }

  function attemptKey(quiz) {
    return `${ATTEMPT_PREFIX}${fingerprint(`${accountKey() || state.context?.subjectId || ''}|${normalizedUrl(location.href)}|${JSON.stringify(quiz)}`)}`;
  }

  function readAttempt(key) {
    if (state.attempts.has(key)) return state.attempts.get(key);
    try { return sessionStorage.getItem(key); } catch { return null; }
  }

  function saveAttempt(key, status) {
    state.attempts.set(key, status);
    try { sessionStorage.setItem(key, status); return true; } catch { return false; }
  }

  function uncheckedAttestations() {
    const native = [...mainArea().querySelectorAll('input[type="checkbox"]')]
      .filter((input) => !input.checked && inputVisible(input) && ATTESTATION.test(inputText(input)));
    const custom = visibleElements('[role="checkbox"]', mainArea())
      .filter((element) => element.getAttribute('aria-checked') !== 'true' && ATTESTATION.test(label(element)));
    return [...native, ...custom];
  }

  function hasUncheckedAttestation() { return uncheckedAttestations().length > 0; }

  function recognizedHonorCode(input) {
    if (!input.matches('input[type="checkbox"]') || input.disabled || input.getAttribute('aria-disabled') === 'true') return false;
    if (!/^I,\s*[^,]{1,160},\s*understand and agree\.$/u.test(inputText(input))) return false;
    const area = mainArea();
    const agreement = input.closest('[data-testid="HonorCodeAgreement"]');
    if (!agreement || !visibleElements('[data-testid="HonorCodeAgreement"]', area).includes(agreement)) return false;
    if (agreement.closest('fieldset,[role="radiogroup"],[data-testid^="part-Submission_"]')) return false;
    if (agreement.querySelectorAll('input[type="checkbox"],[role="checkbox"]').length !== 1) return false;
    const headings = visibleElements('h3', agreement);
    const paragraphs = visibleElements('p', agreement);
    return headings.length === 1 && text(headings[0], 100) === 'Coursera Honor Code' &&
      paragraphs.length === 1 && text(paragraphs[0], 1_000) === HONOR_CODE_STATEMENT;
  }

  function acknowledgeHonorCode(key, attempt, attestations) {
    if (state.context?.autoHonorCode !== true || attestations.length !== 1 || !recognizedHonorCode(attestations[0])) return false;
    if (attempt.honorCodeAttempted === true) return false;
    attempt.honorCodeAttempted = true;
    if (!saveQuizAttempt(key, attempt)) {
      setReason('Не удалось сохранить защиту от повторной автогалочки. Подтвердите Honor Code вручную.');
      return true;
    }
    attestations[0].click();
    waitForQuiz(key, attempt, 'Автоклик Honor Code выполнен. Ожидание подтверждения формы и доступной кнопки отправки…',
      'Coursera не подтвердила автогалочку. Проверьте форму вручную; повторный клик не выполняется.');
    return true;
  }

  function applyAnswers(extracted, answers) {
    for (const answer of answers) {
      const selected = new Set(answer.optionIds);
      for (const [id, input] of extracted.references.get(answer.questionId)) {
        if (!input.isConnected || input.disabled) return false;
        if (input.checked !== selected.has(id) && (input.type === 'checkbox' || selected.has(id))) input.click();
      }
    }
    return true;
  }

  function answersSelected(extracted, answers) {
    return answers.every((answer) => {
      const desired = new Set(answer.optionIds);
      return [...extracted.references.get(answer.questionId)].every(([id, input]) => input.checked === desired.has(id));
    });
  }

  const QUIZ_WAIT_MS = 120_000;

  function quizRouteKey() {
    return `${ATTEMPT_PREFIX}route:${fingerprint(`${accountKey() || state.context?.subjectId || ''}|${normalizedUrl(location.href)}`)}`;
  }

  function rememberQuizAttempt(key) {
    state.quizFingerprint = key;
    saveAttempt(quizRouteKey(), key);
  }

  function storedQuizAttempt(key) {
    const stored = readAttempt(key);
    if (!stored) return null;
    if (!stored.startsWith('{')) return { status: stored };
    try {
      if (stored.length > 40_000) return { status: 'invalid' };
      const attempt = JSON.parse(stored);
      return attempt?.version === 1 && ['selected', 'submitted'].includes(attempt.status) ? attempt : { status: 'invalid' };
    } catch { return { status: 'invalid' }; }
  }

  function saveQuizAttempt(key, attempt) {
    return saveAttempt(key, JSON.stringify({ ...attempt, version: 1 }));
  }

  function currentQuizAttempt() {
    const key = readAttempt(quizRouteKey());
    if (typeof key !== 'string' || !key.startsWith(ATTEMPT_PREFIX) || key.length > 100) return null;
    return { key, attempt: storedQuizAttempt(key) };
  }

  function waitForQuiz(key, attempt, notice, timeoutReason, phase) {
    const field = phase === 'submitted' ? 'submittedAt' : 'waitSince';
    if (!Number.isFinite(attempt[field])) {
      attempt[field] = Date.now();
      saveQuizAttempt(key, attempt);
    }
    state.reason = '';
    state.quizNotice = notice;
    if (Date.now() - attempt[field] >= QUIZ_WAIT_MS) setReason(timeoutReason);
  }

  function waitForQuizResult(key, attempt) {
    if (confirmQuizSubmission(key, attempt)) return;
    waitForQuiz(key, attempt,
      'Ответы отправлены. Ожидается результат Coursera; повторная отправка не выполняется.',
      'Coursera не показала результат за 2 минуты. Проверьте попытку вручную; ответы повторно не отправляются.', 'submitted');
  }

  function quizSubmissionDialog() {
    const matches = visibleElements('[role="dialog"][aria-modal="true"]').filter((dialog) => {
      const headings = visibleElements('h1,h2,h3,[role="heading"]', dialog);
      if (headings.length !== 1 || text(headings[0], 100) !== 'Ready to submit?') return false;
      if (!/^Ready to submit\? (?:Submit Cancel|Cancel Submit)$/u.test(text(dialog, 1_000))) return false;
      return !dialog.querySelector('input,textarea,[contenteditable="true"],[role="checkbox"],fieldset,[role="radiogroup"]');
    });
    if (matches.length !== 1) return null;
    const dialog = matches[0];
    const buttons = visibleElements('button', dialog);
    const submit = buttons.filter((button) => label(button) === 'Submit');
    const cancel = buttons.filter((button) => label(button) === 'Cancel');
    return submit.length === 1 && cancel.length === 1 && buttons.length === 2 ? { dialog, submit: submit[0] } : null;
  }

  function confirmQuizSubmission(key, attempt) {
    const confirmation = quizSubmissionDialog();
    if (!confirmation) return false;
    if (!state.context?.enabled || !state.context.allowAI || !state.context.autoSubmit) {
      state.quizNotice = 'Ожидается ваше подтверждение отправки. Автоотправка выключена.';
      return true;
    }
    if (attempt.submitConfirmationAttempted === true) {
      waitForQuiz(key, attempt, 'Отправка подтверждена. Ожидается результат Coursera…',
        'Coursera не обработала подтверждение за 2 минуты. Проверьте попытку вручную; повторная отправка отключена.', 'submitted');
      return true;
    }
    if (confirmation.submit.disabled || confirmation.submit.getAttribute('aria-disabled') === 'true') {
      waitForQuiz(key, attempt, 'Ожидается доступная кнопка подтверждения отправки…',
        'Кнопка подтверждения не стала доступна за 2 минуты. Проверьте попытку вручную.', 'submitted');
      return true;
    }
    attempt.submitConfirmationAttempted = true;
    attempt.submittedAt = Date.now();
    if (!saveQuizAttempt(key, attempt)) {
      setReason('Не удалось сохранить подтверждение отправки. Нажмите Submit в окне вручную.');
      return true;
    }
    confirmation.submit.click();
    state.reason = '';
    state.quizNotice = 'Отправка подтверждена. Ожидается результат Coursera…';
    return true;
  }

  function continueSelectedQuiz(extracted, key, attempt, allowSubmit = true) {
    if (!state.context?.enabled || !state.context.allowAI) return;
    if (attempt.version !== 1) {
      state.reason = '';
      state.quizNotice = 'Ответы старой версии уже выбраны. Проверьте и отправьте их вручную или явно повторите ИИ.';
      return;
    }
    if (!extracted) {
      waitForQuiz(key, attempt,
        'Ответы сохранены. Ожидается загрузка текущей попытки Coursera…',
        'Текущая попытка не загрузилась за 2 минуты. Проверьте тест вручную; новая попытка не открывается.');
      return;
    }
    if (JSON.stringify(extracted.quiz) !== JSON.stringify(attempt.quiz) ||
      !validateAnswers(extracted.quiz, attempt.answers) || !answersSelected(extracted, attempt.answers)) {
      setReason('Вопросы или выбранные ответы изменились. Проверьте тест и отправьте его вручную; сохранённые ответы не применяются повторно.');
      return;
    }
    state.reason = '';
    if (!allowSubmit || !state.context.autoSubmit) {
      if (attempt.waitSince !== null) {
        attempt.waitSince = null;
        saveQuizAttempt(key, attempt);
      }
      state.quizNotice = 'Ответы ИИ выбраны. Проверьте их и отправьте тест на Coursera; автоотправка выключена.';
      return;
    }
    const attestations = uncheckedAttestations();
    if (attestations.length) {
      if (acknowledgeHonorCode(key, attempt, attestations)) return;
      waitForQuiz(key, attempt,
        attempt.honorCodeAttempted ? 'Автогалочка уже была запрошена. Проверьте подтверждение вручную; повторный клик не выполняется.' :
          'Требуется ваше подтверждение на странице. Автогалочка Honor Code выключена или форма не распознана; другие соглашения отмечаются вручную.',
        'Заявление остаётся неподтверждённым. Проверьте его и возобновите предмет либо отправьте тест вручную.');
      return;
    }
    const submit = visibleElements('button,input[type="submit"]', mainArea())
      .find((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true' && SUBMIT.test(label(button) || button.value));
    if (!submit) {
      waitForQuiz(key, attempt,
        'Ответы выбраны. Ожидается доступная кнопка отправки Coursera…',
        'Кнопка отправки не стала доступна за 2 минуты. Проверьте тест и отправьте его вручную.');
      return;
    }
    attempt.status = 'submitted';
    attempt.submittedAt = Date.now();
    if (!saveQuizAttempt(key, attempt)) {
      setReason('Не удалось сохранить защиту от повторной отправки. Отправьте тест вручную.');
      return;
    }
    submit.click();
    waitForQuizResult(key, attempt);
  }

  async function finishQuizAnswer(original, answers, key, allowSubmit, epoch) {
    if (epoch !== state.epoch || !state.context?.enabled || !state.context.allowAI) return;
    const current = extractQuiz();
    if (!current || JSON.stringify(current.quiz) !== JSON.stringify(original.quiz)) {
      setReason('Содержимое теста изменилось. Проверьте страницу и используйте «Повторить ИИ».');
      return;
    }
    if (!applyAnswers(current, answers)) {
      setReason('Элементы ответа изменились. Проверьте выбранные варианты вручную.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (epoch !== state.epoch || !state.context?.enabled || !state.context.allowAI) return;
    const verified = extractQuiz();
    if (!verified || JSON.stringify(verified.quiz) !== JSON.stringify(original.quiz) || !answersSelected(verified, answers)) {
      setReason('Страница не подтвердила выбор всех ответов. Проверьте тест вручную.');
      return;
    }
    const attempt = { version: 1, status: 'selected', quiz: verified.quiz, answers, selectedAt: Date.now(), waitSince: null };
    rememberQuizAttempt(key);
    saveQuizAttempt(key, attempt);
    continueSelectedQuiz(verified, key, attempt, allowSubmit);
  }

  function quizResults() {
    const area = mainArea();
    const outsideQuestions = (element) => !element.closest('fieldset,[role="radiogroup"],[data-testid^="part-Submission_"]');
    const outcomes = visibleElements('h1,h2,[role="status"]', area)
      .filter(outsideQuestions)
      .map((element) => quizOutcome(text(element, 300)));
    if (!/\/view-feedback\/?$/iu.test(location.pathname)) return outcomes;
    for (const banner of visibleElements('[data-testid="AssignmentViewTopBanner"]', area).filter(outsideQuestions)) {
      if (!isVisible(banner.closest('[role="alert"]'))) continue;
      const headings = visibleElements('h2', banner);
      if (headings.length === 1) outcomes.push(quizGradeOutcome(text(headings[0], 101), text(banner, 1_001)));
    }
    return outcomes;
  }

  async function runQuiz() {
    if (state.quizBusy) return;
    const outcome = quizResults();
    if (outcome.includes('failed')) {
      setReason('Coursera сообщает, что тест не пройден. Проверьте ответы и доступность новой попытки.');
      return;
    }
    if (outcome.includes('passed')) {
      state.reason = '';
      const advancedKey = `${quizRouteKey()}:advanced`;
      if (readAttempt(advancedKey) !== 'advanced' && nextMaterial()) saveAttempt(advancedKey, 'advanced');
      return;
    }
    if (/\/view-feedback\/?$/iu.test(location.pathname)) {
      setReason('Открыта страница результатов, но итог теста не распознан. Проверьте оценку и проходной балл; новая попытка и запрос ИИ не запускаются.');
      return;
    }
    const active = currentQuizAttempt();
    if (active?.attempt?.status === 'submitted') {
      waitForQuizResult(active.key, active.attempt);
      return;
    }
    const extracted = extractQuiz();
    if (active?.attempt?.status === 'selected') {
      continueSelectedQuiz(extracted, active.key, active.attempt);
      return;
    }
    if (!extracted && openQuizAttempt()) return;
    if (!state.context.allowAI) {
      setReason('Для теста ИИ выключен или недоступен. Пройдите тест вручную; остальные предметы могут продолжаться.');
      return;
    }
    if (!extracted) {
      if (state.quizLoadingSince === null) state.quizLoadingSince = Date.now();
      if (Date.now() - state.quizLoadingSince < 20_000) {
        state.quizNotice = 'Ожидание загрузки вопросов…';
        return;
      }
      setReason('Этот формат теста не поддержан. Пройдите его вручную и откройте следующий материал.');
      return;
    }
    state.quizLoadingSince = null;
    const key = attemptKey(extracted.quiz);
    rememberQuizAttempt(key);
    const previous = storedQuizAttempt(key);
    if (previous) {
      if (previous.status === 'pending') {
        saveAttempt(key, 'interrupted');
        state.quizNotice = '';
        setReason('Предыдущий запрос ИИ был прерван. Нажмите «Повторить ИИ», чтобы явно запустить новый запрос.');
        return;
      }
      if (previous.status === 'selected') {
        continueSelectedQuiz(extracted, key, previous);
        return;
      }
      if (previous.status === 'submitted') {
        waitForQuizResult(key, previous);
        return;
      }
      if (!state.quizNotice) state.quizNotice = 'Попытка ИИ уже обработана. Проверьте страницу; повтор доступен только кнопкой ниже.';
      if (!state.reason) state.reason = state.quizNotice;
      return;
    }
    const epoch = state.epoch;
    state.quizBusy = true;
    saveAttempt(key, 'pending');
    state.quizNotice = 'ИИ подготавливает ответы. Материал отправляется настроенному провайдеру.';
    state.reason = '';
    renderWidget();
    try {
      const response = await send({ type: 'AI_QUIZ', url: location.href, quiz: extracted.quiz });
      if (epoch !== state.epoch) return;
      if (!response.ok || !validateAnswers(extracted.quiz, response.answers)) {
        saveAttempt(key, 'failed');
        setReason(response.ok ? 'Ответ ИИ не прошёл проверку формата. Тест не изменён.' : clean(response.error, 350) || 'ИИ недоступен. Пройдите тест вручную.');
        return;
      }
      await finishQuizAnswer(extracted, response.answers, key, response.autoSubmit === true, epoch);
    } finally {
      if (epoch === state.epoch) {
        state.quizBusy = false;
        renderWidget();
      }
    }
  }

  function openQuizAttempt() {
    if (state.quizLaunch) {
      if (Date.now() - state.quizLaunch < 20_000) return true;
      setReason('Попытка не открылась или её формат не распознан. Нажмите Resume assignment вручную и возобновите предмет.');
      return true;
    }
    const control = visibleElements('button,a[href]', mainArea())
      .find((element) => OPEN_ATTEMPT.test(label(element)) && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
    if (!control) return false;
    if (control.matches('a[href]')) {
      if (!isLessonLink(control) || !quizPath(new URL(control.href).pathname)) return false;
      return navigate(control.href, true);
    }
    if (control.type === 'submit' || control.closest('form')) return false;
    state.quizLaunch = Date.now();
    state.quizNotice = 'Открывается попытка задания…';
    control.click();
    setTimeout(() => { if (state.context?.enabled) void tick(); }, 750);
    return true;
  }

  function dialogueStoreKey() {
    return `${DIALOGUE_PREFIX}${fingerprint(`${state.context?.subjectId || ''}|${accountKey() || ''}|${normalizedUrl(location.href)}`)}`;
  }

  function readDialogue() {
    const key = dialogueStoreKey();
    if (state.dialogues.has(key)) return state.dialogues.get(key);
    let raw = null;
    let record = null;
    let corrupt = false;
    try { raw = sessionStorage.getItem(key); record = raw ? JSON.parse(raw) : null; } catch { corrupt = true; }
    if (raw != null && (!record || !Array.isArray(record.history) || !Array.isArray(record.sent) || !Number.isInteger(record.turns) || record.turns < 0 || record.turns > 30 ||
      (record.pending && (!['pending', 'sent', 'failed'].includes(record.pending.status) || typeof record.pending.key !== 'string' || !Number.isFinite(record.pending.at))))) corrupt = true;
    if (corrupt || !record) record = { history: [], sent: [], turns: corrupt ? 30 : 0, pending: null, corrupt };
    record.history = record.history.filter((item) => typeof item?.prompt === 'string' && typeof item.reply === 'string')
      .slice(-6).map((item) => ({ prompt: item.prompt.slice(0, 6_000), reply: item.reply.slice(0, 3_000) }));
    record.sent = record.sent.filter((item) => typeof item === 'string').slice(-30);
    cacheDialogue(key, record);
    return record;
  }

  function cacheDialogue(key, record) {
    state.dialogues.delete(key);
    state.dialogues.set(key, record);
    while (state.dialogues.size > 20) state.dialogues.delete(state.dialogues.keys().next().value);
  }

  function saveDialogue(record) {
    const key = dialogueStoreKey();
    cacheDialogue(key, record);
    try { sessionStorage.setItem(key, JSON.stringify(record)); return true; } catch { return false; }
  }

  function extractDialogue() {
    const area = document.querySelector('[data-testid="dialogue-content"]');
    const coach = area?.querySelector('[data-testid="coursera-coach-item"]');
    if (!area || !coach || !isVisible(area)) return null;
    const messages = visibleElements('[data-testid="chat-message-llm"]', coach);
    const latest = messages.at(-1);
    const markdown = latest?.querySelector('[data-testid="coach-message-markdown"]');
    const composer = coach.querySelector('[role="group"][aria-label="Chat message composer"],.coach-rich-input-field[role="group"]');
    const input = composer?.querySelector('textarea[aria-label="Send a message"]');
    const button = composer?.querySelector('button[aria-label="Send message"]');
    const prompt = text(markdown, 6_001);
    if (!latest || !prompt || prompt.length > 6_000 || !input || !button || !isVisible(input)) return null;
    const title = text(area.querySelector('h1,h2'), 300) || inspectPage().itemTitle;
    const actions = latest.querySelector('[role="toolbar"][aria-label="Message actions"]');
    const busy = input.disabled || input.readOnly || Boolean(latest.closest('[aria-busy="true"]')) ||
      !actions || !isVisible(actions) || visibleElements('[aria-busy="true"],[data-testid*="typing-indicator"]', coach).length > 0;
    return { area, latest, input, button, title, prompt, busy, key: fingerprint(prompt) };
  }

  function hasDialogueCompletion() {
    const area = document.querySelector('[data-testid="dialogue-content"]') || mainArea();
    if (!isVisible(area) || visibleElements('textarea[aria-label="Send a message"]', area).length) return false;
    const outsideHistory = (element) => !element.closest('[data-testid="ai-coach-chat-messages"]');
    if (visibleElements('h1,h2,h3,[role="status"]', area)
      .filter(outsideHistory)
      .some((element) => dialogueComplete(text(element, 300)))) return true;
    const ended = visibleElements('[data-testid="chat-ended-message"]', area)
      .filter(outsideHistory)
      .some((element) => /^The Dialogue has ended\.(?:\s|$)/iu.test(text(element, 300)));
    if (!ended) return false;
    return visibleElements('[data-testid="chat-end-buttons"]', area)
      .filter(outsideHistory)
      .some((buttons) => visibleElements('div,span,[role="status"]', buttons)
        .some((element) => outsideHistory(element) && !element.closest('button,a,[role="button"]') && /^Completed$/iu.test(text(element, 100))));
  }

  function dialoguePayload(current, record) {
    const result = { title: current.title, prompt: current.prompt, history: record.history.slice(-6) };
    while (JSON.stringify(result).length > 16_000 && result.history.length) result.history.shift();
    return result;
  }

  function dialogueStillCurrent(original, epoch) {
    if (epoch !== state.epoch || !state.context?.enabled || !state.context.allowAI || !state.context.autoDialogue || state.url !== location.href) return null;
    const current = extractDialogue();
    return current && current.key === original.key && current.prompt === original.prompt && !current.busy ? current : null;
  }

  function dialogueWithinLimit(record) {
    if (record.turns < dialogueLimit(state.context?.dialogueMaxTurns)) return true;
    failDialogue(record, 'Достигнут текущий лимит автоответов. Ответ не отправлен; проверьте настройки диалога.');
    return false;
  }

  function failDialogue(record, reason) {
    if (record.pending?.status !== 'sent') record.pending = { ...record.pending, status: 'failed' };
    saveDialogue(record);
    setReason(reason);
  }

  async function sendDialogueReply(original, record, reply, epoch) {
    let current = dialogueStillCurrent(original, epoch);
    if (!current || !dialogueWithinLimit(record)) return;
    if (current.input.value.trim()) {
      failDialogue(record, 'В поле Coach появился ваш черновик. Он сохранён; автоответ приостановлен.');
      return;
    }
    if (hasUncheckedAttestation()) {
      failDialogue(record, 'Диалог требует вашего подтверждения на странице. Автоответ остановлен.');
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) { failDialogue(record, 'Поле Coach не поддерживается. Ответ не отправлен.'); return; }
    setter.call(current.input, reply);
    current.input.dispatchEvent(new Event('input', { bubbles: true }));
    current.input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let checks = 0; checks < 10; checks += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      current = dialogueStillCurrent(original, epoch);
      if (!current || !dialogueWithinLimit(record)) return;
      if (current.input.value !== reply) { failDialogue(record, 'Текст Coach изменился до отправки. Проверьте черновик вручную.'); return; }
      if (!current.button.disabled && current.button.getAttribute('aria-disabled') !== 'true') break;
    }
    if (current.button.disabled || current.button.getAttribute('aria-disabled') === 'true') {
      failDialogue(record, 'Coach не разрешил отправку. Подготовленный ответ оставлен в поле.');
      return;
    }
    if (hasUncheckedAttestation()) { failDialogue(record, 'На странице требуется ваше подтверждение. Ответ оставлен в поле.'); return; }
    record.pending = { key: current.key, status: 'sent', at: Date.now() };
    record.sent = [...record.sent, current.key].slice(-30);
    record.history = [...record.history, { prompt: current.prompt, reply }].slice(-6);
    record.turns += 1;
    if (!saveDialogue(record)) {
      setReason('Не удалось сохранить защиту от повторной отправки. Ответ оставлен в поле Coach, отправьте его вручную.');
      return;
    }
    current.button.click();
    state.quizNotice = `Coach: ответ ${record.turns} отправлен. Ожидание следующего вопроса…`;
  }

  async function requestDialogueReply(current, record) {
    const epoch = state.epoch;
    state.dialogueBusy = true;
    record.pending = { key: current.key, status: 'pending', at: Date.now() };
    if (!saveDialogue(record)) {
      state.dialogueBusy = false;
      setReason('Хранилище автоответов недоступно. Диалог остановлен до запроса ИИ, чтобы не создавать повторы.');
      return;
    }
    state.quizNotice = 'ИИ подготавливает ответ Coach. Текст диалога отправляется настроенному провайдеру.';
    renderWidget();
    try {
      const response = await send({ type: 'AI_DIALOGUE', url: location.href, accountKey: accountKey(), dialogue: dialoguePayload(current, record) });
      if (epoch !== state.epoch) return;
      if (!response.ok || response.autoDialogue !== true || typeof response.reply !== 'string' || !response.reply.trim() || response.reply.length > 3_000) {
        failDialogue(record, response.ok ? 'ИИ вернул неподдерживаемый ответ. Диалог не изменён.' : clean(response.error, 350) || 'ИИ недоступен. Продолжите диалог вручную.');
        return;
      }
      await hello();
      if (epoch !== state.epoch) return;
      await sendDialogueReply(current, record, response.reply.trim(), epoch);
    } finally {
      if (epoch === state.epoch) { state.dialogueBusy = false; renderWidget(); }
    }
  }

  function dialogueReady(current, record) {
    if (record.corrupt) { setReason('История автоответов повреждена или недоступна. Продолжите этот диалог вручную, чтобы не отправлять дубликаты.'); return false; }
    if (current.busy) {
      state.dialogueCandidate = null;
      state.dialogueBusySince ??= Date.now();
      if (Date.now() - state.dialogueBusySince > DIALOGUE_WAIT_MS) setReason('Coach не завершил сообщение за 2 минуты. Проверьте доступность диалога и возобновите предмет.');
      else state.quizNotice = 'Ожидание готовности Coach…';
      return false;
    }
    state.dialogueBusySince = null;
    if (dialogueUnavailable(current.prompt)) { setReason('Coach сейчас недоступен. Возобновите предмет после восстановления доступа.'); return false; }
    if (record.pending?.status === 'sent' && record.pending.key === current.key) {
      if (Date.now() - record.pending.at > DIALOGUE_WAIT_MS) setReason('Coach не подтвердил новый вопрос за 2 минуты. Повторная отправка отключена; проверьте диалог.');
      else state.quizNotice = 'Ответ уже отправлен. Ожидание следующего вопроса Coach…';
      return false;
    }
    if (current.input.value.trim()) { setReason('В Coach есть ваш черновик. Автоответ остановлен, текст не изменён.'); return false; }
    if (record.sent.includes(current.key)) { setReason('Coach повторил уже обработанный вопрос. Диалог остановлен, чтобы не отправлять дубликат.'); return false; }
    if (record.turns >= dialogueLimit(state.context.dialogueMaxTurns)) { setReason('Достигнут лимит автоответов в этом диалоге. Продолжите вручную или увеличьте лимит и возобновите предмет.'); return false; }
    if (record.pending && record.pending.status !== 'sent') {
      setReason('Предыдущий автоответ был прерван или не отправлен. Проверьте поле и нажмите «Повторить ИИ».');
      return false;
    }
    if (state.dialogueCandidate?.key !== current.key) {
      state.dialogueCandidate = { key: current.key, since: Date.now() };
      state.quizNotice = 'Ожидание окончания сообщения Coach…';
      return false;
    }
    return Date.now() - state.dialogueCandidate.since >= DIALOGUE_STABLE_MS;
  }

  async function runDialogue() {
    if (state.dialogueBusy || !state.context?.enabled) return;
    if (hasDialogueCompletion()) { state.reason = ''; nextMaterial(); return; }
    if (!state.context.allowAI || !state.context.autoDialogue) {
      setReason('Автоответы Coach выключены. Включите ИИ и «Автоответы в диалогах Coach» в настройках, затем возобновите предмет.');
      return;
    }
    const current = extractDialogue();
    if (!current) {
      state.dialogueLoadingSince ??= Date.now();
      if (Date.now() - state.dialogueLoadingSince > 20_000) setReason('Форма диалога Coach не распознана. Продолжите вручную; другие предметы могут работать.');
      else state.quizNotice = 'Ожидание загрузки диалога Coach…';
      return;
    }
    state.dialogueLoadingSince = null;
    const record = readDialogue();
    if (dialogueReady(current, record)) await requestDialogueReply(current, record);
  }

  function widgetButton(caption, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = caption;
    button.addEventListener('click', (event) => { if (event.isTrusted) void onClick(); });
    return button;
  }

  function createWidget() {
    const host = document.createElement('div');
    host.id = 'coursepilot-helper';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483646;font:13px/1.45 system-ui,sans-serif;color:#edf2ff}:host([hidden]){display:none!important}section{box-sizing:border-box;width:320px;max-width:calc(100vw - 36px);padding:15px;border:1px solid #536382;border-radius:14px;background:#172338;box-shadow:0 12px 40px #0005}strong{font-size:14px}p{margin:9px 0;overflow-wrap:anywhere}small{color:#b8c8e5}div{display:flex;flex-wrap:wrap;gap:7px}button{cursor:pointer;background:#2e486f;color:#fff;border:1px solid #6584ac;border-radius:7px;padding:7px 10px;font:inherit}button:hover{background:#3f5f8b}button:focus-visible{outline:2px solid #c8ddff;outline-offset:2px}button:disabled{opacity:.5;cursor:default}[hidden]{display:none!important}';
    const section = document.createElement('section');
    section.setAttribute('aria-label', 'CoursePilot');
    const title = document.createElement('strong');
    title.textContent = 'CoursePilot';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const hint = document.createElement('p');
    const controls = document.createElement('div');
    const reading = widgetButton('Начать чтение', () => {
      if (!state.context?.enabled) return;
      state.readingActive = !state.readingActive;
      state.readingSince = Date.now();
      state.lastActivity = Date.now();
      state.previousClock = clockSnapshot();
      renderWidget();
    });
    const next = widgetButton('Следующий материал', async () => { await tick(); nextMaterial(true); });
    const retry = widgetButton('Повторить ИИ', async () => {
      const dialogue = dialoguePath(location.pathname);
      if (state.quizBusy || state.dialogueBusy || !state.context?.allowAI || (!state.context.enabled && !state.context.canRetryAI) || (dialogue && !state.context.autoDialogue)) return;
      const response = await send({ type: dialogue ? 'CONTENT_RETRY_DIALOGUE' : 'CONTENT_RETRY_QUIZ', url: location.href, accountKey: accountKey() });
      updateContext(response);
      if (!response.ok || !state.context?.enabled) {
        setReason(response.error || 'Не удалось возобновить предмет. Проверьте расписание и панель расширения.');
        return;
      }
      if (!dialogue && state.quizFingerprint) {
        state.attempts.delete(state.quizFingerprint);
        try { sessionStorage.removeItem(state.quizFingerprint); } catch { /* The next attempt remains explicit. */ }
      }
      state.reason = '';
      state.quizNotice = '';
      resetQuizLaunch(state);
      if (dialogue) {
        const record = readDialogue();
        if (record.pending?.status !== 'sent') record.pending = null;
        saveDialogue(record);
        state.dialogueCandidate = null;
        state.dialogueLoadingSince = null;
        state.dialogueBusySince = null;
        await runDialogue();
      } else await runQuiz();
    });
    const hide = widgetButton('Свернуть', () => {
      hint.hidden = !hint.hidden;
      controls.hidden = hint.hidden;
      hide.textContent = hint.hidden ? 'Развернуть' : 'Свернуть';
    });
    controls.append(reading, next, retry);
    section.append(title, status, hint, controls, hide);
    shadow.append(style, section);
    document.documentElement.append(host);
    state.widget = { host, status, hint, reading, next, retry };
  }

  function renderWidget() {
    if (!state.context && !state.managedBefore) {
      if (state.widget) state.widget.host.hidden = true;
      return;
    }
    if (!state.widget?.host.isConnected) createWidget();
    const widget = state.widget;
    const page = inspectPage();
    widget.host.hidden = false;
    if (!state.context) {
      widget.status.textContent = 'CoursePilot не управляет вкладкой';
      widget.hint.textContent = state.connectionNotice || 'Проверяется связь с предметом CoursePilot…';
      for (const control of [widget.reading, widget.next, widget.retry]) {
        control.disabled = true;
        control.hidden = true;
      }
      return;
    }
    widget.status.textContent = state.context.enabled ? 'Предмет выполняется' : 'Предмет приостановлен';
    widget.hint.textContent = state.reason || page.reason || (page.kind === 'video' ? state.videoNotice : state.quizNotice) ||
      (page.kind === 'reading' ? 'Нажмите «Начать чтение». Время учитывается при чтении в активной вкладке с прокруткой или действиями; через 45 секунд без действий учёт останавливается.' :
        page.kind === 'video' ? 'Видео воспроизводится без звука на скорости 1×. Пауза возобновляется автоматически; переход — после конца ролика. Перемотка и время сна не учитываются.' : 'Управление предметом и расписанием находится в панели расширения.');
    widget.reading.hidden = page.kind !== 'reading';
    widget.reading.disabled = !state.context.enabled;
    widget.reading.textContent = state.readingActive ? 'Приостановить чтение' : 'Начать чтение';
    widget.next.hidden = !['reading', 'video'].includes(page.kind);
    widget.next.disabled = !state.context.enabled;
    widget.retry.hidden = !['quiz', 'dialogue'].includes(page.kind);
    widget.retry.disabled = state.quizBusy || state.dialogueBusy || (!state.context.enabled && !state.context.canRetryAI) || !state.context.allowAI || (page.kind === 'dialogue' && !state.context.autoDialogue);
  }

  async function changedPage() {
    state.epoch += 1;
    stopVideo();
    resetVideoWait();
    state.videoQuestionClicks = new WeakMap();
    state.widgetOpeningSince = null;
    state.widgetRetryAt = 0;
    state.widgetFailures = 0;
    state.video = null;
    state.url = location.href;
    state.context = null;
    state.pendingNavigation = null;
    state.reason = '';
    state.quizNotice = '';
    state.quizFingerprint = null;
    state.quizBusy = false;
    state.dialogueBusy = false;
    state.dialogueCandidate = null;
    state.dialogueLoadingSince = null;
    state.dialogueBusySince = null;
    resetQuizLaunch(state);
    state.previousClock = null;
    state.previousVideo = null;
    state.readingActive = false;
    state.readingSince = 0;
    state.lastActivity = 0;
    state.videoOwned = false;
    renderWidget();
    await hello();
    await tick();
  }

  for (const eventName of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(eventName, (event) => {
      if (event.isTrusted && document.visibilityState === 'visible' && document.hasFocus()) state.lastActivity = Date.now();
    }, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => { void tick(); });
  window.addEventListener('pageshow', () => { void hello().then(tick); });
  window.addEventListener('pagehide', () => { void tick(); });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'COURSE_COMMAND' || sender.id !== chrome.runtime.id) return false;
    if (message.action === 'pause') {
      state.epoch += 1;
      if (state.context) state.context.enabled = false;
      state.quizBusy = false;
      state.dialogueBusy = false;
      state.readingActive = false;
      stopVideo();
      state.previousVideo = null;
      renderWidget();
    }
    respond({ ok: true, page: inspectPage() });
    if (message.action === 'run') {
      state.reason = '';
      if (message.explicit === true) {
        resetQuizLaunch(state);
        resetVideoWait();
        state.widgetOpeningSince = null;
        state.widgetRetryAt = 0;
        state.widgetFailures = 0;
      }
      queueMicrotask(() => { void hello().then(tick); });
    } else if (message.action === 'next') queueMicrotask(() => nextMaterial(true));
    return false;
  });
  setInterval(() => {
    if (location.href !== state.url) void changedPage();
    else if (state.pendingNavigation && Date.now() - state.pendingNavigation.since > 20_000) {
      state.pendingNavigation = null;
      setReason('Переход не завершился. Проверьте страницу и возобновите предмет.');
    }
    else if (state.context?.enabled && !state.reason &&
      (dialoguePath(location.pathname) || /\/learn\/[^/]+\/lecture\//iu.test(location.pathname) ||
        WIDGET_PATH.test(location.pathname) ||
        (quizPath(location.pathname) && currentQuizAttempt()?.attempt?.status === 'submitted'))) {
      void drive(inspectPage()).catch(() => setReason('Не удалось продолжить материал. Проверьте страницу Coursera.'));
    }
  }, 1_000);
  setInterval(() => { void tick(); }, SAMPLE_MS);
  void hello().then(tick);
})();
