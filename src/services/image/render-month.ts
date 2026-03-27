import { TZDate } from '@date-fns/tz';
import type { EventOccurrence } from '../../database/types.ts';
import { getTheme } from '../../worker/templates/themes.ts';
import { mapMonthlyCalendarData } from './data-mapper.ts';
import type { ImageRenderer } from './render-service.ts';

export async function renderMonthImage(
  renderService: ImageRenderer,
  occurrences: EventOccurrence[],
  year: number,
  month: number, // 0-based
  timezone: string,
  locale: 'ru' | 'en',
  userId: number,
): Promise<Buffer> {
  const occurrencesByDay = new Map<string, EventOccurrence[]>();
  for (const occ of occurrences) {
    const dayKey = new TZDate(new Date(occ.occurrence_start), timezone).toISOString().slice(0, 10);
    const list = occurrencesByDay.get(dayKey) ?? [];
    list.push(occ);
    occurrencesByDay.set(dayKey, list);
  }

  const userNow = new TZDate(new Date(), timezone);
  const todayIso = userNow.toISOString().slice(0, 10);

  const data = mapMonthlyCalendarData({
    occurrencesByDay,
    year,
    month,
    timezone,
    locale,
    theme: getTheme(),
    todayIso,
  });

  return renderService.renderDirect({
    type: 'monthly-calendar',
    data,
    userId,
  });
}
