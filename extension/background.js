import { createSubject, dateKey, normalizeCourseUrl, normalizeProgramUrl, planSubject, recordActivity } from './core/scheduler.js';
import { STATE_KEY, addLog, defaultState, exportState, publicState, validateSettings } from './core/state.js';
import { answerDialogue, answerQuiz, dialogueFingerprint, quizFingerprint, validateDialogue, validateEndpoint, validateQuiz } from './core/ai.js';

let pending = Promise.resolve();
const serial = (work) => {
  const result = pending.then(work);
  pending = result.catch(() => {});
  return result;
};
const fail = (error) => ({ ok: false, error });
const now = () => Date.now();
const inFlightAi = new Set();
const AI_TASKS = {
  AI_QUIZ: { kind: 'quiz', payload: 'quiz', result: 'answers', validate: validateQuiz, fingerprint: quizFingerprint, answer: answerQuiz },
  AI_DIALOGUE: { kind: 'dialogue', payload: 'dialogue', result: 'reply', validate: validateDialogue, fingerprint: dialogueFingerprint, answer: answerDialogue },
};

async function loadState() {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  const defaults = defaultState();
  if (stored?.version !== 1) return defaults;
  return { ...stored, settings: { ...defaults.settings, ...stored.settings,
    ai: { ...defaults.settings.ai, ...stored.settings?.ai } } };
}

async function save(state) { await chrome.storage.local.set({ [STATE_KEY]: state }); }

async function snapshot(state) {
  const selected = activeIds(state);
  const metrics = Object.fromEntries(state.subjects.map((subject) => {
    const plan = planSubject(subject, state.settings, now());
    const waitingSlot = plan.canRun && !selected.has(subject.id);
    return [subject.id, { ...plan, canRun: plan.canRun && !waitingSlot, reason: waitingSlot ? 'Ожидание свободной рабочей вкладки.' : plan.reason,
      deadlineMissed: Boolean(state.settings.applicationEnd && plan.projectedFinishDate > state.settings.applicationEnd) }];
  }));
  const { apiSecret } = await chrome.storage.local.get('apiSecret');
  return publicState(state, metrics, Boolean(apiSecret));
}

function isCoursera(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.coursera.org', 'coursera.org'].includes(url.hostname);
  } catch { return false; }
}

function ownsUrl(subject, url) {
  if (!isCoursera(url)) return false;
  const course = normalizeCourseUrl(url);
  return course ? subject.courses.some((item) => item.url === course) || normalizeCourseUrl(subject.programUrl) === course
    : normalizeProgramUrl(url) === subject.programUrl;
}

async function senderSubject(state, sender, message) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !isCoursera(sender.url) || !isCoursera(message.url)) return null;
  if (sender.documentLifecycle && sender.documentLifecycle !== 'active') return null;
  const subject = state.subjects.find((item) => item.tabId === sender.tab.id && ownsUrl(item, message.url));
  if (!subject) return null;
  try {
    const reported = new URL(message.url);
    if (new URL(sender.url).origin !== reported.origin) return null;
    // Chromium can retain the initial script-context URL after same-document navigation.
    const tab = await chrome.tabs.get(sender.tab.id);
    if (!ownsUrl(subject, tab.url)) return null;
    const current = new URL(tab.url);
    if (current.origin !== reported.origin || current.pathname !== reported.pathname) return null;
    if (tab.pendingUrl) {
      const pendingUrl = new URL(tab.pendingUrl);
      if (pendingUrl.origin !== reported.origin || pendingUrl.pathname !== reported.pathname) return null;
    }
  } catch { return null; }
  return subject;
}

function activeIds(state) {
  const candidates = state.subjects.filter((subject) => planSubject(subject, state.settings, now()).canRun);
  candidates.sort((a, b) => Number(b.tabId !== null) - Number(a.tabId !== null));
  return new Set(candidates.slice(0, state.settings.maxParallel).map((subject) => subject.id));
}

