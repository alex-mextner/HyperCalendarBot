import { describe, expect, test } from 'bun:test';
import { parseEventPhrase } from '../../../src/services/intent/event-phrase.ts';
import { WorkflowInputError } from '../../../src/services/intent/workflow-input.ts';

// Monday 2026-10-05 09:30 in Belgrade. Relative words are computed from this frozen clock, never from the real one.
const NOW = new Date('2026-10-05T07:30:00Z');
const options = { now: NOW, timezone: 'Europe/Belgrade', requireTitle: true };
const parse = (text: string) => parseEventPhrase(text, options);

describe('free-form event phrase', () => {
  test.each([
    ['стендап завтра в 10:30', { title: 'Стендап', date: '2026-10-06', time: '10:30' }],
    ['встречу с юристом послезавтра в 15:30', { title: 'Встреча с юристом', date: '2026-10-07', time: '15:30' }],
    ['завтра в 15:00 стоматолог', { title: 'Стоматолог', date: '2026-10-06', time: '15:00' }],
    ['созвон с Пашей в пятницу в 18:30', { title: 'Созвон с Пашей', date: '2026-10-09', time: '18:30' }],
    ['ужин 12 октября в 7 вечера', { title: 'Ужин', date: '2026-10-12', time: '19:00' }],
    ['dentist tomorrow at 3pm', { title: 'Dentist', date: '2026-10-06', time: '15:00' }],
    ['retro on october 9 at 16:00', { title: 'Retro', date: '2026-10-09', time: '16:00' }],
    ['йога через 3 дня в 19:00', { title: 'Йога', date: '2026-10-08', time: '19:00' }],
    ['планирование 2026-10-14 в 11:00', { title: 'Планирование', date: '2026-10-14', time: '11:00' }],
    ['обед в полдень завтра', { title: 'Обед', date: '2026-10-06', time: '12:00' }],
    ['позвонить врачу завтра в 15', { title: 'Позвонить врачу', date: '2026-10-06', time: '15:00' }],
    ['ревью 15.10 в 14:00', { title: 'Ревью', date: '2026-10-15', time: '14:00' }],
  ])('reads %p', (text, expected) => {
    expect(parse(text)).toMatchObject(expected);
  });

  test('reads a clock range and a duration', () => {
    expect(parse('воркшоп завтра с 14:00 до 15:30')).toMatchObject({
      time: '14:00',
      endTime: '15:30',
      title: 'Воркшоп',
    });
    expect(parse('созвон завтра в 11:00 на 45 минут')).toMatchObject({ time: '11:00', durationMinutes: 45 });
    expect(parse('созвон завтра в 11:00 на час')).toMatchObject({ durationMinutes: 60 });
  });

  test('reads an invitation clause and removes it from the title', () => {
    expect(parse('встреча завтра в 15:00 и пригласи @ivan_petrov')).toMatchObject({
      title: 'Встреча',
      invitee: 'ivan_petrov',
    });
  });

  test('keeps the original case of the title', () => {
    expect(parse('созвон с Иваном Петровым завтра в 15:00').title).toBe('Созвон с Иваном Петровым');
  });

  test.each([
    ['bare hour 10', 'стендап завтра в 10'],
    ['bare hour 3', 'dentist tomorrow at 3'],
    ['two days', 'стендап завтра и послезавтра в 10:30'],
    ['two times', 'стендап завтра в 10:30 и в 12:00'],
    ['next weekday', 'стендап в следующую пятницу в 10:30'],
    ['next weekday en', 'standup next friday at 10:30'],
    ['own weekday', 'стендап в понедельник в 10:30'],
    ['day part', 'позвонить маме завтра вечером в 19:00'],
    ['two mentions', 'встреча с @anna_smith и @mark_t1 завтра в 15:00'],
    ['command in title', 'удали встречу завтра в 15:00'],
    ['question', 'что у меня завтра в 15:00'],
    ['no title', 'завтра в 15:00'],
    ['impossible date', 'встреча 31 февраля в 15:00'],
    ['invalid minutes', 'встреча завтра в 15:75'],
    ['end before start', 'встреча завтра с 16:00 до 15:00'],
    ['bare day range', 'отпуск 5-7 октября'],
  ])('refuses %s', (_name, text) => {
    expect(() => parse(text)).toThrow(WorkflowInputError);
  });
});
