import { expect, test } from 'bun:test';
import { mapWeeklyOverviewData } from '../../../src/services/image/data-mapper.ts';
import { compactText, renderCompactMetadata } from '../../../src/worker/templates/compact-metadata.ts';
import { THEME_DARK, THEME_LIGHT } from '../../../src/worker/templates/themes.ts';
import { weeklyOverviewTemplate } from '../../../src/worker/templates/weekly-overview.ts';
import { agendaEvent } from '../../fixtures/agenda269.ts';
import { agendaImages } from '../../fixtures/agenda269-images.ts';

for (const name of ['day', 'week', 'month']) {
  test(`${name}: no repeated full details below the calendar`, () => {
    const image = agendaImages().find((entry) => entry.name === name)!;
    expect(image.html).not.toContain('agenda-details');
    expect(image.html).not.toContain('LongLocation'.repeat(35));
    expect(image.html).toContain('compact-metadata');
    expect(image.html).toContain('📍');
    expect(image.html).toContain('✉️');
    expect(image.html).toContain('…');
  });
}
for (const [themeName, theme] of [
  ['light', THEME_LIGHT],
  ['dark', THEME_DARK],
] as const) {
  for (const name of ['day', 'week', 'month']) {
    test(`${name} (${themeName} theme): compact metadata renders the same bounded contract`, () => {
      const image = agendaImages(theme).find((entry) => entry.name === name)!;
      expect(image.html).not.toContain('agenda-details');
      expect(image.html).not.toContain('LongLocation'.repeat(35));
      expect(image.html).toContain('compact-metadata');
      expect(image.html).toContain('📍');
      expect(image.html).toContain('✉️');
    });
  }
}

test('short text under the clip limit renders without a spurious ellipsis', () => {
  expect(compactText('short')).toBe('short');
  const html = renderCompactMetadata({ location: 'Short place', descriptionPreview: '', displayMetadata: {} });
  expect(html).toContain('Short place');
  expect(html).not.toContain('Short place…');
});

test('an event with no location, description or invitation status renders no compact metadata', () => {
  const event = agendaEvent({ title: 'Bare meeting', location: null, description: null, displayMetadata: undefined });
  const occurrence = { event, occurrence_start: event.start_at, occurrence_end: event.end_at, is_exception: false };
  const data = mapWeeklyOverviewData({
    occurrencesByDay: new Map([['2026-03-11', [occurrence]]]),
    weekStartIso: '2026-03-09',
    timezone: 'UTC',
    locale: 'en',
    theme: THEME_LIGHT,
  });
  const html = weeklyOverviewTemplate.render(data);
  expect(html).toContain('Bare meeting');
  expect(html).not.toContain('class="compact-metadata');
  expect(html).not.toContain('📍');
  expect(html).not.toContain('✉️');
  expect(html).not.toContain('📝');
});
for (const length of [50, 500, 4000]) {
  test(`notes stay inside cells and are bounded (${length} characters)`, () => {
    const event = agendaEvent({ title: 'Meeting', description: '🧑🏽‍💻'.repeat(length), location: '<b>Office</b>' });
    const occurrence = { event, occurrence_start: event.start_at, occurrence_end: event.end_at, is_exception: false };
    const data = mapWeeklyOverviewData({
      occurrencesByDay: new Map([['2026-03-11', [occurrence]]]),
      weekStartIso: '2026-03-09',
      timezone: 'UTC',
      locale: 'en',
      theme: THEME_LIGHT,
    });
    const html = weeklyOverviewTemplate.render(data);
    expect(html).toContain('📝');
    expect(html).toContain('&lt;b&gt;Office&lt;/b&gt;');
    expect(html).not.toContain(event.description!);
    expect(html).not.toContain('<b>Office</b>');
  });
}

test('grapheme clipping preserves joined emoji and has a literal ellipsis', () => {
  expect(compactText('🧑🏽‍💻🧑🏽‍💻🧑🏽‍💻', 2)).toBe('🧑🏽‍💻🧑🏽‍💻…');
  expect(compactText('a\n  b')).toBe('a b');
  expect(compactText('  ')).toBe('');
});
test('empty metadata never leaves placeholder icons', () => {
  expect(
    renderCompactMetadata({ location: '  ', descriptionPreview: '', displayMetadata: { invitationStatus: '' } }),
  ).toBe('');
});
test('icon-only compact cells contain no hidden full-text copy', () => {
  const html = renderCompactMetadata(
    { location: 'Private address', descriptionPreview: 'Note', displayMetadata: { invitationStatus: 'Pending' } },
    true,
  );
  expect(html).toContain('📍');
  expect(html).toContain('✉️');
  expect(html).toContain('📝');
  expect(html).not.toContain('Private address');
});

test('a compact overlap summary counts all hidden events, not just the last one', () => {
  const day = agendaImages().find((entry) => entry.name === 'day')!;
  expect(day.html).toContain('+4 more');
  expect(day.html).not.toContain('+1 more');
});