function context(state, subject) {
  if (!subject) return null;
  return { subjectId: subject.id, enabled: activeIds(state).has(subject.id), manualReading: false,
    canRetryAI: state.settings.ai.enabled && ['running', 'blocked'].includes(subject.status),
    allowAI: state.settings.ai.enabled, autoSubmit: state.settings.ai.autoSubmit, autoHonorCode: state.settings.ai.autoHonorCode === true,
    autoDialogue: state.settings.ai.autoDialogue, dialogueMaxTurns: state.settings.ai.dialogueMaxTurns };
}

function dialoguePath(url) {
  return /^\/learn\/[^/]+\/coach\/[^/]+(?:\/|$)/iu.test(new URL(url).pathname);
}

async function retryAi(state, subject, url, dialogue = false) {
  const validRoute = dialogue ? dialoguePath(url) : /^\/learn\/[^/]+\/(?:quiz|exam|assignment-submission)\/[^/]+(?:\/|$)/iu.test(new URL(url).pathname);
  if (!validRoute) return fail(dialogue ? 'Повтор доступен только на странице диалога Coach.' : 'Повтор доступен только на странице теста.');
  if (dialogue && !state.settings.ai.autoDialogue) return fail('Сначала включите автодиалог в настройках ИИ.');
  if (!state.settings.ai.enabled || !['running', 'blocked'].includes(subject.status)) return fail('Сначала включите ИИ и возобновите предмет в панели.');
  const resumed = { ...subject, status: 'running', reason: '' };
  const candidate = { ...state, subjects: state.subjects.map((item) => item.id === subject.id ? resumed : item) };
  if (!activeIds(candidate).has(subject.id)) return fail('Сейчас запуск недоступен: проверьте рабочее окно, бюджет времени и число параллельных предметов.');
  const quiet = await updateManagedTab(state, subject);
  if (!quiet.ok) { await save(state); return quiet; }
  state.subjects = candidate.subjects;
  addLog(state, subject.id, 'Запрошен ручной повтор ИИ.');
  await save(state);
  return { ok: true, context: context(state, resumed) };
}

async function command(subject, action, explicit = false) {
  const unavailable = () => ({ ...fail('Нет связи со страницей Coursera. Обновите рабочую вкладку и нажмите «Продолжить».'), code: 'CONTENT_UNAVAILABLE' });
  if (subject.tabId === null) return unavailable();
  let timeout;
  try {
    const result = await Promise.race([
      chrome.tabs.sendMessage(subject.tabId, { type: 'COURSE_COMMAND', action, ...(explicit ? { explicit: true } : {}) }),
      new Promise((resolve) => { timeout = setTimeout(() => resolve({ ...fail('Страница Coursera не отвечает. Обновите рабочую вкладку и нажмите «Продолжить».'), code: 'CONTENT_TIMEOUT' }), 1500); }),
    ]);
    return result?.ok || result?.code === 'CONTENT_TIMEOUT' ? result : unavailable();
  }
  catch { return unavailable(); }
  finally { clearTimeout(timeout); }
}

function connectionFailed(state, subject, result) {
  if (result.ok) return;
  if (subject.status === 'running') block(state, subject, result.error);
  else if (subject.reason !== result.error) {
    subject.reason = result.error;
    addLog(state, subject.id, result.error);
  }
}

async function updateManagedTab(state, subject, changes = {}) {
  let muted = false;
  try {
    await chrome.tabs.update(subject.tabId, { muted: true });
    muted = true;
    if (Object.keys(changes).length) await chrome.tabs.update(subject.tabId, changes);
    return { ok: true };
  } catch {
    const result = fail(muted
      ? 'Не удалось открыть рабочую страницу. Нажмите «Открыть» у предмета и повторите.'
      : 'Не удалось выключить звук рабочей вкладки. Нажмите «Открыть» у предмета и повторите.');
    connectionFailed(state, subject, result);
    await command(subject, 'pause');
    return result;
  }
}

async function createManagedTab(state, subject, url, active) {
  try {
    // Chrome cannot mute tabs.create; keep the initial document silent until muting succeeds.
    const tab = await chrome.tabs.create({ url: 'about:blank', ...(active === false ? { active: false } : {}) });
    subject.tabId = tab.id;
  } catch {
    const result = fail('Не удалось создать рабочую вкладку. Нажмите «Открыть» у предмета и повторите.');
    connectionFailed(state, subject, result);
    return result;
  }
  return updateManagedTab(state, subject, { url });
}

