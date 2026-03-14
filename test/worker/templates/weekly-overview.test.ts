import { describe, expect, test } from 'bun:test';
import { THEME_LIGHT } from '../../../src/worker/templates/themes.ts';
import type { WeeklyOverviewData } from '../../../src/worker/templates/types.ts';
import { weeklyOverviewTemplate } from '../../../src/worker/templates/weekly-overview.ts';

function makeWeekData(overrides: Partial<WeeklyOverviewData> = {}): WeeklyOverviewData {
  return {
    weekLabel: 'March 9–15, 2026',
    days: Array.from({ length: 7 }, (_, i) => ({
      dayNumber: 9 + i,
      dayName: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i],
      eventCount: 0,
      isWeekend: i >= 5,
      events: [],
    })),
    theme: THEME_LIGHT,
    locale: 'en',
    ...overrides,
  };
}

describe('weeklyOverviewTemplate', () => {
  test('renders valid HTML with week label', () => {
    const html = weeklyOverviewTemplate.render(makeWeekData());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('March 9–15, 2026');
  });

  test('renders 7 day names', () => {
    const html = weeklyOverviewTemplate.render(makeWeekData());
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      expect(html).toContain(d);
    }
  });

  test('highlights today', () => {
    const html = weeklyOverviewTemplate.render(makeWeekData({ todayIndex: 2 }));
    expect(html).toContain('today-highlight');
  });

  test('renders event titles in pills', () => {
    const data = makeWeekData();
    data.days[0].events = [{ title: 'Standup', startMinutes: 540, endMinutes: 570, color: '#6366F1', isAllDay: false }];
    data.days[0].eventCount = 1;
    const html = weeklyOverviewTemplate.render(data);
    expect(html).toContain('Standup');
    expect(html).toContain('event-pill');
  });

  test('renders event time and color', () => {
    const data = makeWeekData();
    data.days[0].events = [{ title: 'Meeting', startMinutes: 540, endMinutes: 600, color: '#6366F1', isAllDay: false }];
    data.days[0].eventCount = 1;
    const html = weeklyOverviewTemplate.render(data);
    expect(html).toContain('09:00');
    expect(html).toContain('#6366F1');
  });

  test('renders footer', () => {
    const html = weeklyOverviewTemplate.render(makeWeekData());
    expect(html).toContain('HyperCalendar');
  });
});
