import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '../../../src/database/types.ts';
import {
  computeEventDiff,
  type EventFieldSnapshot,
  formatChanges,
  getPersonalChanges,
  getSharedChanges,
  hasTimeChange,
  snapshotFromCalendarEvent,
  snapshotFromGoogleLocal,
} from '../../../src/services/google/change-detection.ts';

function makeSnapshot(overrides: Partial<EventFieldSnapshot> = {}): EventFieldSnapshot {
  return {
    title: 'Standup',
    description: null,
    start_at: '2026-04-21T10:00:00Z',
    end_at: '2026-04-21T11:00:00Z',
    all_day: false,
    timezone: 'Europe/Moscow',
    location: null,
    recurrence_rule: null,
    ...overrides,
  };
}

describe('computeEventDiff', () => {
  test('no changes → empty array', () => {
    const a = makeSnapshot();
    const b = makeSnapshot();
    expect(computeEventDiff(a, b)).toEqual([]);
  });

  test('title change', () => {
    const a = makeSnapshot({ title: 'Standup' });
    const b = makeSnapshot({ title: 'Daily sync' });
    const changes = computeEventDiff(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe('title');
    expect(changes[0]!.oldValue).toBe('Standup');
    expect(changes[0]!.newValue).toBe('Daily sync');
  });

  test('description change', () => {
    const a = makeSnapshot({ description: 'Old desc' });
    const b = makeSnapshot({ description: 'New desc' });
    const changes = computeEventDiff(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe('description');
  });

  test('start_at change', () => {
    const a = makeSnapshot({ start_at: '2026-04-21T10:00:00Z' });
    const b = makeSnapshot({ start_at: '2026-04-21T11:00:00Z' });
    const changes = computeEventDiff(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe('start_at');
  });

  test('end_at change', () => {
    const a = makeSnapshot({ end_at: '2026-04-21T11:00:00Z' });
    const b = makeSnapshot({ end_at: '2026-04-21T12:00:00Z' });
    const changes = computeEventDiff(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe('end_at');
  });

  test('all_day change', () => {
    const a = makeSnapshot({ all_day: false });
    const b = makeSnapshot({ all_day: true });
    const changes = computeEventDiff(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe('all_day');
    expect(changes[0]!.oldValue).toBe(false);
    expect(changes[0]!.newValue).toBe(true);
  });

  test('location change', () => {
    const a = makeSnapshot({ location: 'Zoom' });
    const b = makeSnapshot({ location: 'Google Meet' });
    const changes = computeEventDiff(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe('location');
  });

  test('recurrence_rule change', () => {
    const a = makeSnapshot({ recurrence_rule: null });
    const b = makeSnapshot({ recurrence_rule: 'RRULE:FREQ=WEEKLY' });
    const changes = computeEventDiff(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe('recurrence_rule');
  });

  test('timezone change (personal)', () => {
    const a = makeSnapshot({ timezone: 'Europe/Moscow' });
    const b = makeSnapshot({ timezone: 'US/Pacific' });
    const changes = computeEventDiff(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe('timezone');
  });

  test('multiple fields changed', () => {
    const a = makeSnapshot({ title: 'Old', location: 'Zoom', start_at: '2026-04-21T10:00:00Z' });
    const b = makeSnapshot({ title: 'New', location: 'Meet', start_at: '2026-04-21T11:00:00Z' });
    const changes = computeEventDiff(a, b);
    expect(changes).toHaveLength(3);
    const fields = changes.map((c) => c.field);
    expect(fields).toContain('title');
    expect(fields).toContain('location');
    expect(fields).toContain('start_at');
  });

  test('null vs empty string treated as equal for description', () => {
    const a = makeSnapshot({ description: null });
    const b = makeSnapshot({ description: '' });
    expect(computeEventDiff(a, b)).toEqual([]);
  });

  test('null vs empty string treated as equal for location', () => {
    const a = makeSnapshot({ location: null });
    const b = makeSnapshot({ location: '' });
    expect(computeEventDiff(a, b)).toEqual([]);
  });

  test('whitespace-only string treated as null', () => {
    const a = makeSnapshot({ description: null });
    const b = makeSnapshot({ description: '   ' });
    expect(computeEventDiff(a, b)).toEqual([]);
  });

  test('trailing whitespace trimmed before comparison', () => {
    const a = makeSnapshot({ title: 'Standup' });
    const b = makeSnapshot({ title: 'Standup  ' });
    expect(computeEventDiff(a, b)).toEqual([]);
  });
});

describe('snapshotFromCalendarEvent', () => {
  test('normalizes all_day from number to boolean', () => {
    const event = {
      all_day: 1,
      title: 'T',
      description: null,
      start_at: '',
      end_at: null,
      timezone: 'UTC',
      location: null,
      recurrence_rule: null,
    } as CalendarEvent;
    const snap = snapshotFromCalendarEvent(event);
    expect(snap.all_day).toBe(true);
  });

  test('all_day 0 → false', () => {
    const event = {
      all_day: 0,
      title: 'T',
      description: null,
      start_at: '',
      end_at: null,
      timezone: 'UTC',
      location: null,
      recurrence_rule: null,
    } as CalendarEvent;
    const snap = snapshotFromCalendarEvent(event);
    expect(snap.all_day).toBe(false);
  });
});

describe('snapshotFromGoogleLocal', () => {
  test('preserves boolean all_day', () => {
    const local = {
      title: 'T',
      description: null,
      start_at: '',
      end_at: null,
      all_day: true,
      timezone: 'UTC',
      location: null,
      recurrence_rule: null,
    };
    const snap = snapshotFromGoogleLocal(local);
    expect(snap.all_day).toBe(true);
  });
});

describe('getSharedChanges / getPersonalChanges', () => {
  test('getSharedChanges filters out timezone', () => {
    const changes = computeEventDiff(
      makeSnapshot({ title: 'A', timezone: 'UTC' }),
      makeSnapshot({ title: 'B', timezone: 'US/Pacific' }),
    );
    expect(changes).toHaveLength(2);
    const shared = getSharedChanges(changes);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.field).toBe('title');
  });

  test('getPersonalChanges returns only timezone', () => {
    const changes = computeEventDiff(
      makeSnapshot({ title: 'A', timezone: 'UTC' }),
      makeSnapshot({ title: 'B', timezone: 'US/Pacific' }),
    );
    const personal = getPersonalChanges(changes);
    expect(personal).toHaveLength(1);
    expect(personal[0]!.field).toBe('timezone');
  });
});

describe('hasTimeChange', () => {
  test('true for start_at change', () => {
    const changes = computeEventDiff(
      makeSnapshot({ start_at: '2026-04-21T10:00:00Z' }),
      makeSnapshot({ start_at: '2026-04-21T11:00:00Z' }),
    );
    expect(hasTimeChange(changes)).toBe(true);
  });

  test('true for all_day change', () => {
    const changes = computeEventDiff(makeSnapshot({ all_day: false }), makeSnapshot({ all_day: true }));
    expect(hasTimeChange(changes)).toBe(true);
  });

  test('false for title-only change', () => {
    const changes = computeEventDiff(makeSnapshot({ title: 'A' }), makeSnapshot({ title: 'B' }));
    expect(hasTimeChange(changes)).toBe(false);
  });
});

describe('formatChanges', () => {
  test('single time change', () => {
    const changes = computeEventDiff(makeSnapshot({ start_at: '10:00' }), makeSnapshot({ start_at: '11:00' }));
    const result = formatChanges(changes, 'ru');
    expect(result).toBe('• 10:00 → 11:00');
  });

  test('single title change (en)', () => {
    const changes = computeEventDiff(makeSnapshot({ title: 'Standup' }), makeSnapshot({ title: 'Daily' }));
    const result = formatChanges(changes, 'en');
    expect(result).toBe('• Standup → Daily');
  });

  test('multiple changes ordered: time first, then location, then title', () => {
    const changes = computeEventDiff(
      makeSnapshot({ title: 'Old', location: 'Zoom', start_at: '10:00' }),
      makeSnapshot({ title: 'New', location: 'Meet', start_at: '11:00' }),
    );
    const result = formatChanges(changes, 'ru');
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('10:00 → 11:00');
    expect(lines[1]).toContain('Zoom → Meet');
    expect(lines[2]).toContain('Old → New');
  });

  test('description change shows generic message', () => {
    const changes = computeEventDiff(makeSnapshot({ description: 'old' }), makeSnapshot({ description: 'new' }));
    expect(formatChanges(changes, 'ru')).toBe('• Описание обновлено');
    expect(formatChanges(changes, 'en')).toBe('• Description updated');
  });

  test('all_day change', () => {
    const changes = computeEventDiff(makeSnapshot({ all_day: false }), makeSnapshot({ all_day: true }));
    expect(formatChanges(changes, 'ru')).toBe('• Теперь на весь день');
  });

  test('timezone-only changes produce empty string', () => {
    const changes = computeEventDiff(makeSnapshot({ timezone: 'UTC' }), makeSnapshot({ timezone: 'US/Pacific' }));
    expect(formatChanges(changes, 'ru')).toBe('');
  });

  test('end_at is skipped when start_at also changed', () => {
    const changes = computeEventDiff(
      makeSnapshot({ start_at: '10:00', end_at: '11:00' }),
      makeSnapshot({ start_at: '12:00', end_at: '13:00' }),
    );
    const result = formatChanges(changes, 'ru');
    const lines = result.split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('10:00 → 12:00');
  });
});