function addCourses(state, subject, courses) {
  if (!Array.isArray(courses)) return;
  for (const course of courses.slice(0, 100)) {
    const url = normalizeCourseUrl(course?.url);
    if (!url || subject.courses.some((item) => item.url === url)) continue;
    if (state.subjects.some((other) => other.id !== subject.id && other.courses.some((item) => item.url === url))) continue;
    subject.courses.push({ id: crypto.randomUUID(), url, title: String(course.title || url.split('/')[4]).slice(0, 180), estimatedHours: null, status: 'pending', seconds: 0 });
  }
}

function block(state, subject, reason) {
  if (subject.status !== 'running') return;
  subject.status = 'blocked'; subject.reason = String(reason).slice(0, 350);
  addLog(state, subject.id, subject.reason);
}

async function reconcile(state, { explicitSubjectId, loadingTabs = new Set() } = {}) {
  const active = activeIds(state);
  for (const subject of state.subjects) {
    const plan = planSubject(subject, state.settings, now());
    const done = subject.courses.length > 0 && subject.courses.every((course) => course.status === 'completed');
    if (done && plan.budgetReached && plan.calendarSatisfied && subject.status === 'running') {
      subject.status = 'completed'; subject.completedAt = now(); subject.reason = '';
      addLog(state, subject.id, 'Курсы отмечены завершёнными; локальный план часов и дней выполнен.');
    } else if (done && subject.status === 'running' && !plan.budgetReached) {
      block(state, subject, 'Обязательные курсы завершены, но план часов ещё не выполнен. Нужны дополнительные материалы; ожидание часы не добавляет.');
    } else if (done && subject.status === 'running' && !plan.calendarSatisfied) {
      subject.reason = 'Часы и курсы завершены. Ожидание конца календарного периода; даты сертификатов не изменяются.';
    }
    if (subject.status !== 'running' || !active.has(subject.id)) {
      await command(subject, 'pause');
      continue;
    }
    let existingTab;
    if (subject.tabId !== null) {
      try {
        existingTab = await chrome.tabs.get(subject.tabId);
        if (!ownsUrl(subject, existingTab.pendingUrl || existingTab.url)) {
          block(state, subject, 'Рабочая вкладка ушла со страницы этого предмета. Откройте предмет и продолжите.');
          await command(subject, 'pause'); continue;
        }
      } catch { subject.tabId = null; }
    }
    if (subject.tabId === null) {
      const current = subject.courses.find((course) => course.status !== 'completed');
      const url = subject.lastUrl && ownsUrl(subject, subject.lastUrl) ? subject.lastUrl : current?.url || subject.programUrl;
      if (!(await createManagedTab(state, subject, url, false)).ok) continue;
      subject.currentCourseId = current?.id || null;
      addLog(state, subject.id, 'Открыта рабочая вкладка.');
    } else {
      if (!(await updateManagedTab(state, subject)).ok) continue;
      if (existingTab?.status !== 'loading' && !loadingTabs.has(subject.tabId)) {
        connectionFailed(state, subject, await command(subject, 'run', subject.id === explicitSubjectId));
      }
    }
  }
  await save(state);
}

async function ensureAlarm() {
  if (!await chrome.alarms.get('coursepilot-tick')) await chrome.alarms.create('coursepilot-tick', { periodInMinutes: 1 });
}

async function activitySample(state, subject, message, sender) {
  const { leases = {} } = await chrome.storage.session.get('leases');
  const previous = leases[subject.id];
  const stamp = now();
  const sameDocument = previous?.documentId === sender.documentId && previous?.url === message.url && previous?.tabId === sender.tab.id;
  const elapsed = sameDocument ? (stamp - previous.at) / 1000 : 0;
  leases[subject.id] = { at: stamp, tabId: sender.tab.id, documentId: sender.documentId, url: message.url };
  await chrome.storage.session.set({ leases });
  if (!context(state, subject)?.enabled || elapsed <= 0 || elapsed > 30) return subject;
  const seconds = Math.min(elapsed, Number(message.seconds) || 0, 20);
  if (seconds <= 0 || !['video', 'reading', 'activity'].includes(message.source)) return subject;
  const course = subject.courses.find((item) => item.url === normalizeCourseUrl(message.url));
  if (!course || ['program', 'overview', 'login', 'challenge', 'complete'].includes(message.page?.kind)) return subject;
  return recordActivity(subject, { now: stamp, seconds, courseId: course.id, source: message.source }, state.settings);
}

