import type {
  NotificationPreferencesRepository,
  NotificationPreferencesRow,
} from '../../database/repositories/notification-preferences.repository.ts';
import { localTimeToUtcHHMM } from './timezone.ts';

export class NotificationPreferencesService {
  constructor(private repo: NotificationPreferencesRepository) {}

  getOrCreate(userId: number): NotificationPreferencesRow {
    this.repo.ensureDefaults(userId);
    return this.repo.get(userId)!;
  }

  resolveDefaultIntervals(userId: number): number[] {
    const prefs = this.getOrCreate(userId);
    return JSON.parse(prefs.default_reminder_intervals) as number[];
  }

  updateMorningTime(userId: number, time: string, timezone: string): void {
    const utc = localTimeToUtcHHMM(time, timezone);
    this.repo.update(userId, { morning_agenda_time: time, morning_agenda_utc: utc });
  }

  updateEveningTime(userId: number, time: string, timezone: string): void {
    const utc = localTimeToUtcHHMM(time, timezone);
    this.repo.update(userId, { evening_review_time: time, evening_review_utc: utc });
  }

  toggleMorningAgenda(userId: number): void {
    const prefs = this.getOrCreate(userId);
    this.repo.update(userId, { morning_agenda_enabled: prefs.morning_agenda_enabled ? 0 : 1 });
  }

  toggleEveningReview(userId: number): void {
    const prefs = this.getOrCreate(userId);
    this.repo.update(userId, { evening_review_enabled: prefs.evening_review_enabled ? 0 : 1 });
  }

  toggleQuietHours(userId: number): void {
    const prefs = this.getOrCreate(userId);
    this.repo.update(userId, { quiet_hours_enabled: prefs.quiet_hours_enabled ? 0 : 1 });
  }

  updateQuietHoursStart(userId: number, time: string): void {
    this.repo.update(userId, { quiet_hours_start: time });
  }

  updateQuietHoursEnd(userId: number, time: string): void {
    this.repo.update(userId, { quiet_hours_end: time });
  }

  updateDefaultIntervals(userId: number, intervals: number[]): void {
    this.repo.update(userId, { default_reminder_intervals: JSON.stringify(intervals) });
  }

  recomputeUtcTimes(userId: number, timezone: string): void {
    const prefs = this.getOrCreate(userId);
    const morningUtc = localTimeToUtcHHMM(prefs.morning_agenda_time, timezone);
    const eveningUtc = localTimeToUtcHHMM(prefs.evening_review_time, timezone);
    this.repo.update(userId, { morning_agenda_utc: morningUtc, evening_review_utc: eveningUtc });
  }
}
