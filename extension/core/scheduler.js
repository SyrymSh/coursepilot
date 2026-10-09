const DAY_MILLISECONDS = 86_400_000;
const TARGET_SECONDS = 50 * 60 * 60;
const DURATION_DAYS = 25;
const DEFAULT_TIME_ZONE = 'Asia/Qyzylorda';
const ACTIVITY_SOURCES = new Set(['video', 'reading', 'activity']);

function calendarTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function localParts(now, timeZone) {
  if (!Number.isFinite(now)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return {
      date: `${values.year}-${values.month}-${values.day}`,
      seconds: Number(values.hour) * 3600 + Number(values.minute) * 60 + Number(values.second),
    };
  } catch {
    return null;
  }
}

export function dateKey(now = Date.now(), timeZone = DEFAULT_TIME_ZONE) {
  return localParts(now, timeZone)?.date ?? null;
}

export function addDays(isoDate, days) {
  const timestamp = calendarTimestamp(isoDate);
  if (timestamp === null || !Number.isInteger(days)) return null;
  const date = new Date(timestamp + days * DAY_MILLISECONDS);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function courseraUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    return ['coursera.org', 'www.coursera.org'].includes(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

export function normalizeCourseUrl(value) {
  const url = courseraUrl(value);
  const match = url?.pathname.match(/^\/learn\/([a-zA-Z0-9_-]{1,160})(?:\/.*)?$/);
  return match ? `https://www.coursera.org/learn/${match[1]}/home` : null;
}

export function normalizeProgramUrl(value) {
  const url = courseraUrl(value);
  if (!url) return null;
  if (url.pathname.startsWith('/learn/')) return normalizeCourseUrl(value);
  const match = url.pathname.match(/^\/(specializations|professional-certificates)\/([a-zA-Z0-9_-]{1,160})\/?$/);
  return match ? `https://www.coursera.org/${match[1]}/${match[2]}` : null;
}

export function createSubject(input = {}, now = Date.now()) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 160) return { ok: false, error: 'Название: от 1 до 160 символов.' };
  const programUrl = normalizeProgramUrl(input?.programUrl);
  if (!programUrl) return { ok: false, error: 'Нужна HTTPS-ссылка на курс или программу Coursera.' };
  if (!Number.isFinite(now) || !dateKey(now)) return { ok: false, error: 'Некорректная дата создания.' };
  return {
    ok: true,
    value: {
      id: crypto.randomUUID(), title, programUrl, courses: [], targetSeconds: TARGET_SECONDS,
      durationDays: DURATION_DAYS, startDate: null, dailySeconds: {}, elapsedSeconds: 0,
      status: 'idle', reason: '', tabId: null, currentCourseId: null, lastUrl: null,
      createdAt: now, completedAt: null,
    },
  };
}

function clockSeconds(value) {
  if (value === '24:00') return 86400;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 3600 + minute * 60;
}

function scheduleWindow(settings = {}) {
  const start = clockSeconds(settings.windowStart ?? '09:00');
  const end = clockSeconds(settings.windowEnd ?? '21:00');
  if (start === null || end === null || start >= end) return null;
  return { start, end, capacity: end - start };
}