async function courseFinished(state, subject, message) {
  if (message.completedCourse !== true || message.page?.kind !== 'complete') return;
  const course = subject.courses.find((item) => item.url === normalizeCourseUrl(message.url));
  if (!course || course.status === 'completed') return;
  course.status = 'completed'; course.completedAt = now();
  addLog(state, subject.id, `Обнаружено завершение курса: ${course.title}`);
  const next = subject.courses.find((item) => item.status !== 'completed');
  if (next && subject.status === 'running') {
    subject.currentCourseId = next.id; subject.lastUrl = next.url;
    await updateManagedTab(state, subject, { url: next.url });
  }
}

async function contentMessage(message, sender) {
  const state = await loadState();
  let subject = await senderSubject(state, sender, message);
  if (!subject) return { ok: true, context: null };
  if (typeof message.accountKey === 'string' && message.accountKey.length < 300) {
    if (subject.accountKey && subject.accountKey !== message.accountKey) {
      block(state, subject, 'В рабочей вкладке сменился аккаунт Coursera. Прогресс не объединён; создайте отдельный профиль Chrome.');
      await save(state);
      return { ok: true, context: { ...context(state, subject), enabled: false } };
    }
    else subject.accountKey = message.accountKey;
  }
  if (message.type === 'CONTENT_RETRY_QUIZ' || message.type === 'CONTENT_RETRY_DIALOGUE') return retryAi(state, subject, message.url, message.type === 'CONTENT_RETRY_DIALOGUE');
  if (message.type === 'CONTENT_WIDGET_CONTINUE') {
    if (!/^\/learn\/foundations-of-cybersecurity\/ungradedWidget\/l9B7s\/explore-keep-organizations-secure\/?$/u.test(new URL(message.url).pathname)) return fail('Интерактивный материал не поддержан.');
    if (!context(state, subject)?.enabled) return { ok: true, status: 'disabled' };
    let timeout;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(sender.tab.id, { type: 'WIDGET_CONTINUE', enabled: true }),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(fail('iframe не ответил вовремя.')), 1_500); }),
      ]);
    } catch { return fail('Обработчик iframe недоступен. Обновите расширение и страницу Coursera.'); }
    finally { clearTimeout(timeout); }
  }
  if (context(state, subject)?.enabled && !(await updateManagedTab(state, subject)).ok) {
    await save(state);
    return { ok: true, context: context(state, subject) };
  }
  if (message.type === 'CONTENT_SAMPLE') {
    subject = await activitySample(state, subject, message, sender);
    state.subjects[state.subjects.findIndex((item) => item.id === subject.id)] = subject;
    const page = message.page || {};
    subject.lastUrl = message.url;
    if (page.kind === 'program' || page.kind === 'overview') addCourses(state, subject, page.courses);
    const current = subject.courses.find((item) => item.url === normalizeCourseUrl(message.url));
    if (current) subject.currentCourseId = current.id;
    if (page.kind === 'program' && subject.courses.length && context(state, subject)?.enabled) {
      const first = subject.courses.find((item) => item.status !== 'completed');
      if (first) { subject.currentCourseId = first.id; subject.lastUrl = first.url; await updateManagedTab(state, subject, { url: first.url }); }
    }
    if (page.reason && ['program', 'overview', 'login', 'challenge', 'lab', 'unknown', 'quiz', 'dialogue', 'video', 'widget'].includes(page.kind)) block(state, subject, page.reason);
    await courseFinished(state, subject, message);
  }
  await save(state);
  return { ok: true, context: context(state, subject) };
}

