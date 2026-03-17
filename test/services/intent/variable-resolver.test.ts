import { describe, expect, test } from 'bun:test';
import { resolveVariables } from '../../../src/services/intent/variable-resolver.ts';

describe('resolveVariables', () => {
  const userCtx = { timezone: 'Europe/Moscow', language: 'ru' };

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
});
