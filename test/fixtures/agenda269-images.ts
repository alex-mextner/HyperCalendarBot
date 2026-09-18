// Exercise the production mappers and templates with synthetic events only.
import {
  mapDailyAgendaData,
  mapEventCardData,
  mapMonthlyCalendarData,
  mapWeeklyOverviewData,
} from '../../src/services/image/data-mapper.ts';
import { dailyAgendaTemplate } from '../../src/worker/templates/daily-agenda.ts';
import { eventCardTemplate } from '../../src/worker/templates/event-card.ts';
import { monthlyCalendarTemplate } from '../../src/worker/templates/monthly-calendar.ts';
import { THEME_LIGHT } from '../../src/worker/templates/themes.ts';
import { weeklyOverviewTemplate } from '../../src/worker/templates/weekly-overview.ts';
import { agendaOccurrences } from './agenda269.ts';

export function agendaImages() {
  const occurrences = agendaOccurrences();
  const common = { timezone: 'UTC', locale: 'en' as const, theme: THEME_LIGHT };
  const occurrencesByDay = new Map([['2026-03-11', occurrences]]);
  const day = mapDailyAgendaData({ ...common, occurrences, dateIso: '2026-03-11' });
  const week = mapWeeklyOverviewData({ ...common, occurrencesByDay, weekStartIso: '2026-03-09' });
  const month = mapMonthlyCalendarData({ ...common, occurrencesByDay, year: 2026, month: 2 });
  const card = mapEventCardData({ ...common, occurrence: occurrences[7]! });
  return [
    { name: 'day', html: dailyAgendaTemplate.render(day), data: day },
    { name: 'week', html: weeklyOverviewTemplate.render(week), data: week },
    { name: 'month', html: monthlyCalendarTemplate.render(month), data: month },
    { name: 'event-card', html: eventCardTemplate.render(card), data: card },
  ];
}
