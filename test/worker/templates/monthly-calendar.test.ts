import { describe, expect, test } from 'bun:test';
import { monthlyCalendarTemplate } from '../../../src/worker/templates/monthly-calendar.ts';
import { THEME_LIGHT } from '../../../src/worker/templates/themes.ts';
import type { MonthDay, MonthlyCalendarData } from '../../../src/worker/templates/types.ts';

function makeDay(overrides: Partial<MonthDay> = {}): MonthDay {
  return {
    dayNumber: 1,
    isOtherMonth: false,
    isWeekend: false,
    isToday: false,
    eventCount: 0,
    events: [],
    ...overrides,
  };
}

function makeMonthData(overrides: Partial<MonthlyCalendarData> = {}): MonthlyCalendarData {
  const week = Array.from({ length: 7 }, (_, i) => makeDay({ dayNumber: i + 1 }));
  return {
    monthLabel: 'March 2026',
    weekDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    weeks: [week],
    theme: THEME_LIGHT,
    locale: 'en',
    ...overrides,
  };
}

describe('monthlyCalendarTemplate', () => {
  test('renders valid HTML with month label', () => {
    const html = monthlyCalendarTemplate.render(makeMonthData());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('March 2026');
  });

  test('renders day-of-week headers', () => {
    const html = monthlyCalendarTemplate.render(makeMonthData());
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      expect(html).toContain(d);
    }
  });

  test('highlights today', () => {
    const week = Array.from({ length: 7 }, (_, i) => makeDay({ dayNumber: i + 1, isToday: i === 2 }));
    const html = monthlyCalendarTemplate.render(makeMonthData({ weeks: [week] }));
    expect(html).toContain('cell__num--today');
  });

  test('renders event in ev-dot with ev-inner wrapper', () => {
    const week = [
      makeDay({
        dayNumber: 1,
        eventCount: 1,
        events: [{ title: 'Standup', startMinutes: 540, endMinutes: 570, color: '#6366F1', isAllDay: false }],
      }),
      ...Array.from({ length: 6 }, (_, i) => makeDay({ dayNumber: i + 2 })),
    ];
    const html = monthlyCalendarTemplate.render(makeMonthData({ weeks: [week] }));
    expect(html).toContain('ev-dot');
    expect(html).toContain('ev-inner');
    expect(html).toContain('Standup');
  });

  test('renders event time badge', () => {
    const week = [
      makeDay({
        dayNumber: 1,
        eventCount: 1,
        events: [{ title: 'Meeting', startMinutes: 540, endMinutes: 600, color: '#6366F1', isAllDay: false }],
      }),
      ...Array.from({ length: 6 }, (_, i) => makeDay({ dayNumber: i + 2 })),
    ];
    const html = monthlyCalendarTemplate.render(makeMonthData({ weeks: [week] }));
    expect(html).toContain('09:00');
    expect(html).toContain('ev-time');
  });

  test('omits time badge for all-day events', () => {
    const week = [
      makeDay({
        dayNumber: 1,
        eventCount: 1,
        events: [{ title: 'Birthday', startMinutes: 0, endMinutes: 0, color: '#F59E0B', isAllDay: true }],
      }),
      ...Array.from({ length: 6 }, (_, i) => makeDay({ dayNumber: i + 2 })),
    ];
    const html = monthlyCalendarTemplate.render(makeMonthData({ weeks: [week] }));
    expect(html).toContain('Birthday');
    expect(html).not.toContain('<span class="ev-time">');
  });

  test('shows overflow indicator when events exceed 3', () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      title: `Event ${i}`,
      startMinutes: 540 + i * 60,
      endMinutes: 600 + i * 60,
      color: '#6366F1',
      isAllDay: false,
    }));
    const week = [
      makeDay({ dayNumber: 1, eventCount: 5, events: events.slice(0, 3) }),
      ...Array.from({ length: 6 }, (_, i) => makeDay({ dayNumber: i + 2 })),
    ];
    const html = monthlyCalendarTemplate.render(makeMonthData({ weeks: [week] }));
    expect(html).toContain('ev-overflow');
    expect(html).toContain('+2');
  });

  test('renders footer', () => {
    const html = monthlyCalendarTemplate.render(makeMonthData());
    expect(html).toContain('HyperCalendar');
  });
});
