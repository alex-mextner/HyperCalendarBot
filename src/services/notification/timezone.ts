import { TZDate } from '@date-fns/tz';

export function getUserLocalTime(utcNow: Date, timezone: string): { hours: number; minutes: number } {
  const local = new TZDate(utcNow, timezone);
  return { hours: local.getHours(), minutes: local.getMinutes() };
}

export function isTimeMatch(utcNow: Date, timezone: string, targetHHMM: string): boolean {
  const local = getUserLocalTime(utcNow, timezone);
  const [targetH, targetM] = targetHHMM.split(':').map(Number);
  return local.hours === targetH && local.minutes === targetM;
}

export function localTimeToUtcHHMM(localHHMM: string, timezone: string): string {
  const [h, m] = localHHMM.split(':').map(Number);
  const refDate = new Date();
  const localDate = new TZDate(refDate, timezone);
  const offsetMs = localDate.getTimezoneOffset() * -60_000;
  const localMinutes = h! * 60 + m!;
  const offsetMinutes = offsetMs / 60_000;
  let utcMinutes = localMinutes - offsetMinutes;
  if (utcMinutes < 0) utcMinutes += 1440;
  if (utcMinutes >= 1440) utcMinutes -= 1440;
  const utcH = Math.floor(utcMinutes / 60);
  const utcM = utcMinutes % 60;
  return `${String(utcH).padStart(2, '0')}:${String(utcM).padStart(2, '0')}`;
}

export function isLocalTimeInWindow(
  nowUtc: Date,
  timezone: string,
  targetHHMM: string,
  windowMinutes: number,
): boolean {
  const local = getUserLocalTime(nowUtc, timezone);
  const localMinutes = local.hours * 60 + local.minutes;
  const [th, tm] = targetHHMM.split(':').map(Number);
  const targetMinutes = th! * 60 + tm!;
  const diff = (localMinutes - targetMinutes + 1440) % 1440;
  return diff < windowMinutes;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string | null;
  end: string | null;
}

export function isQuietHours(config: QuietHoursConfig, utcNow: Date, timezone: string): boolean {
  if (!config.enabled || !config.start || !config.end) return false;

  const local = getUserLocalTime(utcNow, timezone);
  const currentMinutes = local.hours * 60 + local.minutes;

  const [startH, startM] = config.start.split(':').map(Number);
  const [endH, endM] = config.end.split(':').map(Number);
  const startMinutes = startH! * 60 + startM!;
  const endMinutes = endH! * 60 + endM!;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
