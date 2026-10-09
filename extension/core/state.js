export const STATE_KEY = 'coursepilotState';

export function defaultState() {
  return {
    version: 1,
    settings: {
      timeZone: 'Asia/Qyzylorda', windowStart: '09:00', windowEnd: '21:00', maxParallel: 4, skipManual: true,
      applicationStart: '2026-11-02', applicationEnd: '2026-11-09',
      ai: { enabled: false, endpoint: '', model: '', dailyRequests: 40, maxOutputTokens: 800, autoSubmit: false, autoHonorCode: false, autoDialogue: false, dialogueMaxTurns: 12 },
    },
    subjects: [], logs: [], aiUsage: { date: '', requests: 0, tokens: 0 }, aiCache: [],
  };
}

export function validateSettings(settings) {
  const fail = (error) => ({ ok: false, error });
  if (!settings || typeof settings !== 'object') return fail('Некорректные настройки.');
  try { new Intl.DateTimeFormat('en', { timeZone: settings.timeZone }).format(); }
  catch { return fail('Неизвестный часовой пояс.'); }
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!clock.test(settings.windowStart) || !clock.test(settings.windowEnd) || settings.windowStart >= settings.windowEnd) {
    return fail('Окно работы должно заканчиваться позже начала в тот же день.');
  }
  if (!Number.isInteger(settings.maxParallel) || settings.maxParallel < 1 || settings.maxParallel > 4) return fail('Параллельность: от 1 до 4 предметов.');
  if (settings.skipManual != null && typeof settings.skipManual !== 'boolean') return fail('Пропуск ручных материалов должен быть включён или выключен.');
  const date = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if ((settings.applicationStart && !date(settings.applicationStart)) || (settings.applicationEnd && !date(settings.applicationEnd))) return fail('Некорректная дата подачи заявления.');
  if (settings.applicationStart && settings.applicationEnd && settings.applicationStart > settings.applicationEnd) return fail('Конец подачи должен быть не раньше начала.');
  const ai = settings.ai;
  if (!ai || !Number.isInteger(ai.dailyRequests) || ai.dailyRequests < 1 || ai.dailyRequests > 500) return fail('Лимит ИИ: 1–500 запросов в день.');
  if (!Number.isInteger(ai.maxOutputTokens) || ai.maxOutputTokens < 128 || ai.maxOutputTokens > 4096) return fail('Лимит ответа ИИ: 128–4096 токенов.');
  if (typeof ai.model !== 'string' || ai.model.length > 150) return fail('Некорректное название модели.');
  if (typeof ai.autoDialogue !== 'boolean') return fail('Автодиалог должен быть включён или выключен.');
  if (typeof ai.autoHonorCode !== 'boolean') return fail('Автогалочка Honor Code должна быть включена или выключена.');
  if (!Number.isInteger(ai.dialogueMaxTurns) || ai.dialogueMaxTurns < 1 || ai.dialogueMaxTurns > 30) return fail('Лимит автодиалога: 1–30 ответов на задание.');
  return { ok: true };
}

export function addLog(state, subjectId, message, now = Date.now()) {
  state.logs = [{ id: crypto.randomUUID(), subjectId, message: String(message).slice(0, 350), at: now }, ...state.logs].slice(0, 150);
}

export function publicState(state, metrics, hasApiKey) {
  const { aiCache, ...data } = state;
  return { ...structuredClone(data), hasApiKey, metrics };
}

export function exportState(state, now = Date.now()) {
  return {
    exportedAt: new Date(now).toISOString(), version: state.version,
    settings: { ...state.settings, ai: { ...state.settings.ai, enabled: false } },
    subjects: state.subjects.map(({ tabId, accountKey, lastActivityAt, lastActivitySource, ...subject }) => subject),
    note: 'Локальный журнал активности. Не является сертификатом или подтверждением перезачёта.',
  };
}
