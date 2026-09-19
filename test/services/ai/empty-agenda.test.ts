import { expect, test } from 'bun:test';
import { formatEmptyAgenda } from '../../../src/services/ai/empty-agenda.ts';

const base = {
  language: 'ru' as const,
  timezone: 'Europe/Belgrade',
  scope: 'personal' as const,
  now: new Date('2026-09-19T21:30:00Z'),
};
test('answers tomorrow with the checked local date rather than a database-range phrase', () => {
  const text = formatEmptyAgenda({ ...base, start: '2026-09-20T00:00:00+02:00', end: '2026-09-20T23:59:59.999+02:00' });
  expect(text).toBe('На завтра, 20 сентября, в твоём календаре пока ничего не запланировано.');
  expect(text).not.toMatch(/диапазон|не найдено|свободен|отдыхай/i);
});
test('tomorrow follows the user timezone, not UTC or the machine timezone', () => {
  const text = formatEmptyAgenda({
    ...base,
    now: new Date('2026-09-19T22:30:00Z'),
    start: '2026-09-21T00:00:00+02:00',
    end: '2026-09-21T23:59:59.999+02:00',
  });
  expect(text).toContain('На завтра, 21 сентября');
});
test('group and delegated calendars are identified without pretending to be the personal calendar', () => {
  const query = { ...base, start: '2026-09-20T00:00:00+02:00', end: '2026-09-20T23:59:59.999+02:00' };
  expect(formatEmptyAgenda({ ...query, scope: 'group' })).toContain('в календаре этой группы');
  expect(formatEmptyAgenda({ ...query, delegated: true })).toContain('в выбранном календаре');
});
test('a one-hour search cannot be described as a whole free day', () => {
  const text = formatEmptyAgenda({ ...base, start: '2026-09-20T09:00:00+02:00', end: '2026-09-20T10:00:00+02:00' });
  expect(text).toContain('09:00–10:00');
  expect(text).toContain('20 сентября');
  expect(text).not.toMatch(/день свободен|на завтра.*ничего не запланировано/i);
});
test('the year and both dates are present for cross-year ranges', () => {
  const text = formatEmptyAgenda({ ...base, start: '2026-12-31T00:00:00+01:00', end: '2027-01-02T23:59:59.999+01:00' });
  expect(text).toContain('31 декабря 2026');
  expect(text).toContain('2 января 2027');
});
test.each(['2026-03-29', '2026-10-25'])('a daylight-saving day is still one calendar day: %s', (date) => {
  const start = date === '2026-03-29' ? '2026-03-29T00:00:00+01:00' : '2026-10-25T00:00:00+02:00';
  const end = date === '2026-03-29' ? '2026-03-29T23:59:59.999+02:00' : '2026-10-25T23:59:59.999+01:00';
  expect(formatEmptyAgenda({ ...base, start, end })).not.toMatch(/00:00|23:59/);
});
test('English is equally specific and never switches language', () => {
  const text = formatEmptyAgenda({
    ...base,
    language: 'en',
    start: '2026-09-20T00:00:00+02:00',
    end: '2026-09-20T23:59:59.999+02:00',
  });
  expect(text).toBe('No events are scheduled in your calendar for tomorrow, September 20.');
});
test.each([
  ['garbage', '2026-09-20'],
  ['2026-09-21', '2026-09-20'],
])('invalid ranges never become an empty-calendar claim', (start, end) => {
  expect(() => formatEmptyAgenda({ ...base, start, end })).toThrow();
});

test('zero-length timestamp queries are rejected, not presented as a full day', () => {
  expect(() =>
    formatEmptyAgenda({ ...base, start: '2026-09-20T09:00:00+02:00', end: '2026-09-20T09:00:00+02:00' }),
  ).toThrow();
});
