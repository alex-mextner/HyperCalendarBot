import { describe, expect, test } from 'bun:test';
import { eventCardTemplate } from '../../../src/worker/templates/event-card.ts';
import { THEME_LIGHT } from '../../../src/worker/templates/themes.ts';
import type { EventCardData } from '../../../src/worker/templates/types.ts';

function makeCardData(overrides: Partial<EventCardData> = {}): EventCardData {
  return {
    title: 'Design Review',
    dateFormatted: 'Tuesday, March 11, 2026',
    timeFormatted: '11:00 – 12:00',
    duration: '1h',
    calendarName: 'Work Calendar',
    calendarColor: '#6366F1',
    isAllDay: false,
    theme: THEME_LIGHT,
    locale: 'en',
    ...overrides,
  };
}

describe('eventCardTemplate', () => {
  test('renders valid HTML with title', () => {
    const html = eventCardTemplate.render(makeCardData());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Design Review');
  });

  test('renders date, time, duration', () => {
    const html = eventCardTemplate.render(makeCardData());
    expect(html).toContain('Tuesday, March 11, 2026');
    expect(html).toContain('11:00');
    expect(html).toContain('1h');
  });

  test('renders location when present', () => {
    const html = eventCardTemplate.render(makeCardData({ location: 'Room 42' }));
    expect(html).toContain('Room 42');
  });

  test('omits location when absent', () => {
    const html = eventCardTemplate.render(makeCardData());
    expect(html).not.toContain('location');
  });

  test('renders description', () => {
    const html = eventCardTemplate.render(makeCardData({ description: 'Review proposals' }));
    expect(html).toContain('Review proposals');
  });

  test('renders attendees + overflow', () => {
    const html = eventCardTemplate.render(
      makeCardData({
        attendees: ['Alex', 'Maria', 'Ivan'],
        attendeeOverflow: 3,
      }),
    );
    expect(html).toContain('Alex');
    expect(html).toContain('+3');
  });

  test('renders conference link', () => {
    const html = eventCardTemplate.render(makeCardData({ conferenceLink: 'meet.google.com/abc' }));
    expect(html).toContain('meet.google.com/abc');
  });

  test('renders calendar color as left border', () => {
    const html = eventCardTemplate.render(makeCardData());
    expect(html).toContain('#6366F1');
    expect(html).toContain('Work Calendar');
  });

  test('escapes HTML in all user content', () => {
    const html = eventCardTemplate.render(makeCardData({ title: '<b>XSS</b>' }));
    expect(html).not.toContain('<b>XSS</b>');
    expect(html).toContain('&lt;b&gt;');
  });
});
