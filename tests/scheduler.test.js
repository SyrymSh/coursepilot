import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, createSubject, dateKey, getRunnableSubjects, normalizeCourseUrl, normalizeProgramUrl, planSubject, recordActivity } from '../extension/core/scheduler.js';

const settings = { timeZone: 'Asia/Qyzylorda', windowStart: '09:00', windowEnd: '21:00', maxParallel: 4 };
const timestamp = (date = '2026-10-09', clock = '10:00:00') => Date.parse(`${date}T${clock}+05:00`);

function subject(overrides = {}) {
  const result = createSubject({ title: 'Software Architecture', programUrl: 'https://www.coursera.org/specializations/software-design-architecture' }, timestamp('2026-10-09', '09:00:00'));
  assert.equal(result.ok, true);
  return {
    ...result.value, status: 'running',
    courses: [{ id: 'course-a', seconds: 0 }, { id: 'course-b', seconds: 0 }],
    ...overrides,
  };
}

test('new subjects share 50 hours across courses and do not start before activity', () => {
  const item = subject();
  assert.equal(item.targetSeconds, 180000);
  assert.equal(item.durationDays, 25);
  assert.equal(item.startDate, null);
  const plan = planSubject(item, settings, timestamp());
  assert.equal(plan.dailyTargetSeconds, 7200);
  assert.equal(plan.earliestFinishDate, '2026-11-02');
  assert.equal(plan.projectedFinishDate, '2026-11-02');
  assert.equal(plan.remainingDays, 25);
  const first = recordActivity(item, { now: timestamp(), seconds: 20, courseId: 'course-a', source: 'video' }, settings);
  const second = recordActivity(first, { now: timestamp() + 20000, seconds: 20, courseId: 'course-b', source: 'reading' }, settings);
  assert.equal(item.elapsedSeconds, 0);
  assert.equal(second.elapsedSeconds, 40);
  assert.equal(second.dailySeconds['2026-10-09'], 40);
  assert.equal(second.startDate, '2026-10-09');
  assert.deepEqual(second.courses.map(({ seconds }) => seconds), [20, 20]);
  assert.equal(planSubject(second, settings, timestamp()).dailyTargetSeconds, 7200);
});

test('independent subjects run in parallel with a stable concurrency cap', () => {
  const first = subject();
  const second = subject();
  const third = subject({ status: 'paused', reason: 'Задание требует действия' });
  const fourth = subject();
  assert.notEqual(first.id, second.id);
  const state = { settings: { ...settings, maxParallel: 2 }, subjects: [first, second, third, fourth] };
  assert.deepEqual(getRunnableSubjects(state, timestamp()).map(({ id }) => id), [first.id, second.id]);
  assert.equal(planSubject(second, settings, timestamp()).remainingSeconds, 180000);
});

test('25 calendar days are inclusive and the time budget never completes a course', () => {
  const item = subject({ startDate: '2026-10-09', elapsedSeconds: 180000 });
  const day24 = planSubject(item, settings, timestamp('2026-11-01'));
  const day25 = planSubject(item, settings, timestamp('2026-11-02'));
  assert.equal(day24.dayIndex, 24);
  assert.equal(day24.calendarSatisfied, false);
  assert.equal(day25.dayIndex, 25);
  assert.equal(day25.calendarSatisfied, true);
  assert.equal(day25.budgetReached, true);
  assert.equal(day25.canRun, false);
  assert.equal(item.status, 'running');
  assert.equal(item.completedAt, null);
});

test('missed days redistribute work, overdue subjects keep running', () => {
  const item = subject({ startDate: '2026-10-09', elapsedSeconds: 3600 });
  const plan = planSubject(item, settings, timestamp('2026-10-19'));
  assert.equal(plan.dayIndex, 11);
  assert.equal(plan.remainingDays, 15);
  assert.equal(plan.dailyTargetSeconds, 11760);
  const overdue = planSubject(item, settings, timestamp('2026-11-03'));
  assert.equal(overdue.remainingDays, 1);
  assert.equal(overdue.dailyTargetSeconds, 43200);
  assert.equal(overdue.canRun, true);
  assert.ok(overdue.projectedFinishDate > overdue.earliestFinishDate);
});

test('a short working window projects the additional days needed', () => {
  const plan = planSubject(subject(), { ...settings, windowEnd: '10:00' }, timestamp('2026-10-09', '09:00:00'));
  assert.equal(plan.dailyTargetSeconds, 3600);
  assert.equal(plan.projectedFinishDate, '2026-11-27');
});

test('daily and total caps cannot be exceeded by the final sample', () => {
  const almostDaily = subject({ startDate: '2026-10-09', elapsedSeconds: 7190, dailySeconds: { '2026-10-09': 7190 } });
  const fullDay = recordActivity(almostDaily, { now: timestamp(), seconds: 30, courseId: 'course-a', source: 'video' }, settings);
  assert.equal(fullDay.elapsedSeconds, 7200);
  assert.equal(planSubject(fullDay, settings, timestamp()).canRun, false);
  const almostTotal = subject({ startDate: '2026-10-09', elapsedSeconds: 179990 });
  const fullTotal = recordActivity(almostTotal, { now: timestamp('2026-11-02'), seconds: 30, courseId: 'course-a', source: 'activity' }, settings);
  assert.equal(fullTotal.elapsedSeconds, 180000);
  assert.equal(fullTotal.status, 'running');
  assert.equal(fullTotal.completedAt, null);
});

