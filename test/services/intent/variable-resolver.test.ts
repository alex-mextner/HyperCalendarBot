import { describe, expect, test } from 'bun:test';
import { resolveVariables } from '../../../src/services/intent/variable-resolver.ts';

describe('resolveVariables', () => {
  const userCtx = {
    timezone: 'Europe/Moscow',
    language: 'ru',
    username: 'ultra',
    firstName: 'Alex',
    userId: 5153477378,
  };

  test('resolves {{dates.today}} to YYYY-MM-DD in user timezone', () => {
    const result = resolveVariables('{{dates.today}}', {}, userCtx);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('resolves {{dates.tomorrow}} after today', () => {
    const today = resolveVariables('{{dates.today}}', {}, userCtx) as string;
    const tomorrow = resolveVariables('{{dates.tomorrow}}', {}, userCtx) as string;
    expect(tomorrow > today).toBe(true);
  });

  test('resolves capture groups {{$1}}', () => {
    expect(resolveVariables('{{$1}}', { $1: 'hello' }, userCtx)).toBe('hello');
  });

  test('resolves user context {{user.timezone}}', () => {
    expect(resolveVariables('{{user.timezone}}', {}, userCtx)).toBe('Europe/Moscow');
  });

  test('resolves step results {{results[0].id}}', () => {
    const stepResults = { results: [{ id: 42 }] };
    expect(resolveVariables('{{results[0].id}}', {}, userCtx, stepResults)).toBe(42);
  });

  test('resolves step results {{results.length}}', () => {
    const stepResults = { results: [1, 2, 3] };
    expect(resolveVariables('{{results.length}}', {}, userCtx, stepResults)).toBe(3);
  });

  test('resolves variables in nested objects', () => {
    const input = { start_date: '{{dates.today}}', nested: { end_date: '{{dates.tomorrow}}' } };
    const result = resolveVariables(input, {}, userCtx) as { [key: string]: unknown };
    expect(result.start_date as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((result.nested as { [key: string]: unknown }).end_date as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('mixed text with variables', () => {
    const result = resolveVariables('Events for {{$1}}', { $1: 'tomorrow' }, userCtx);
    expect(result).toBe('Events for tomorrow');
  });

  test('resolves arrays', () => {
    const input = ['{{dates.today}}', '{{dates.tomorrow}}'];
    const result = resolveVariables(input, {}, userCtx) as string[];
    expect(result[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('passes through non-template values', () => {
    expect(resolveVariables(42, {}, userCtx)).toBe(42);
    expect(resolveVariables(true, {}, userCtx)).toBe(true);
    expect(resolveVariables(null, {}, userCtx)).toBeNull();
  });

  test('resolves {{dates.week_start}} and {{dates.week_end}}', () => {
    const weekStart = resolveVariables('{{dates.week_start}}', {}, userCtx) as string;
    const weekEnd = resolveVariables('{{dates.week_end}}', {}, userCtx) as string;
    expect(weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(weekEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(weekEnd >= weekStart).toBe(true);
  });

  test('resolves {{dates.month_start}} and {{dates.month_end}}', () => {
    const monthStart = resolveVariables('{{dates.month_start}}', {}, userCtx) as string;
    const monthEnd = resolveVariables('{{dates.month_end}}', {}, userCtx) as string;
    expect(monthStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(monthEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(monthEnd >= monthStart).toBe(true);
  });

  test('resolves {{user.language}}', () => {
    expect(resolveVariables('{{user.language}}', {}, userCtx)).toBe('ru');
  });

  test('resolves {{user.username}} to sender username without @', () => {
    expect(resolveVariables('{{user.username}}', {}, userCtx)).toBe('ultra');
  });

  test('resolves {{user.first_name}} to sender first name', () => {
    expect(resolveVariables('{{user.first_name}}', {}, userCtx)).toBe('Alex');
  });

  test('resolves {{user.id}} to sender Telegram ID as number', () => {
    expect(resolveVariables('{{user.id}}', {}, userCtx)).toBe(5153477378);
  });

  test('{{user.username}} stays unresolved when username not set', () => {
    const ctx = { timezone: 'UTC', language: 'en' };
    expect(resolveVariables('{{user.username}}', {}, ctx)).toBe('{{user.username}}');
  });

  test('resolves {{dates.yesterday}} to date before today', () => {
    const today = resolveVariables('{{dates.today}}', {}, userCtx) as string;
    const yesterday = resolveVariables('{{dates.yesterday}}', {}, userCtx) as string;
    expect(yesterday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(yesterday < today).toBe(true);
  });

  test('resolves {{dates.next_week_start}} and {{dates.next_week_end}} after this week', () => {
    const weekEnd = resolveVariables('{{dates.week_end}}', {}, userCtx) as string;
    const nextStart = resolveVariables('{{dates.next_week_start}}', {}, userCtx) as string;
    const nextEnd = resolveVariables('{{dates.next_week_end}}', {}, userCtx) as string;
    expect(nextStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nextEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nextStart > weekEnd).toBe(true);
    expect(nextEnd >= nextStart).toBe(true);
  });

  test('resolves {{dates.next_month_start}} to the first day of the next calendar month', () => {
    const monthEnd = resolveVariables('{{dates.month_end}}', {}, userCtx) as string;
    const nextStart = resolveVariables('{{dates.next_month_start}}', {}, userCtx) as string;
    expect(nextStart).toMatch(/^\d{4}-\d{2}-01$/);
    expect(nextStart > monthEnd).toBe(true);
  });

  test('resolves {{dates.now}} to ISO datetime string with time component', () => {
    const now = resolveVariables('{{dates.now}}', {}, userCtx) as string;
    expect(now).toContain('T');
  });

  // --- EventSummary fields via step results ---

  test('resolves expanded last_added_event fields from stepResults', () => {
    const stepResults = {
      last_added_event: {
        id: 42,
        title: 'Team standup',
        date: '2026-03-20',
        time: '10:00',
        all_day: false,
        end_at: '2026-03-20T08:00:00.000Z',
        description: 'Daily sync',
        location: 'Room 3',
        recurrence_rule: 'FREQ=DAILY',
      },
    };
    expect(resolveVariables('{{last_added_event.id}}', {}, userCtx, stepResults)).toBe(42);
    expect(resolveVariables('{{last_added_event.title}}', {}, userCtx, stepResults)).toBe('Team standup');
    expect(resolveVariables('{{last_added_event.all_day}}', {}, userCtx, stepResults)).toBe(false);
    expect(resolveVariables('{{last_added_event.end_at}}', {}, userCtx, stepResults)).toBe('2026-03-20T08:00:00.000Z');
    expect(resolveVariables('{{last_added_event.description}}', {}, userCtx, stepResults)).toBe('Daily sync');
    expect(resolveVariables('{{last_added_event.location}}', {}, userCtx, stepResults)).toBe('Room 3');
    expect(resolveVariables('{{last_added_event.recurrence_rule}}', {}, userCtx, stepResults)).toBe('FREQ=DAILY');
  });

  test('optional EventSummary fields absent when not set', () => {
    const stepResults = {
      last_added_event: {
        id: 7,
        title: 'Day off',
        date: '2026-04-01',
        all_day: true,
      },
    };
    expect(resolveVariables('{{last_added_event.location}}', {}, userCtx, stepResults)).toBe(
      '{{last_added_event.location}}',
    );
    expect(resolveVariables('{{last_added_event.description}}', {}, userCtx, stepResults)).toBe(
      '{{last_added_event.description}}',
    );
  });

  // --- filter pipeline ---

  test('{{$1|pad(2)}} zero-pads single-digit capture', () => {
    expect(resolveVariables('{{$1|pad(2)}}', { $1: '9' }, userCtx)).toBe('09');
  });

  test('{{$1|pad(2)}} leaves 2-digit capture unchanged', () => {
    expect(resolveVariables('{{$1|pad(2)}}', { $1: '23' }, userCtx)).toBe('23');
  });

  test('{{$1|pad(2)}} works inline in ISO datetime string', () => {
    const result = resolveVariables('{{dates.today}}T{{$1|pad(2)}}:00:00Z', { $1: '9' }, userCtx);
    expect(result as string).toMatch(/^\d{4}-\d{2}-\d{2}T09:00:00Z$/);
  });

  test('{{user.first_name|default("гость")}} returns default when name absent', () => {
    const ctx = { timezone: 'UTC', language: 'ru' };
    expect(resolveVariables('{{user.first_name|default("гость")}}', {}, ctx)).toBe('гость');
  });

  test('{{$1|trim|upper}} chains trim and upper', () => {
    expect(resolveVariables('{{$1|trim|upper}}', { $1: '  привет  ' }, userCtx)).toBe('ПРИВЕТ');
  });

  // --- env.scope ---

  test('{{env.scope}} resolves to "group" when groupIsGroup', () => {
    const ctx = { ...userCtx, groupIsGroup: true, groupChatId: -100123 };
    expect(resolveVariables('{{env.scope}}', {}, ctx)).toBe('group');
  });

  test('{{env.scope}} resolves to "personal" in private chat', () => {
    expect(resolveVariables('{{env.scope}}', {}, userCtx)).toBe('personal');
  });

  // --- date() filter ---

  test('{{$1|date("dd.MM")}} reformats ISO date string', () => {
    expect(resolveVariables('{{$1|date("dd.MM")}}', { $1: '2026-03-19' }, userCtx)).toBe('19.03');
  });

  test('{{dates.today|date("dd.MM.yyyy")}} formats today', () => {
    const result = resolveVariables('{{dates.today|date("dd.MM.yyyy")}}', {}, userCtx) as string;
    expect(result).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  // --- ternary() filter ---

  test('{{group.is_group|ternary("group","personal")}} returns "group" when true', () => {
    const ctx = { ...userCtx, groupIsGroup: true };
    expect(resolveVariables('{{group.is_group|ternary("group","personal")}}', {}, ctx)).toBe('group');
  });

  test('{{group.is_group|ternary("group","personal")}} returns "personal" when false', () => {
    expect(resolveVariables('{{group.is_group|ternary("group","personal")}}', {}, userCtx)).toBe('personal');
  });

  // --- Group context variables ---

  test('{{group.is_group}} resolves to true when groupIsGroup is set', () => {
    const ctx = { ...userCtx, groupIsGroup: true, groupChatId: -100123456 };
    expect(resolveVariables('{{group.is_group}}', {}, ctx)).toBe(true);
  });

  test('{{group.is_group}} resolves to false when groupIsGroup is absent', () => {
    expect(resolveVariables('{{group.is_group}}', {}, userCtx)).toBe(false);
  });

  test('{{group.chat_id}} resolves to group chat ID number', () => {
    const ctx = { ...userCtx, groupIsGroup: true, groupChatId: -100999 };
    expect(resolveVariables('{{group.chat_id}}', {}, ctx)).toBe(-100999);
  });

  test('{{group.chat_id}} stays as literal when not in a group', () => {
    expect(resolveVariables('{{group.chat_id}}', {}, userCtx)).toBe('{{group.chat_id}}');
  });

  // --- user.utc_offset ---

  test('{{user.utc_offset}} resolves to +HH:MM format for positive offset', () => {
    const ctx = { timezone: 'Europe/Moscow', language: 'ru' };
    const result = resolveVariables('{{user.utc_offset}}', {}, ctx) as string;
    expect(result).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(result).toBe('+03:00');
  });

  test('{{user.utc_offset}} resolves to -HH:MM for negative offset', () => {
    const ctx = { timezone: 'America/New_York', language: 'en' };
    const result = resolveVariables('{{user.utc_offset}}', {}, ctx) as string;
    expect(result).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  test('{{user.utc_offset}} resolves to +00:00 for UTC', () => {
    const ctx = { timezone: 'UTC', language: 'en' };
    expect(resolveVariables('{{user.utc_offset}}', {}, ctx)).toBe('+00:00');
  });

  test('{{user.utc_offset}} works inline in ISO datetime string', () => {
    const ctx = { timezone: 'Europe/Moscow', language: 'ru' };
    const result = resolveVariables('{{dates.today}}T22:00:00{{user.utc_offset}}', {}, ctx) as string;
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T22:00:00\+03:00$/);
  });

  // --- i18n / t.* namespace ---

  const i18n = {
    ru: { q1: 'Это дата или время?', greeting: 'Привет, {{user.first_name}}!' },
    en: { q1: 'Is this a date or time?', greeting: 'Hello, {{user.first_name}}!' },
  };

  test('{{t.key}} resolves to string for current language', () => {
    const ctx = { timezone: 'UTC', language: 'ru' };
    expect(resolveVariables('{{t.q1}}', {}, ctx, undefined, i18n)).toBe('Это дата или время?');
  });

  test('{{t.key}} resolves to en for English user', () => {
    const ctx = { timezone: 'UTC', language: 'en' };
    expect(resolveVariables('{{t.q1}}', {}, ctx, undefined, i18n)).toBe('Is this a date or time?');
  });

  test('{{t.key}} falls back to en when language not in i18n', () => {
    const ctx = { timezone: 'UTC', language: 'uk' };
    expect(resolveVariables('{{t.q1}}', {}, ctx, undefined, i18n)).toBe('Is this a date or time?');
  });

  test('{{t.key}} resolves nested {{}} in i18n value lazily', () => {
    const ctx = { timezone: 'UTC', language: 'ru', firstName: 'Alex' };
    expect(resolveVariables('{{t.greeting}}', {}, ctx, undefined, i18n)).toBe('Привет, Alex!');
  });

  test('{{t.key}} works inline with surrounding text', () => {
    const ctx = { timezone: 'UTC', language: 'en' };
    expect(resolveVariables('Question: {{t.q1}}', {}, ctx, undefined, i18n)).toBe('Question: Is this a date or time?');
  });

  test('{{t.key}} with $1 capture inside i18n string', () => {
    const i18nCapture = {
      ru: { q: '«{{$1}}» — дата или время?' },
      en: { q: 'Is «{{$1}}» a date or time?' },
    };
    const ctx = { timezone: 'UTC', language: 'ru' };
    expect(resolveVariables('{{t.q}}', { $1: '22' }, ctx, undefined, i18nCapture)).toBe('«22» — дата или время?');
  });

  test('{{t.unknown}} returns template literal unchanged', () => {
    const ctx = { timezone: 'UTC', language: 'ru' };
    expect(resolveVariables('{{t.missing}}', {}, ctx, undefined, i18n)).toBe('{{t.missing}}');
  });

  test('{{t.key}} without i18n returns template literal', () => {
    const ctx = { timezone: 'UTC', language: 'ru' };
    expect(resolveVariables('{{t.q1}}', {}, ctx)).toBe('{{t.q1}}');
  });
});
