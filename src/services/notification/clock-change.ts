import { TZDate } from '@date-fns/tz';

interface ClockChangeInfo {
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

export function formatClockChangeNotice(lang: string, info: ClockChangeInfo): string {
  const hours = info.minutes / 60;
  const hoursLabel = Number.isInteger(hours) ? String(hours) : String(hours);

  if (lang === 'ru') {
    if (info.direction === 'forward') {
      return `🕐 Сегодня ночью часы перевели на ${hoursLabel} ч вперёд. Проверь, что будильник и встречи правильно настроены!`;
    }
    return `🕐 Сегодня ночью часы перевели на ${hoursLabel} ч назад. Проверь, что будильник и встречи правильно настроены!`;
  }

  if (info.direction === 'forward') {
    return `🕐 Clocks moved ${hoursLabel}h forward last night. Double-check your alarms and meetings!`;
  }
  return `🕐 Clocks moved ${hoursLabel}h back last night. Double-check your alarms and meetings!`;
}
