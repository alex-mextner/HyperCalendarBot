import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';

describe('NotificationPreferencesRepository', () => {
  let db: Database;
  let repo: NotificationPreferencesRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      country_code TEXT,
      onboarding_completed INTEGER NOT NULL DEFAULT 0,
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
    db.run("INSERT INTO users (telegram_id, username) VALUES (42, 'alice')");
    repo = new NotificationPreferencesRepository(db);
  });

  test('ensureDefaults creates row with defaults', () => {
    repo.ensureDefaults(42);
    const prefs = repo.get(42);
    expect(prefs).not.toBeNull();
    expect(prefs!.morning_agenda_enabled).toBe(1);
    expect(prefs!.morning_agenda_time).toBe('08:00');
    expect(prefs!.default_reminder_intervals).toBe('[15]');
    expect(prefs!.evening_review_enabled).toBe(0);
    expect(prefs!.quiet_hours_enabled).toBe(0);
  });

  test('get returns null for non-existent user', () => {
    expect(repo.get(999)).toBeNull();
  });

  test('update modifies specific fields', () => {
    repo.ensureDefaults(42);
    repo.update(42, {
      morning_agenda_time: '09:00',
      evening_review_enabled: 1,
    });
    const prefs = repo.get(42);
    expect(prefs!.morning_agenda_time).toBe('09:00');
    expect(prefs!.evening_review_enabled).toBe(1);
  });

  test('getAllMorningEnabled returns users with morning enabled', () => {
    repo.ensureDefaults(42);
    const users = repo.getAllMorningEnabled();
    expect(users.length).toBe(1);
    expect(users[0]!.user_id).toBe(42);
  });

  test('getAllEveningEnabled returns users with evening enabled', () => {
    repo.ensureDefaults(42);
    repo.update(42, { evening_review_enabled: 1 });
    const users = repo.getAllEveningEnabled();
    expect(users.length).toBe(1);
    expect(users[0]!.user_id).toBe(42);
  });

  test('update throws on unknown field', () => {
    repo.ensureDefaults(42);
    expect(() => repo.update(42, { injected_column: 'x' } as never)).toThrow(
      'Unknown notification preference field: injected_column',
    );
  });

  test('update throws on SQL injection attempt in field name', () => {
    repo.ensureDefaults(42);
    expect(() => repo.update(42, { 'morning_agenda_time; DROP TABLE users; --': '1' } as never)).toThrow(
      /Unknown notification preference field/,
    );
  });
});
