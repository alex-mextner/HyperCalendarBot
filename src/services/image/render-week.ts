import { TZDate } from '@date-fns/tz';
import type { EventOccurrence } from '../../database/types.ts';
import { getTheme } from '../../worker/templates/themes.ts';
import { mapWeeklyOverviewData } from './data-mapper.ts';
import type { RenderService } from './render-service.ts';

export async function renderWeekImage(
  renderService: RenderService,
  occurrences: EventOccurrence[],
  weekStartIso: string,
  timezone: string,
  locale: 'ru' | 'en',
  userId: number,
): Promise<Buffer> {
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
  });

  return renderService.renderDirect({
    type: 'weekly-overview',
    data,
    userId,
  });
}
