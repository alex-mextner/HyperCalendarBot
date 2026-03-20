import { conflictScheduleTemplate } from './conflict-schedule.ts';
import { dailyAgendaTemplate } from './daily-agenda.ts';
import { eventCardTemplate } from './event-card.ts';
import { mdTableTemplate } from './md-table.ts';
import { monthlyCalendarTemplate } from './monthly-calendar.ts';
import type { ImageType, TemplateRenderer } from './types.ts';
import { weeklyOverviewTemplate } from './weekly-overview.ts';

const templates: Record<ImageType, TemplateRenderer<unknown>> = {
  'daily-agenda': dailyAgendaTemplate,
  'weekly-overview': weeklyOverviewTemplate,
  'event-card': eventCardTemplate,
  'monthly-calendar': monthlyCalendarTemplate,
  'conflict-schedule': conflictScheduleTemplate,
  'md-table': mdTableTemplate,
};

export function getTemplate<T>(type: ImageType): TemplateRenderer<T> {
  const template = templates[type];
  if (!template) throw new Error(`Unknown template: ${type}`);
  return template as TemplateRenderer<T>;
}