async function subjectAction(state, message) {
  const subject = state.subjects.find((item) => item.id === message.id);
  if (!subject) return fail('Предмет не найден.');
  let connectionError;
  const loadingTabs = new Set();
  let explicitSubjectId;
  switch (message.action) {
    case 'start': case 'resume':
      if (!subject.courses.length) addCourses(state, subject, [{ url: subject.programUrl, title: subject.title }]);
      subject.status = 'running'; subject.reason = ''; explicitSubjectId = subject.id;
      addLog(state, subject.id, 'Прохождение запущено.'); break;
    case 'pause':
      subject.status = 'paused'; subject.reason = ''; await command(subject, 'pause'); addLog(state, subject.id, 'Пауза.'); break;
    case 'remove':
      await command(subject, 'pause'); state.subjects = state.subjects.filter((item) => item.id !== subject.id); break;
    case 'open': case 'scan': {
      let ready = false;
      let tab;
      if (subject.tabId !== null) {
        try { tab = await chrome.tabs.get(subject.tabId); }
        catch { subject.tabId = null; }
      }
      if (tab) {
        const fallback = subject.lastUrl && ownsUrl(subject, subject.lastUrl) ? subject.lastUrl : subject.courses.find((course) => course.status !== 'completed')?.url || subject.programUrl;
        const needsNavigation = !ownsUrl(subject, tab.pendingUrl || tab.url);
        const opened = await updateManagedTab(state, subject, { active: true, ...(needsNavigation ? { url: fallback } : {}) });
        if (!opened.ok) { connectionError = opened.error; break; }
        ready = !needsNavigation && tab.status !== 'loading';
        if (!ready) loadingTabs.add(subject.tabId);
      }
      if (subject.tabId === null) {
        const opened = await createManagedTab(state, subject, subject.lastUrl && ownsUrl(subject, subject.lastUrl) ? subject.lastUrl : subject.programUrl);
        if (!opened.ok) { connectionError = opened.error; break; }
        loadingTabs.add(subject.tabId);
      }
      if (ready) {
        const inspected = await command(subject, 'inspect');
        if (inspected.ok) addCourses(state, subject, inspected.page?.courses);
        else {
          connectionFailed(state, subject, inspected);
          connectionError = inspected.error;
        }
      }
      break;
    }
    default: return fail('Неизвестное действие.');
  }
  await reconcile(state, { explicitSubjectId, loadingTabs });
  if (connectionError) return { ...fail(connectionError), state: await snapshot(state) };
  return { ok: true, state: await snapshot(state) };
}

async function updateSettings(state, message) {
  const settings = {
    ...state.settings, ...message.settings,
    ai: { ...state.settings.ai, ...message.settings?.ai },
  };
  const valid = validateSettings(settings);
  if (!valid.ok) return valid;
  if (settings.ai.endpoint) {
    const target = validateEndpoint(settings.ai.endpoint);
    if (!target.ok) return target;
    if (settings.ai.enabled && !await chrome.permissions.contains({ origins: [target.origin] })) return fail('Разрешите доступ расширения к выбранному API.');
    settings.ai.endpoint = target.url;
  }
  if (settings.ai.enabled && (!settings.ai.endpoint || !settings.ai.model.trim())) return fail('Для ИИ нужны URL API и название модели.');
  if (typeof message.apiKey === 'string') {
    if (message.apiKey.length > 8192) return fail('API-ключ слишком длинный.');
    await chrome.storage.local.set({ apiSecret: message.apiKey.trim() });
  }
  state.settings = settings;
  await reconcile(state);
  return { ok: true, state: await snapshot(state) };
}