function positiveNumber(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function blockedPlan(reason) {
  return {
    dayIndex: 0, remainingDays: 0, dailyTargetSeconds: 0, todaySeconds: 0,
    remainingSeconds: TARGET_SECONDS, canRun: false, reason,
    earliestFinishDate: null, projectedFinishDate: null,
    budgetReached: false, calendarSatisfied: false,
  };
}

function stoppingReason(subject, budgetReached, todaySeconds, dailyTargetSeconds, insideWindow) {
  if (budgetReached) return 'План 50 часов набран; завершение заданий проверяется отдельно.';
  if (subject.status !== 'running') return subject.reason || 'Предмет на паузе или ещё не запущен.';
  if (!insideWindow) return 'Ожидание рабочего времени.';
  if (todaySeconds >= dailyTargetSeconds) return 'Дневной план выполнен.';
  return '';
}

export function planSubject(subject, settings = {}, now = Date.now()) {
  const local = localParts(now, settings.timeZone ?? DEFAULT_TIME_ZONE);
  if (!local || !subject) return blockedPlan('Некорректная дата или часовой пояс.');
  const window = scheduleWindow(settings);
  if (!window) return blockedPlan('Начало рабочего окна должно быть раньше конца в тот же день.');
  const start = subject.startDate;
  if (start && (calendarTimestamp(start) === null || start > local.date)) {
    return blockedPlan('Дата начала находится в будущем или некорректна.');
  }
  const duration = Number.isInteger(subject.durationDays) && subject.durationDays > 0
    ? subject.durationDays : DURATION_DAYS;
  const dayIndex = start ? (calendarTimestamp(local.date) - calendarTimestamp(start)) / DAY_MILLISECONDS + 1 : 0;
  const remainingDays = Math.max(1, duration - Math.max(1, dayIndex) + 1);
  const target = positiveNumber(subject.targetSeconds, TARGET_SECONDS);
  const elapsed = Math.min(target, positiveNumber(subject.elapsedSeconds));
  const todaySeconds = Math.min(elapsed, positiveNumber(subject.dailySeconds?.[local.date]));
  const remainingSeconds = Math.max(0, target - elapsed);
  const dailyTargetSeconds = Math.min(window.capacity, Math.ceil((remainingSeconds + todaySeconds) / remainingDays));
  const insideWindow = local.seconds >= window.start && local.seconds < window.end;
  const budgetReached = remainingSeconds === 0;
  const possibleStart = start || addDays(local.date, local.seconds >= window.end ? 1 : 0);
  const earliestFinishDate = addDays(possibleStart, duration - 1);
  const capacityToday = Math.max(0, Math.min(dailyTargetSeconds - todaySeconds, window.end - Math.max(local.seconds, window.start)));
  const futureDays = dailyTargetSeconds > 0 ? Math.ceil(Math.max(0, remainingSeconds - capacityToday) / dailyTargetSeconds) : 0;
  const budgetFinishDate = addDays(local.date, futureDays);
  const reason = stoppingReason(subject, budgetReached, todaySeconds, dailyTargetSeconds, insideWindow);
  return {
    dayIndex, remainingDays, dailyTargetSeconds, todaySeconds, remainingSeconds,
    canRun: !reason, reason, earliestFinishDate,
    projectedFinishDate: budgetFinishDate > earliestFinishDate ? budgetFinishDate : earliestFinishDate,
    budgetReached, calendarSatisfied: dayIndex >= duration,
  };
}

function acceptedSeconds(subject, sample, settings, plan) {
  const previous = subject.lastActivityAt ?? subject.createdAt;
  if (!Number.isFinite(previous) || sample.now <= previous) return 0;
  const local = localParts(sample.now, settings.timeZone ?? DEFAULT_TIME_ZONE);
  const window = scheduleWindow(settings);
  return Math.max(0, Math.min(
    sample.seconds, (sample.now - previous) / 1000, local.seconds - window.start,
    plan.remainingSeconds, plan.dailyTargetSeconds - plan.todaySeconds,
  ));
}

export function recordActivity(subject, sample = {}, settings = {}) {
  if (!subject || !Number.isFinite(sample.now) || !ACTIVITY_SOURCES.has(sample.source)) return subject;
  if (!Number.isFinite(sample.seconds) || sample.seconds <= 0 || sample.seconds > 30) return subject;
  if (!Array.isArray(subject.courses) || !subject.courses.some((course) => course.id === sample.courseId)) return subject;
  const plan = planSubject(subject, settings, sample.now);
  if (!plan.canRun) return subject;
  const seconds = acceptedSeconds(subject, sample, settings, plan);
  if (seconds <= 0) return subject;
  const day = dateKey(sample.now, settings.timeZone ?? DEFAULT_TIME_ZONE);
  return {
    ...subject,
    startDate: subject.startDate || day,
    elapsedSeconds: positiveNumber(subject.elapsedSeconds) + seconds,
    dailySeconds: { ...subject.dailySeconds, [day]: plan.todaySeconds + seconds },
    courses: subject.courses.map((course) => course.id === sample.courseId
      ? { ...course, seconds: positiveNumber(course.seconds) + seconds } : course),
    lastActivityAt: sample.now,
    lastActivitySource: sample.source,
  };
}

export function getRunnableSubjects(state, now = Date.now()) {
  if (!Array.isArray(state?.subjects)) return [];
  const settings = state.settings ?? {};
  const maxParallel = Number.isInteger(settings.maxParallel) && settings.maxParallel > 0
    ? settings.maxParallel : 4;
  return state.subjects.filter((subject) => planSubject(subject, settings, now).canRun).slice(0, maxParallel);
}
