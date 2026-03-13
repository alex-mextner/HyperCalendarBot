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
      morning_agenda_utc TEXT,
      morning_agenda_format TEXT NOT NULL DEFAULT 'text',
      default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
      evening_review_enabled INTEGER NOT NULL DEFAULT 0,
      evening_review_time TEXT NOT NULL DEFAULT '21:00',
      evening_review_utc TEXT,
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

  test('updateMorningTime updates time and recomputes UTC', () => {
    service.getOrCreate(42);
    service.updateMorningTime(42, '09:00', 'Europe/Moscow');
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_time).toBe('09:00');
    expect(prefs.morning_agenda_utc).toBe('06:00');
  });

  test('toggleMorningAgenda flips enabled flag', () => {
    service.getOrCreate(42);
    service.toggleMorningAgenda(42);
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_enabled).toBe(0);
  });
});