test('sleep, idle events, unknown courses and invalid samples add no time', () => {
  const item = subject();
  for (const sample of [
    { seconds: 7200, source: 'video' }, { seconds: 10, source: 'idle' },
    { seconds: 0, source: 'video' }, { seconds: -5, source: 'video' },
    { seconds: Number.NaN, source: 'video' }, { seconds: 10, source: 'video', courseId: 'missing' },
  ]) {
    assert.equal(recordActivity(item, { now: timestamp(), courseId: 'course-a', ...sample }, settings), item);
  }
  const afterSleep = planSubject(item, settings, timestamp('2026-10-20'));
  assert.equal(afterSleep.remainingSeconds, 180000);
  assert.equal(item.startDate, null);
});

test('duplicate and backwards samples cannot fabricate overlapping activity', () => {
  const item = subject();
  const first = recordActivity(item, { now: timestamp(), seconds: 20, courseId: 'course-a', source: 'video' }, settings);
  for (const now of [timestamp(), timestamp() - 1000]) {
    assert.equal(recordActivity(first, { now, seconds: 20, courseId: 'course-a', source: 'video' }, settings), first);
  }
  const overlap = recordActivity(first, { now: timestamp() + 5000, seconds: 20, courseId: 'course-b', source: 'video' }, settings);
  assert.equal(overlap.elapsedSeconds, 25);
});

test('working window uses local time, excludes its end, and rejects overnight windows', () => {
  const item = subject();
  assert.equal(planSubject(item, settings, timestamp('2026-10-09', '08:59:59')).canRun, false);
  assert.equal(planSubject(item, settings, timestamp('2026-10-09', '09:00:00')).canRun, true);
  assert.equal(planSubject(item, settings, timestamp('2026-10-09', '21:00:00')).canRun, false);
  const overnight = planSubject(item, { ...settings, windowStart: '22:00', windowEnd: '06:00' }, timestamp());
  assert.equal(overnight.canRun, false);
  assert.match(overnight.reason, /раньше конца/);
  const opening = recordActivity(item, { now: timestamp('2026-10-09', '09:00:01'), seconds: 30, source: 'video', courseId: 'course-a' }, settings);
  assert.equal(opening.elapsedSeconds, 1);
});

test('calendar arithmetic and local dates remain correct around DST and midnight', () => {
  assert.equal(addDays('2026-10-09', 24), '2026-11-02');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-02-30', 1), null);
  assert.equal(dateKey(Date.parse('2026-10-08T20:00:00Z')), '2026-10-09');
  assert.equal(dateKey(Date.parse('2026-03-08T06:59:00Z'), 'America/New_York'), '2026-03-08');
  assert.equal(dateKey(Date.parse('2026-03-08T07:01:00Z'), 'America/New_York'), '2026-03-08');
  const dstSubject = subject({ startDate: '2026-03-07' });
  const plan = planSubject(dstSubject, { ...settings, timeZone: 'America/New_York' }, Date.parse('2026-03-09T15:00:00Z'));
  assert.equal(plan.dayIndex, 3);
  assert.equal(plan.earliestFinishDate, '2026-03-31');
});

test('URLs are normalized without permitting lookalike hosts or arbitrary redirects', () => {
  assert.equal(normalizeCourseUrl('https://coursera.org/learn/software-design/video/abc?x=1'), 'https://www.coursera.org/learn/software-design/home');
  assert.equal(normalizeProgramUrl('https://www.coursera.org/professional-certificates/google-cybersecurity/?ref=foo'), 'https://www.coursera.org/professional-certificates/google-cybersecurity');
  assert.equal(normalizeProgramUrl('https://www.coursera.org/specializations/software-design-architecture'), subject().programUrl);
  for (const url of ['https://coursera.org.evil.test/learn/test', 'https://www.coursera.org@evil.test/learn/test', 'javascript:alert(1)', 'http://coursera.org/learn/test', 'https://coursera.org/browse', 'https://coursera.org:444/learn/test']) {
    assert.equal(normalizeProgramUrl(url), null);
  }
});

test('invalid configuration returns a blocked plan or an error value', () => {
  assert.equal(createSubject({ title: '', programUrl: 'https://coursera.org/learn/test' }).ok, false);
  assert.equal(createSubject(null).ok, false);
  assert.equal(createSubject({ title: 'Test', programUrl: 'https://example.com' }).ok, false);
  assert.equal(dateKey(timestamp(), 'Invalid/Zone'), null);
  assert.equal(planSubject(subject(), { ...settings, timeZone: 'Invalid/Zone' }, timestamp()).canRun, false);
  assert.equal(planSubject(subject({ startDate: '2026-10-10' }), settings, timestamp()).canRun, false);
  assert.deepEqual(getRunnableSubjects(null, timestamp()), []);
});
