const $ = (id) => document.getElementById(id);
const PRESETS = [
  { title: "Information Security Fundamentals", short: "Кибербезопасность", provider: "GOOGLE", symbol: "◈", description: "Google Cybersecurity", url: "https://www.coursera.org/professional-certificates/google-cybersecurity" },
  { title: "Software Quality Assurance and Testing", short: "Тестирование ПО", provider: "PACKT", symbol: "⌘", description: "Selenium WebDriver & Java", url: "https://www.coursera.org/specializations/packt-selenium-webdriver-with-java-basics-to-advanced-and-frameworks" },
  { title: "Software Architecture", short: "Архитектура ПО", provider: "UNIVERSITY OF ALBERTA", symbol: "▱", description: "Software Design and Architecture", url: "https://www.coursera.org/specializations/software-design-architecture" },
  { title: "IT Entrepreneurship & Startup", short: "IT-предпринимательство", provider: "STARTUP", symbol: "↗", description: "IT Entrepreneurship & Startup", url: "https://www.coursera.org/specializations/it-entrepreneurship-startup" },
];
const STATUS = { idle: "Не начат", running: "В работе", paused: "На паузе", blocked: "Нужно действие", completed: "Завершён" };
const COURSE_STATUS = { pending: "В очереди", idle: "В очереди", running: "В работе", active: "В работе", paused: "На паузе", blocked: "Нужно действие", completed: "Завершён" };
const defaultSettings = { timeZone: "Asia/Qyzylorda", windowStart: "09:00", windowEnd: "21:00", maxParallel: 4, skipManual: true, applicationStart: "2026-11-02", applicationEnd: "2026-11-09", ai: { enabled: false, endpoint: "", model: "", dailyRequests: 40, maxOutputTokens: 800, autoSubmit: false, autoHonorCode: false, autoDialogue: false, dialogueMaxTurns: 12 } };
let state = { settings: defaultSettings, subjects: [], logs: [], metrics: {}, aiUsage: {}, hasApiKey: false };
let toastTimer;
let refreshTimer;
let refreshing = false;
let queuedRefresh = false;
const busySubjects = new Set();
const expandedSubjects = new Set();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function hours(seconds) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(Math.max(0, finite(seconds)) / 3600);
}

