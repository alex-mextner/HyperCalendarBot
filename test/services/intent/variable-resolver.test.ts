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

  test('resolves {{today}} to YYYY-MM-DD in user timezone', () => {
    const result = resolveVariables('{{today}}', {}, userCtx);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('resolves {{tomorrow}}', () => {
    const today = resolveVariables('{{today}}', {}, userCtx) as string;
    const tomorrow = resolveVariables('{{tomorrow}}', {}, userCtx) as string;
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
    const input = { start_date: '{{today}}', nested: { end_date: '{{tomorrow}}' } };
    const result = resolveVariables(input, {}, userCtx) as Record<string, unknown>;
    expect(result.start_date as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((result.nested as Record<string, unknown>).end_date as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('mixed text with variables', () => {
    const result = resolveVariables('Events for {{$1}}', { $1: 'tomorrow' }, userCtx);
    expect(result).toBe('Events for tomorrow');
  });

  test('resolves arrays', () => {
    const input = ['{{today}}', '{{tomorrow}}'];
    const result = resolveVariables(input, {}, userCtx) as string[];
    expect(result[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('passes through non-template values', () => {
    expect(resolveVariables(42, {}, userCtx)).toBe(42);
    expect(resolveVariables(true, {}, userCtx)).toBe(true);
    expect(resolveVariables(null, {}, userCtx)).toBeNull();
  });

  test('resolves {{week_start}} and {{week_end}}', () => {
    const weekStart = resolveVariables('{{week_start}}', {}, userCtx) as string;
    const weekEnd = resolveVariables('{{week_end}}', {}, userCtx) as string;
    expect(weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(weekEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(weekEnd >= weekStart).toBe(true);
  });

  test('resolves {{month_start}} and {{month_end}}', () => {
    const monthStart = resolveVariables('{{month_start}}', {}, userCtx) as string;
    const monthEnd = resolveVariables('{{month_end}}', {}, userCtx) as string;
    expect(monthStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(monthEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(monthEnd >= monthStart).toBe(true);
  });

  test('resolves {{user.language}}', () => {
    expect(resolveVariables('{{user.language}}', {}, userCtx)).toBe('ru');
  });

  // --- New user variables ---

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
    // no username — should stay as literal
    expect(resolveVariables('{{user.username}}', {}, ctx)).toBe('{{user.username}}');
  });

  // --- New date variables ---

  test('resolves {{yesterday}} to date before today', () => {
    const today = resolveVariables('{{today}}', {}, userCtx) as string;
    const yesterday = resolveVariables('{{yesterday}}', {}, userCtx) as string;
    expect(yesterday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(yesterday < today).toBe(true);
  });

  test('resolves {{next_week_start}} and {{next_week_end}} after this week', () => {
    const weekEnd = resolveVariables('{{week_end}}', {}, userCtx) as string;
    const nextStart = resolveVariables('{{next_week_start}}', {}, userCtx) as string;
    const nextEnd = resolveVariables('{{next_week_end}}', {}, userCtx) as string;
    expect(nextStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nextEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(nextStart > weekEnd).toBe(true);
    expect(nextEnd >= nextStart).toBe(true);
  });

  test('resolves {{now}} to ISO datetime string with time component', () => {
    const now = resolveVariables('{{now}}', {}, userCtx) as string;
    // e.g. "2026-03-19T14:32:00+03:00" — must contain T
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
    // absent optional fields stay as literal template
    expect(resolveVariables('{{last_added_event.location}}', {}, userCtx, stepResults)).toBe(
      '{{last_added_event.location}}',
    );
    expect(resolveVariables('{{last_added_event.description}}', {}, userCtx, stepResults)).toBe(
      '{{last_added_event.description}}',
    );
  });
});
