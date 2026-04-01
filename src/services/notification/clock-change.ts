import { TZDate } from '@date-fns/tz';
import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';
import { ruPlural } from '../event/formatters.ts';

export interface ClockChangeInfo {
  direction: 'forward' | 'back';
  minutes: number;
}

/**
 * Detects if a DST clock change occurred for a given timezone on a given local date.
 * Compares UTC offsets at noon today vs noon yesterday — noon avoids edge cases
 * around the actual transition hour (typically 2–3 AM).
 */
export function detectClockChange(timezone: string, localDateIso: string): ClockChangeInfo | null {
  const todayNoon = new TZDate(`${localDateIso}T12:00:00`, timezone);
  const yesterdayMs = new Date(`${localDateIso}T12:00:00Z`).getTime() - 86_400_000;
  const yesterdayIso = new Date(yesterdayMs).toISOString().slice(0, 10);
  const yesterdayNoon = new TZDate(`${yesterdayIso}T12:00:00`, timezone);

  const todayOffset = todayNoon.getTimezoneOffset();
  const yesterdayOffset = yesterdayNoon.getTimezoneOffset();

  if (todayOffset === yesterdayOffset) return null;

  // getTimezoneOffset: positive = west of UTC, negative = east.
  // If todayOffset < yesterdayOffset, clocks moved forward (spring).
  const diffMinutes = yesterdayOffset - todayOffset;
  return {
    direction: diffMinutes > 0 ? 'forward' : 'back',
    minutes: Math.abs(diffMinutes),
  };
}

function formatDuration(lang: string, minutes: number): string {
  const hours = minutes / 60;
  if (Number.isInteger(hours)) {
    return lang === 'ru' ? `${hours} ${ruPlural(hours, 'час', 'часа', 'часов')}` : `${hours}h`;
  }
  return lang === 'ru' ? `${minutes} ${ruPlural(minutes, 'минуту', 'минуты', 'минут')}` : `${minutes} min`;
}

export function formatClockChangeNotice(lang: string, info: ClockChangeInfo): string {
  const duration = formatDuration(lang, info.minutes);
  const msgs = t(lang as Lang).notifications;

  if (info.direction === 'forward') {
    return msgs.clockChangeForward(duration);
  }
  return msgs.clockChangeBack(duration);
}
