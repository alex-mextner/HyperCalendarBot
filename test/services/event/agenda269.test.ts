// Issue269 contracts for text and image presentation using synthetic view data.
import { expect, test } from 'bun:test';
import {
  formatDayAgenda,
  formatEventDetail,
  formatEventListItem,
  formatWeekAgenda,
} from '../../../src/services/event/formatters.ts';
import {
  mapDailyAgendaData,
  mapEventCardData,
  mapMonthlyCalendarData,
  mapWeeklyOverviewData,
} from '../../../src/services/image/data-mapper.ts';
import { escapeHtml } from '../../../src/utils/telegram.ts';
import { dailyAgendaTemplate } from '../../../src/worker/templates/daily-agenda.ts';
import { eventCardTemplate } from '../../../src/worker/templates/event-card.ts';
import { monthlyCalendarTemplate } from '../../../src/worker/templates/monthly-calendar.ts';
import { THEME_LIGHT } from '../../../src/worker/templates/themes.ts';
import { weeklyOverviewTemplate } from '../../../src/worker/templates/weekly-overview.ts';
import { agendaEvent, agendaOccurrences } from '../../fixtures/agenda269.ts';
import { agendaImages } from '../../fixtures/agenda269-images.ts';

for (const lang of ['en', 'ru']) {
  const occurrences = agendaOccurrences();
  const event = occurrences[0]!.event;
  for (const [name, render] of Object.entries({
    day: () => formatDayAgenda(occurrences, '2026-03-11', 'UTC', lang),
    week: () => formatWeekAgenda(occurrences, '2026-03-09', '2026-03-15', 'UTC', lang),
    detail: () => formatEventDetail(event, 'UTC', lang),
    search: () => formatEventListItem(event, 'UTC', 0, lang),
  })) {
    test(`${lang} ${name} includes escaped location, description and supplied status`, () => {
      const html = render();
      expect(html).toContain(escapeHtml(event.location!));
      expect(html).toContain(escapeHtml(event.description!));
      expect(html).toContain(escapeHtml(event.displayMetadata!.invitationStatus!));
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<guest>');
    });
  }
}

test('missing optional text fields produce no labels or placeholders', () => {
  const event = agendaEvent();
  for (const html of [formatEventDetail(event, 'UTC', 'en'), formatEventListItem(event, 'UTC', 0)]) {
    expect(html).not.toMatch(/📍|📝|✉|undefined|null/);
  }
});

for (const name of ['day', 'week', 'month', 'event-card']) {
  test(`${name} image includes full location/status but never description in HTML or view data`, () => {
    const image = agendaImages().find((image) => image.name === name)!;
    expect(image.html).toContain(escapeHtml('LongLocation'.repeat(35)));
    expect(image.html).toContain('Accepted: Alex &amp; Sam; Pending: Jo &lt;guest&gt;');
    expect(image.html).not.toContain('DESCRIPTION_ONLY_TEXT');
    expect(JSON.stringify(image.data)).not.toContain('DESCRIPTION_ONLY_TEXT');
    expect(image.html).not.toContain('<guest>');
  });
}

test('empty and whitespace metadata stays quiet in every image', () => {
  const event = agendaEvent({ location: ' ', description: 'TEXT_ONLY', displayMetadata: { invitationStatus: '  ' } });
  const occurrence = { event, occurrence_start: event.start_at, occurrence_end: event.end_at, is_exception: false };
  const common = { timezone: 'UTC', locale: 'en' as const, theme: THEME_LIGHT };
  const occurrencesByDay = new Map([['2026-03-11', [occurrence]]]);
  const images = [
    dailyAgendaTemplate.render(mapDailyAgendaData({ ...common, occurrences: [occurrence], dateIso: '2026-03-11' })),
    weeklyOverviewTemplate.render(mapWeeklyOverviewData({ ...common, occurrencesByDay, weekStartIso: '2026-03-09' })),
    monthlyCalendarTemplate.render(mapMonthlyCalendarData({ ...common, occurrencesByDay, year: 2026, month: 2 })),
    eventCardTemplate.render(mapEventCardData({ ...common, occurrence })),
  ];
  for (const html of images) {
    expect(html).not.toContain('<section class="agenda-details">');
    expect(html).not.toContain('✉️');
    expect(html).not.toContain('TEXT_ONLY');
    expect(html).not.toMatch(/undefined|null/);
  }
});

test('status can be displayed without a location or description', () => {
  const event = agendaEvent({ displayMetadata: { invitationStatus: 'Ожидает ответа <гость>' } });
  expect(formatEventDetail(event, 'UTC', 'ru')).toContain('✉️ Ожидает ответа &lt;гость&gt;');
  expect(formatEventListItem(event, 'UTC', 0, 'ru')).not.toMatch(/📍|📝/);
  const card = mapEventCardData({
    occurrence: { event, occurrence_start: event.start_at, occurrence_end: event.end_at, is_exception: false },
    timezone: 'UTC',
    locale: 'ru',
    theme: THEME_LIGHT,
  });
  expect(eventCardTemplate.render(card)).toContain('Ожидает ответа &lt;гость&gt;');
});

for (const timezone of ['Pacific/Kiritimati', 'Etc/GMT+12', 'America/Los_Angeles']) {
  test(`week labels retain local calendar dates in ${timezone}`, async () => {
    const { TZDate } = await import('@date-fns/tz');
    const start = new Date(new TZDate(2026, 2, 9, 0, timezone)).toISOString();
    const end = new Date(new TZDate(2026, 2, 15, 23, timezone)).toISOString();
    const text = formatWeekAgenda([], start, end, timezone, 'en');
    expect(text).toContain('Mon 9  ');
    expect(text).toContain('Sun 15  ');
  });
}
