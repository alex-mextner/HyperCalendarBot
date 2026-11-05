import { TZDate } from '@date-fns/tz';
import type { EventOccurrence } from '../../database/types.ts';
import type { ImageRenderJob } from '../../worker/image-render.queue.ts';
import { getTheme } from '../../worker/templates/themes.ts';
import type { DayWeather } from '../weather/types.ts';
import { mapWeeklyOverviewData } from './data-mapper.ts';

/** The render job for the picture, built from the agenda alone (no worker involved). */
export function weekImageJob(
  occurrences: EventOccurrence[],
  weekStartIso: string,
  timezone: string,
  locale: 'ru' | 'en',
  userId: number,
  weatherByDate?: { [date: string]: DayWeather },
): ImageRenderJob {
  const startD = new Date(`${weekStartIso}T12:00:00Z`);
  const occurrencesByDay = new Map<string, EventOccurrence[]>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(startD.getTime() + i * 86400000);
    const dayKey = d.toISOString().slice(0, 10);
    occurrencesByDay.set(dayKey, []);
  }
  for (const occ of occurrences) {
    const occDate = new TZDate(new Date(occ.occurrence_start), timezone).toISOString().slice(0, 10);
    const dayList = occurrencesByDay.get(occDate);
    if (dayList) {
      dayList.push(occ);
    }
  }

  const userNow = new TZDate(new Date(), timezone);
  const todayIso = userNow.toISOString().slice(0, 10);

  const data = mapWeeklyOverviewData({
    occurrencesByDay,
    weekStartIso,
    timezone,
    locale,
    theme: getTheme(),
    todayIso,
    weatherByDate,
  });

  return { type: 'weekly-overview', data, userId };
}