async function internalMessage(message) {
  const state = await loadState();
  switch (message.type) {
    case 'GET_STATE': return { ok: true, state: await snapshot(state) };
    case 'ADD_SUBJECT': {
      if (state.subjects.length >= 30) return fail('Максимум 30 предметов в одном профиле.');
      const result = createSubject({ title: message.title, programUrl: message.programUrl }, now());
      if (!result.ok) return result;
      if (state.subjects.some((subject) => subject.programUrl === result.value.programUrl)) return fail('Эта программа уже добавлена.');
      addCourses(state, result.value, [{ url: result.value.programUrl, title: result.value.title }]);
      state.subjects.push(result.value); addLog(state, result.value.id, 'Добавлен план: 50 часов на предмет, 25 календарных дней.');
      await save(state); return { ok: true, state: await snapshot(state) };
    }
    case 'ADD_COURSE': {
      const subject = state.subjects.find((item) => item.id === message.id);
      if (!subject) return fail('Предмет не найден.');
      const count = subject.courses.length;
      addCourses(state, subject, [{ title: message.title, url: message.url }]);
      if (count === subject.courses.length) return fail('Нужна ссылка на отдельный курс, ещё не добавленный в другой предмет.');
      await save(state); return { ok: true, state: await snapshot(state) };
    }
    case 'SUBJECT_ACTION': return subjectAction(state, message);
    case 'UPDATE_SETTINGS': return updateSettings(state, message);
    case 'EXPORT_DATA': return { ok: true, data: exportState(state) };
    case 'RESET_AI':
      state.aiCache = []; await save(state); return { ok: true, state: await snapshot(state) };
    default: return fail('Неизвестное сообщение.');
  }
}

function aiAccessError(state, subject, message, task) {
  if (!subject || !context(state, subject)?.enabled || !state.settings.ai.enabled) return 'ИИ выключен или предмет приостановлен.';
  if (task.kind === 'dialogue' && (!state.settings.ai.autoDialogue || !dialoguePath(message.url))) return 'Автодиалог выключен или открыта неподдерживаемая страница.';
  if (typeof message.accountKey === 'string' && (message.accountKey.length >= 300 || (subject.accountKey && subject.accountKey !== message.accountKey))) return 'Аккаунт Coursera изменился. Ответ ИИ не запрошен и не применён.';
  return null;
}

async function reserveAi(message, sender, task, previous = null) {
  const state = await loadState();
  const subject = await senderSubject(state, sender, message);
  const accessError = aiAccessError(state, subject, message, task);
  if (accessError) return fail(accessError);
  if (!task.validate(message[task.payload])) return fail('Неподдерживаемое задание.');
  const { apiSecret = '' } = await chrome.storage.local.get('apiSecret');
  if (previous && (subject.id !== previous.subjectId || (subject.accountKey || null) !== previous.accountKey ||
    state.settings.ai.endpoint !== previous.settings.endpoint || state.settings.ai.model !== previous.settings.model || apiSecret !== previous.apiSecret)) {
    return fail('Прохождение, аккаунт или настройки ИИ изменились. Повтор отменён.');
  }
  const fingerprint = await task.fingerprint(message[task.payload], state.settings.ai.model, state.settings.ai.endpoint);
  const cacheKey = subject.id + ':' + fingerprint;
  const cached = state.aiCache.find((entry) => (entry.kind || 'quiz') === task.kind && entry.key === cacheKey && entry.expiresAt > now());
  if (cached) return { ok: true, cached: true, [task.result]: cached[task.result], autoSubmit: state.settings.ai.autoSubmit, autoDialogue: state.settings.ai.autoDialogue };
  const today = dateKey(now(), state.settings.timeZone);
  if (state.aiUsage.date !== today) state.aiUsage = { date: today, requests: 0, tokens: 0 };
  if (state.aiUsage.requests >= state.settings.ai.dailyRequests) return fail('Дневной лимит запросов ИИ исчерпан.');
  const target = validateEndpoint(state.settings.ai.endpoint);
  if (!target.ok || !await chrome.permissions.contains({ origins: [target.origin] })) return fail('Нет разрешения на API.');
  state.aiUsage.requests += 1;
  await save(state);
  return { ok: true, settings: state.settings.ai, apiSecret, subjectId: subject.id, accountKey: subject.accountKey || null, cacheKey };
}