function duration(seconds) {
  const minutes = Math.floor(Math.max(0, finite(seconds)) / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes} мин`;
}

function calendarDate(value) {
  if (!value) return "—";
  const date = new Date(String(value).length === 10 ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

function applicationDate(value) {
  return value ? `${calendarDate(value)} ${String(value).slice(0, 4)}` : "—";
}

function actionButton(text, action, id, className = "button button-outline button-small") {
  const button = element("button", className, text);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.subject = id;
  button.disabled = busySubjects.has(id);
  return button;
}

function toast(message, isError = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.toggle("error", isError);
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, isError ? 8000 : 3500);
}

function formError(id, message = "") {
  $(id).textContent = message;
  $(id).hidden = !message;
}

async function send(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) return { ok: false, error: "Открой эту панель из установленного расширения CoursePilot." };
  try {
    const result = await chrome.runtime.sendMessage(message);
    return result || { ok: false, error: "Фоновый процесс не ответил. Перезагрузи расширение на странице chrome://extensions." };
  } catch (error) {
    return { ok: false, error: error?.message || "Не удалось связаться с расширением." };
  }
}

function acceptState(next) {
  if (!next) return;
  state = { ...state, ...next, settings: { ...defaultSettings, ...next.settings, ai: { ...defaultSettings.ai, ...next.settings?.ai } }, subjects: Array.isArray(next.subjects) ? next.subjects : [], logs: Array.isArray(next.logs) ? next.logs : [], metrics: next.metrics || {} };
  render();
}

async function refresh() {
  if (refreshing) { queuedRefresh = true; return; }
  refreshing = true;
  const result = await send({ type: "GET_STATE" });
  if (result.ok) {
    acceptState(result.state);
    $("connection-error").hidden = true;
  } else {
    $("connection-error").textContent = result.error;
    $("connection-error").hidden = false;
  }
  refreshing = false;
  if (queuedRefresh) { queuedRefresh = false; void refresh(); }
}

function renderOverview() {
  const subjects = state.subjects;
  const total = subjects.reduce((sum, subject) => sum + finite(subject.elapsedSeconds), 0);
  const budget = subjects.reduce((sum, subject) => sum + finite(subject.targetSeconds, 180000), 0);
  const today = subjects.reduce((sum, subject) => sum + finite(state.metrics[subject.id]?.todaySeconds), 0);
  const active = Math.min(state.settings.maxParallel, subjects.filter((subject) => subject.status === "running" && state.metrics[subject.id]?.canRun).length);
  $("total-hours").textContent = hours(total);
  $("total-budget").textContent = `из ${hours(budget)} ч`;
  $("total-progress").style.width = `${budget ? Math.min(100, total / budget * 100) : 0}%`;
  $("total-caption").textContent = subjects.length ? `Общий бюджет всех курсов внутри ${subjects.length === 1 ? "предмета" : "предметов"}. Время параллельных сессий суммируется.` : "Добавь первый предмет, чтобы собрать свой маршрут.";
  $("active-count").replaceChildren(document.createTextNode(`${active} `), element("small", "", `/ ${state.settings.maxParallel}`));
  $("today-hours").replaceChildren(document.createTextNode(`${hours(today)} `), element("small", "", "ч"));
  $("schedule-label").textContent = `${state.settings.windowStart}–${state.settings.windowEnd}`;
  $("schedule-label").title = state.settings.timeZone;
  $("subject-count").textContent = subjects.length;
  $("empty-state").hidden = subjects.length > 0;
  const { applicationStart, applicationEnd } = state.settings;
  const period = applicationStart && applicationEnd ? `${applicationDate(applicationStart)} — ${applicationDate(applicationEnd)}` : applicationEnd ? `до ${applicationDate(applicationEnd)} включительно` : `с ${applicationDate(applicationStart)}`;
  $("application-window").textContent = `Подача на перезачёт: ${period}. Сроки предварительные.`;
  $("application-window").hidden = !applicationStart && !applicationEnd;
}

function renderSubject(subject, index) {
  const metrics = state.metrics[subject.id] || {};
  const courses = Array.isArray(subject.courses) ? subject.courses : [];
  const target = finite(subject.targetSeconds, 180000);
  const elapsed = finite(subject.elapsedSeconds);
  const status = Object.hasOwn(STATUS, subject.status) ? subject.status : "idle";
  const card = element("article", "subject-card");
  const inner = element("div", "subject-inner");
  const topline = element("div", "subject-topline");
  topline.append(element("span", "subject-index", `ПРЕДМЕТ ${String(index + 1).padStart(2, "0")}`), element("span", `status-badge status-${status}`, STATUS[status]));
  inner.append(topline, element("h3", "subject-title", subject.title));
  const plan = element("div", "subject-plan");
  plan.append(element("strong", "", hours(elapsed)), document.createTextNode("ч пройдено"), element("span", "plan-total", `из ${hours(target)} часов`));
  const progress = element("div", "progress-track");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", `Время по предмету ${subject.title}`);
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", String(target));
  progress.setAttribute("aria-valuenow", String(Math.min(target, elapsed)));
  progress.setAttribute("aria-valuetext", `${duration(elapsed)} из ${hours(target)} часов`);
  const progressFill = element("span");
  progressFill.style.width = `${target ? Math.min(100, Math.max(0, elapsed / target * 100)) : 0}%`;
  progress.append(progressFill);
  const daily = element("div", "subject-daily");
  daily.append(element("span", "", `Сегодня: ${duration(metrics.todaySeconds)}`), element("span", "", `План: ${duration(metrics.dailyTargetSeconds ?? target / finite(subject.durationDays, 25))}`));
  inner.append(plan, progress, daily, renderCalendar(subject, metrics));
  const readiness = element("div", "readiness-row");
  const completeCourses = courses.filter((course) => course.status === "completed").length;
  readiness.append(readinessPill("Время", metrics.budgetReached), readinessPill("Календарь", metrics.calendarSatisfied), readinessPill(`Курсы ${completeCourses}/${courses.length}`, courses.length > 0 && completeCourses === courses.length));
  inner.append(readiness);
  const reason = subject.reason || (subject.status === "running" && !metrics.canRun ? metrics.reason : "");
  if (reason) inner.append(element("p", "subject-reason", reason));
  if (metrics.deadlineMissed) {
    const deadline = element("p", "subject-reason subject-deadline");
    deadline.append(element("strong", "", "План выходит за срок подачи."), document.createTextNode(` Прогноз: ${applicationDate(metrics.projectedFinishDate)}; последний день подачи: ${applicationDate(state.settings.applicationEnd)}. Проверь расписание и актуальные сроки.`));
    inner.append(deadline);
  }
  const actions = element("div", "subject-actions");
  if (status === "running") actions.append(actionButton("Ⅱ  Пауза", "pause", subject.id, "button button-dark button-small"));
  else if (status !== "completed") actions.append(actionButton(status === "idle" ? "▶  Запустить" : "▶  Продолжить", status === "idle" ? "start" : "resume", subject.id, "button button-lime button-small"));
  else { const done = actionButton("Курсы завершены", "open", subject.id, "button button-lime button-small"); actions.append(done); }
  actions.append(actionButton("Открыть ↗", "open", subject.id));
  inner.append(actions);
  card.append(inner, renderCourses(subject, courses));
  if (subject.skippedItems?.length) card.append(renderSkippedItems(subject.skippedItems));
  return card;
}

function renderSkippedItems(items) {
  const details = element("details", "subject-details");
  details.append(element("summary", "", `Пропущенные материалы · ${items.length}`));
  const list = element("ol", "courses-list");
  for (const item of items) {
    const url = safeCourseUrl(item.url);
    const row = element("li", "course-item");
    const body = element("div");
    const name = element(url ? "a" : "span", "course-name", item.title);
    if (url) { name.href = url; name.target = "_blank"; name.rel = "noopener noreferrer"; }
    body.append(name, element("div", "course-meta", item.reason));
    row.append(body); list.append(row);
  }
  details.append(list);
  return details;
}

function readinessPill(label, ready) {
  const pill = element("span", `readiness-pill${ready ? " ready" : ""}`, `${ready ? "✓" : "○"} ${label}`);
  pill.title = ready ? "Условие выполнено" : "Условие ещё не выполнено";
  return pill;
}

function renderCalendar(subject, metrics) {
  const calendar = element("div", "subject-calendar");
  const label = element("div", "calendar-label");
  const totalDays = Math.max(1, Math.min(90, finite(subject.durationDays, 25)));
  const dayIndex = Math.max(0, finite(metrics.dayIndex));
  label.append(element("strong", "", subject.startDate ? `День ${Math.min(totalDays, dayIndex || 1)} из ${totalDays}` : `${totalDays} дней на предмет`), element("span", "", subject.startDate ? `с ${calendarDate(subject.startDate)}` : "С первой активности"));
  const strip = element("div", "calendar-strip");
  strip.setAttribute("aria-hidden", "true");
  for (let day = 1; day <= totalDays; day += 1) strip.append(element("span", `calendar-day${subject.startDate && day < dayIndex ? " elapsed" : ""}${subject.startDate && day === dayIndex ? " current" : ""}`));
  let dateText = metrics.earliestFinishDate ? `Календарный минимум: ${calendarDate(metrics.earliestFinishDate)}` : "Ориентир: 2 часа в день по всем курсам предмета.";
  if (metrics.projectedFinishDate && metrics.projectedFinishDate !== metrics.earliestFinishDate) dateText += ` · Прогноз: ${calendarDate(metrics.projectedFinishDate)}`;
  calendar.append(label, strip, element("p", "calendar-date", dateText));
  return calendar;
}

function safeCourseUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && (url.hostname === "coursera.org" || url.hostname === "www.coursera.org") ? url.href : null; } catch { return null; }
}

function renderCourses(subject, courses) {
  const details = element("details", "subject-details");
  details.open = expandedSubjects.has(subject.id);
  const summary = element("summary");
  summary.append(element("span", "", `Курсы в программе · ${courses.length}`), element("span", "summary-chevron", "⌄"));
  details.append(summary);
  details.addEventListener("toggle", () => { if (details.isConnected) details.open ? expandedSubjects.add(subject.id) : expandedSubjects.delete(subject.id); });
  if (!courses.length) details.append(element("p", "courses-empty", "Открой программу и нажми «Сканировать». Если курс не найден автоматически, добавь его по ссылке."));
  const list = element("ol", "courses-list");
  courses.forEach((course, index) => {
    const item = element("li", "course-item");
    const body = element("div");
    const url = safeCourseUrl(course.url);
    const name = element(url ? "a" : "span", "course-name", course.title || "Курс без названия");
    if (url) { name.href = url; name.target = "_blank"; name.rel = "noopener noreferrer"; }
    const time = `${duration(course.seconds)} активно`;
    const estimate = course.estimatedHours ? ` · оценка Coursera: ${course.estimatedHours} ч` : "";
    const courseStatus = course.status === "completed" ? "completed" : course.id === subject.currentCourseId ? subject.status : course.status;
    body.append(name, element("div", `course-meta${course.status === "completed" ? " course-complete" : ""}`, `${COURSE_STATUS[courseStatus] || "В очереди"} · ${time}${estimate}`));
    item.append(element("span", "course-number", String(index + 1).padStart(2, "0")), body);
    list.append(item);
  });
  const tools = element("div", "subject-tools");
  const left = element("div");
  left.append(actionButton("Сканировать", "scan", subject.id, "text-button"), actionButton("＋ Курс", "add-course", subject.id, "text-button"));
  tools.append(left, actionButton("Удалить", "remove", subject.id, "text-button delete-button"));
  details.append(list, tools);
  return details;
}

function renderCatalog() {
  const fragment = document.createDocumentFragment();
  PRESETS.forEach((preset, index) => {
    const added = state.subjects.some((subject) => subject.programUrl?.replace(/\/$/, "") === preset.url);
    const card = element("article", "catalog-card");
    const top = element("div", "catalog-top");
    top.append(element("span", "", preset.provider), element("span", "catalog-symbol", preset.symbol));
    const bottom = element("div", "catalog-bottom");
    const add = element("button", "catalog-add", added ? "✓" : "+");
    add.type = "button";
    add.dataset.preset = index;
    add.disabled = added;
    add.setAttribute("aria-label", added ? `${preset.short} уже добавлен` : `Добавить ${preset.short}`);
    add.title = added ? "Уже добавлен" : "Добавить предмет";
    bottom.append(element("span", "", "50 ч / 25 дней"), add);
    card.append(top, element("h3", "", preset.short), element("p", "catalog-description", preset.description), bottom);
    fragment.append(card);
  });
  $("catalog").replaceChildren(fragment);
}

function logDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  try { return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: state.settings.timeZone }).format(date); } catch { return date.toLocaleTimeString("ru-RU"); }
}

function renderLogs() {
  $("log-count").textContent = state.logs.length;
  const fragment = document.createDocumentFragment();
  const recent = [...state.logs].sort((a, b) => new Date(b.at || b.ts || b.timestamp || b.time || 0) - new Date(a.at || a.ts || a.timestamp || a.time || 0)).slice(0, 80);
  if (!recent.length) fragment.append(element("p", "log-empty", "Здесь появятся запуски, паузы, переходы и ошибки."));
  recent.forEach((log) => {
    const row = element("div", "log-entry");
    const text = element("div", "log-message");
    const subject = state.subjects.find((item) => item.id === log.subjectId);
    if (subject) text.append(element("span", "log-subject", subject.title));
    text.append(document.createTextNode(log.message || log.text || log.event || "Событие"));
    row.append(element("span", "log-time", logDate(log.at || log.ts || log.timestamp || log.time)), text);
    fragment.append(row);
  });
  $("logs").replaceChildren(fragment);
}

function render() {
  renderOverview();
  $("subjects").replaceChildren(...state.subjects.map(renderSubject));
  renderCatalog();
  renderLogs();
  let usageToday = false;
  try { usageToday = state.aiUsage?.date === new Intl.DateTimeFormat("en-CA", { timeZone: state.settings.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); } catch { /* Invalid settings are reported by the background process. */ }
  $("ai-usage").textContent = `Сегодня: ${usageToday ? finite(state.aiUsage?.requests) : 0} запросов · ${usageToday ? finite(state.aiUsage?.tokens) : 0} токенов`;
}

function openAdd() {
  $("add-form").reset();
  formError("add-error");
  $("add-dialog").showModal();
}

function openSettings() {
  const settings = state.settings;
  $("window-start").value = settings.windowStart;
  $("window-end").value = settings.windowEnd;
  $("timezone").value = settings.timeZone;
  $("max-parallel").value = settings.maxParallel;
  $("skip-manual").checked = settings.skipManual === true;
  $("application-start").value = settings.applicationStart || "";
  $("application-end").value = settings.applicationEnd || "";
  $("ai-enabled").checked = settings.ai.enabled;
  $("ai-endpoint").value = settings.ai.endpoint || "";
  $("ai-model").value = settings.ai.model || "";
  $("ai-key").value = "";
  $("ai-key").placeholder = state.hasApiKey ? "Ключ уже сохранён — вводить повторно не нужно" : "Вставьте ключ API провайдера";
  $("clear-key").checked = false;
  $("ai-requests").value = settings.ai.dailyRequests;
  $("ai-tokens").value = settings.ai.maxOutputTokens;
  $("ai-auto-submit").checked = settings.ai.autoSubmit;
  $("ai-auto-honor-code").checked = settings.ai.autoHonorCode === true;
  $("ai-auto-dialogue").checked = settings.ai.autoDialogue;
  $("ai-dialogue-turns").value = settings.ai.dialogueMaxTurns;
  $("key-status").textContent = state.hasApiKey ? "Ключ сохранён локально" : "Не сохранён";
  const storageNote = $("key-storage-note") || element("p", "field-hint");
  storageNote.id = "key-storage-note";
  storageNote.textContent = state.hasApiKey
    ? "Сохранённый ключ скрыт. Пустое поле не удаляет его. Перезагрузка и обновление той же установленной копии сохраняют ключ; удаление расширения или другая папка установки — нет."
    : "В этой установленной копии ключа нет. У каждой копии расширения и каждого профиля Chrome своё хранилище.";
  $("ai-key").parentElement.after(storageNote);
  formError("settings-error");
  $("settings-dialog").showModal();
}

async function submitForm(form, errorId, message, onSuccess) {
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  formError(errorId);
  const result = await send(message);
  submit.disabled = false;
  if (!result.ok) { formError(errorId, result.error); return; }
  acceptState(result.state);
  if (!result.state) await refresh();
  onSuccess();
}

$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const programUrl = $("subject-url").value.trim();
  if (!safeCourseUrl(programUrl)) { formError("add-error", "Нужна HTTPS-ссылка на coursera.org."); return; }
  await submitForm(event.currentTarget, "add-error", { type: "ADD_SUBJECT", title: $("subject-title").value.trim(), programUrl }, () => { $("add-dialog").close(); toast("Предмет добавлен. Можно запускать маршрут."); });
});

$("course-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = $("course-url").value.trim();
  if (!safeCourseUrl(url)) { formError("course-error", "Нужна HTTPS-ссылка на курс Coursera."); return; }
  await submitForm(event.currentTarget, "course-error", { type: "ADD_COURSE", id: $("course-subject-id").value, title: $("course-name").value.trim(), url }, () => { $("course-dialog").close(); toast("Курс добавлен в общий бюджет предмета."); });
});

function endpointOrigin(endpoint) {
  const url = new URL(endpoint);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || !(url.protocol === "https:" || (url.protocol === "http:" && local))) throw new Error("Адрес API должен использовать HTTPS; HTTP доступен только на localhost. Убери пароль, query-параметры и #фрагмент из URL. Ключ укажи отдельно.");
  return `${url.origin}/*`;
}

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  formError("settings-error");
  const timeZone = $("timezone").value.trim();
  try { new Intl.DateTimeFormat("ru-RU", { timeZone }); } catch { formError("settings-error", "Неизвестный часовой пояс. Пример: Asia/Qyzylorda."); return; }
  const applicationStart = $("application-start").value;
  const applicationEnd = $("application-end").value;
  if (applicationStart && applicationEnd && applicationStart > applicationEnd) { formError("settings-error", "Последний день подачи должен быть не раньше первого."); return; }
  const endpoint = $("ai-endpoint").value.trim();
  const enabled = $("ai-enabled").checked;
  const dialogueMaxTurns = Number($("ai-dialogue-turns").value);
  if (!Number.isInteger(dialogueMaxTurns) || dialogueMaxTurns < 1 || dialogueMaxTurns > 30) {
    formError("settings-error", "Лимит сообщений Coach должен быть целым числом от 1 до 30.");
    return;
  }
  if (enabled && (!endpoint || !$("ai-model").value.trim())) { formError("settings-error", "Для ИИ укажи адрес API и название модели."); return; }
  if (endpoint) {
    try {
      const origin = endpointOrigin(endpoint);
      if (enabled) {
        if (!globalThis.chrome?.permissions?.request) throw new Error("Разрешение сервиса можно выдать только внутри установленного расширения.");
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) { formError("settings-error", "Доступ к API не разрешён. Настройки не сохранены."); return; }
      }
    } catch (error) { formError("settings-error", error.message || "Проверь адрес API."); return; }
  }
  const settings = { ...state.settings, timeZone, windowStart: $("window-start").value, windowEnd: $("window-end").value, maxParallel: Number($("max-parallel").value), skipManual: $("skip-manual").checked, applicationStart, applicationEnd, ai: { ...state.settings.ai, enabled, endpoint, model: $("ai-model").value.trim(), dailyRequests: Number($("ai-requests").value), maxOutputTokens: Number($("ai-tokens").value), autoSubmit: $("ai-auto-submit").checked, autoHonorCode: $("ai-auto-honor-code").checked, autoDialogue: $("ai-auto-dialogue").checked, dialogueMaxTurns } };
  const message = { type: "UPDATE_SETTINGS", settings };
  if ($("clear-key").checked) message.apiKey = "";
  else if ($("ai-key").value.trim()) message.apiKey = $("ai-key").value.trim();
  await submitForm(form, "settings-error", message, () => { $("ai-key").value = ""; $("settings-dialog").close(); toast("Расписание и настройки сохранены."); });
});

$("subjects").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, subject: id } = button.dataset;
  const subject = state.subjects.find((item) => item.id === id);
  if (!subject) return;
  if (action === "add-course") {
    $("course-form").reset();
    $("course-subject-id").value = id;
    formError("course-error");
    $("course-dialog").showModal();
    return;
  }
  if (action === "remove" && !confirm(`Удалить предмет «${subject.title}» и его локальный прогресс из CoursePilot? Аккаунт Coursera не изменится.`)) return;
  busySubjects.add(id);
  render();
  const result = await send({ type: "SUBJECT_ACTION", id, action });
  busySubjects.delete(id);
  acceptState(result.state);
  if (!result.ok) { toast(result.error, true); render(); return; }
  if (!result.state) await refresh();
  if (action === "scan") toast("Сканирование запрошено. Оставь страницу курса открытой.");
  if (action === "remove") toast("Предмет удалён из локального списка.");
});

$("catalog").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-preset]");
  if (!button) return;
  const preset = PRESETS[Number(button.dataset.preset)];
  if (!preset) return;
  button.disabled = true;
  const result = await send({ type: "ADD_SUBJECT", title: preset.title, programUrl: preset.url });
  if (!result.ok) { button.disabled = false; toast(result.error, true); return; }
  acceptState(result.state);
  if (!result.state) await refresh();
  toast(`${preset.short}: маршрут добавлен.`);
});

function omitSecrets(value) {
  if (Array.isArray(value)) return value.map(omitSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(api[-_]?(key|secret)|authorization|secret|access[-_]?token|refresh[-_]?token)$/i.test(key)).map(([key, entry]) => [key, omitSecrets(entry)]));
}

$("export").addEventListener("click", async () => {
  const result = await send({ type: "EXPORT_DATA" });
  if (!result.ok) { toast(result.error, true); return; }
  const blob = new Blob([JSON.stringify(omitSecrets(result.data), null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = element("a");
  anchor.href = url;
  anchor.download = `coursepilot-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Данные экспортированы без ключа API.");
});

$("reset-ai").addEventListener("click", async () => {
  $("reset-ai").disabled = true;
  const result = await send({ type: "RESET_AI" });
  $("reset-ai").disabled = false;
  if (!result.ok) { formError("settings-error", result.error); return; }
  acceptState(result.state);
  formError("settings-error");
  toast("Кэш ответов ИИ очищен. Лимит запросов сохранён.");
});

$("clear-key").addEventListener("change", () => { $("ai-key").disabled = $("clear-key").checked; });
$("settings-dialog").addEventListener("close", () => { $("ai-key").value = ""; $("ai-key").disabled = false; });
$("settings-open").addEventListener("click", openSettings);
$("add-open").addEventListener("click", openAdd);
$("empty-add").addEventListener("click", openAdd);
$("refresh").addEventListener("click", () => void refresh());
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(button.dataset.close).close()));
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
globalThis.chrome?.storage?.onChanged?.addListener(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refresh(), 250);
});
setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
const installedVersion = globalThis.chrome?.runtime?.getManifest?.().version;
$("extension-version").textContent = installedVersion ? `CoursePilot ${installedVersion}` : "Предпросмотр — расширение не подключено";
render();
void refresh();
