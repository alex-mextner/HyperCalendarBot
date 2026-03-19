import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';

describe('NotificationPreferencesService', () => {
  let db: Database;
  let repo: NotificationPreferencesRepository;
  let service: NotificationPreferencesService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE notification_preferences (
      user_id INTEGER PRIMARY KEY,
      morning_agenda_enabled INTEGER NOT NULL DEFAULT 1,
      morning_agenda_time TEXT NOT NULL DEFAULT '08:00',
      morning_agenda_format TEXT NOT NULL DEFAULT 'text',
      default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
      evening_review_enabled INTEGER NOT NULL DEFAULT 0,
      evening_review_time TEXT NOT NULL DEFAULT '21:00',
      evening_review_format TEXT NOT NULL DEFAULT 'text',
      quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
      quiet_hours_start TEXT,
      quiet_hours_end TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id, timezone) VALUES (42, 'Europe/Moscow')");
    repo = new NotificationPreferencesRepository(db);
    service = new NotificationPreferencesService(repo);
  });

  test('getOrCreate creates defaults and returns them', () => {
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_enabled).toBe(1);
    expect(prefs.morning_agenda_time).toBe('08:00');
  });

  test('getOrCreate returns existing prefs on second call', () => {
    service.getOrCreate(42);
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_enabled).toBe(1);
  });

  test('resolveDefaultIntervals parses JSON', () => {
    service.getOrCreate(42);
    const intervals = service.resolveDefaultIntervals(42);
    expect(intervals).toEqual([15]);
  });

  test('updateMorningTime updates time', () => {
    service.getOrCreate(42);
    service.updateMorningTime(42, '09:00');
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_time).toBe('09:00');
  });

  test('toggleMorningAgenda flips enabled flag', () => {
    service.getOrCreate(42);
    service.toggleMorningAgenda(42);
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_enabled).toBe(0);
  });

  test('updateEveningTime updates time', () => {
    service.getOrCreate(42);
    service.updateEveningTime(42, '22:30');
    const prefs = service.getOrCreate(42);
    expect(prefs.evening_review_time).toBe('22:30');
  });

  test('toggleEveningReview flips enabled flag', () => {
    service.getOrCreate(42);
    expect(service.getOrCreate(42).evening_review_enabled).toBe(0);
    service.toggleEveningReview(42);
    expect(service.getOrCreate(42).evening_review_enabled).toBe(1);
    service.toggleEveningReview(42);
    expect(service.getOrCreate(42).evening_review_enabled).toBe(0);
  });

  test('toggleQuietHours flips enabled flag', () => {
    service.getOrCreate(42);
    expect(service.getOrCreate(42).quiet_hours_enabled).toBe(0);
    service.toggleQuietHours(42);
    expect(service.getOrCreate(42).quiet_hours_enabled).toBe(1);
    service.toggleQuietHours(42);
    expect(service.getOrCreate(42).quiet_hours_enabled).toBe(0);
  });

  test('updateQuietHoursStart sets quiet hours start time', () => {
    service.getOrCreate(42);
    service.updateQuietHoursStart(42, '23:00');
    const prefs = service.getOrCreate(42);
    expect(prefs.quiet_hours_start).toBe('23:00');
  });

  test('updateQuietHoursEnd sets quiet hours end time', () => {
    service.getOrCreate(42);
    service.updateQuietHoursEnd(42, '07:00');
    const prefs = service.getOrCreate(42);
    expect(prefs.quiet_hours_end).toBe('07:00');
  });

  test('updateDefaultIntervals persists intervals as JSON', () => {
    service.getOrCreate(42);
    service.updateDefaultIntervals(42, [5, 10, 30]);
    const intervals = service.resolveDefaultIntervals(42);
    expect(intervals).toEqual([5, 10, 30]);
  });
});