async function requestAi(message, sender, task) {
  let reserved = await serial(() => reserveAi(message, sender, task));
  if (!reserved.ok || reserved.cached) return reserved;
  const original = reserved;
  let answer = await task.answer(message[task.payload], reserved.settings, reserved.apiSecret);
  for (let retry = 1; retry <= 2 && !answer.ok && answer.retryable === true; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500 * retry));
    reserved = await serial(() => reserveAi(message, sender, task, original));
    if (!reserved.ok || reserved.cached) return reserved;
    answer = await task.answer(message[task.payload], reserved.settings, reserved.apiSecret);
  }
  return serial(async () => {
    const state = await loadState();
    const subject = await senderSubject(state, sender, message);
    if (aiAccessError(state, subject, message, task) || subject.id !== reserved.subjectId || (subject.accountKey || null) !== reserved.accountKey) return fail('Прохождение, аккаунт или ИИ изменились во время запроса. Ответ не применён.');
    if (state.settings.ai.endpoint !== reserved.settings.endpoint || state.settings.ai.model !== reserved.settings.model) return fail('Настройки ИИ изменились во время запроса. Ответ не применён.');
    const { apiSecret = '' } = await chrome.storage.local.get('apiSecret');
    if (apiSecret !== reserved.apiSecret) return fail('Ключ API изменился во время запроса. Предыдущий ответ не применён.');
    if (answer.ok) {
      state.aiUsage.tokens += answer.tokens;
      state.aiCache = [{ key: reserved.cacheKey, kind: task.kind, [task.result]: answer[task.result], expiresAt: now() + 86400000 }, ...state.aiCache.filter((entry) => entry.key !== reserved.cacheKey && entry.expiresAt > now())].slice(0, 60);
      addLog(state, subject.id, task.kind === 'dialogue' ? 'Получен текст ответа ИИ для Coach. Завершение определяет Coursera.' : 'Получен ответ ИИ. Правильность определяется проверкой Coursera.');
    } else {
      if (answer.disabled) state.settings.ai.enabled = false;
      block(state, subject, answer.error);
    }
    await save(state);
    return { ...answer, autoSubmit: state.settings.ai.autoSubmit, autoDialogue: state.settings.ai.autoDialogue };
  });
}

async function runAi(message, sender) {
  const task = AI_TASKS[message.type];
  const requestKey = `${sender.tab?.id}:${message.type}:${String(message.url).split(/[?#]/u)[0]}`;
  if (inFlightAi.has(requestKey)) return fail('Запрос ИИ для этого задания уже выполняется.');
  inFlightAi.add(requestKey);
  try { return await requestAi(message, sender, task); }
  finally { inFlightAi.delete(requestKey); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const internal = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  let task;
  if (Object.hasOwn(AI_TASKS, message.type)) task = runAi(message, sender);
  else if (['CONTENT_HELLO', 'CONTENT_SAMPLE', 'CONTENT_RETRY_QUIZ', 'CONTENT_RETRY_DIALOGUE', 'CONTENT_WIDGET_CONTINUE'].includes(message.type)) task = serial(() => contentMessage(message, sender));
  else if (internal) task = serial(() => internalMessage(message));
  else { sendResponse(fail('Сообщение не разрешено.')); return false; }
  task.then(sendResponse).catch(() => sendResponse(fail('Не удалось выполнить действие. Откройте панель и повторите.')));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'coursepilot-tick') serial(async () => reconcile(await loadState())).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  serial(async () => {
    const state = await loadState();
    for (const subject of state.subjects.filter((item) => item.tabId === tabId)) {
      subject.tabId = null;
      if (subject.status === 'running' && !removeInfo?.isWindowClosing) { subject.status = 'paused'; subject.reason = 'Рабочая вкладка закрыта. Нажмите «Продолжить».'; }
    }
    await save(state);
  }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  serial(async () => {
    const state = await loadState();
    const restored = await chrome.tabs.query({ url: ['https://www.coursera.org/*', 'https://coursera.org/*'] });
    const assigned = new Set();
    for (const subject of state.subjects) {
      const tab = restored.find((item) => !assigned.has(item.id) && ownsUrl(subject, item.url));
      subject.tabId = tab?.id ?? null;
      if (tab) assigned.add(tab.id);
    }
    await chrome.storage.session.set({ leases: {} });
    await ensureAlarm(); await reconcile(state);
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  serial(async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await ensureAlarm(); await save(await loadState());
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }).catch(() => {});
});

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
ensureAlarm().catch(() => {});
