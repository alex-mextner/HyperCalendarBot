import { TZDate } from '@date-fns/tz';
import type { EventOccurrence } from '../../database/types.ts';
import { getTheme } from '../../worker/templates/themes.ts';
import type { HolidayEntry } from '../holiday/holiday-service.ts';
import { mapDailyAgendaData } from './data-mapper.ts';
import type { ImageRenderer } from './render-service.ts';

export async function renderDayImage(
  renderService: ImageRenderer,
  occurrences: EventOccurrence[],
  dateIso: string,
  timezone: string,
  locale: 'ru' | 'en',
  userId: number,
  holidays?: HolidayEntry[],
): Promise<Buffer> {
  const userNow = new TZDate(new Date(), timezone);
  const todayIso = userNow.toISOString().slice(0, 10);
  const isToday = dateIso === todayIso;
  const currentTimeMinutes = isToday ? userNow.getHours() * 60 + userNow.getMinutes() : undefined;

  const data = mapDailyAgendaData({
    occurrences,
    dateIso,
    timezone,
    locale,
    theme: getTheme(),
    currentTimeMinutes,
    isHoliday: (holidays ?? []).length > 0,
    holidayName: holidays?.[0]?.name,
  });

  return renderService.renderDirect({
    type: 'daily-agenda',
    data,
    userId,
  });
}
