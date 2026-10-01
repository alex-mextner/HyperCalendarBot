import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { CallSettingsRepository } from '../../../src/database/repositories/call-settings.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

describe('NotificationPreferencesRepository', () => {
  let db: Database;
  let repo: NotificationPreferencesRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    db.run("INSERT INTO users (telegram_id, username) VALUES (42, 'alice')");
    repo = new NotificationPreferencesRepository(db);
  });

  test('ensureDefaults creates row with defaults', () => {
    repo.ensureDefaults(42);
    const prefs = repo.get(42);
    expect(prefs).not.toBeNull();
    expect(prefs!.morning_agenda_enabled).toBe(1);
    expect(prefs!.morning_agenda_time).toBe('08:00');
    expect(prefs!.default_reminder_intervals).toBe('[30, 0]');
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

  test('has_voice_calls reflects voice CALLS, not the voice-reply toggle', () => {
    repo.ensureDefaults(42);
    db.run('UPDATE users SET voice_response_enabled = 1 WHERE telegram_id = 42');
    const callSettings = new CallSettingsRepository(db);
    callSettings.ensureDefaults(42);
    callSettings.setEnabled(42, false);
    expect(repo.getAllMorningEnabled().map((r) => r.has_voice_calls)).toEqual([0]);

    callSettings.setEnabled(42, true);
    expect(repo.getAllMorningEnabled().map((r) => r.has_voice_calls)).toEqual([1]);
  });

  test('has_voice_calls is 0 for a user with no call settings row', () => {
    repo.ensureDefaults(42);
    db.run('UPDATE users SET voice_response_enabled = 1 WHERE telegram_id = 42');
    expect(repo.getAllMorningEnabled().map((r) => r.has_voice_calls)).toEqual([0]);
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

  test('getMany returns map of found prefs', () => {
    db.run('INSERT INTO users (telegram_id) VALUES (43)');
    repo.ensureDefaults(42);
    repo.ensureDefaults(43);
    const result = repo.getMany([42, 43, 999]);
    expect(result.size).toBe(2);
    expect(result.get(42)?.morning_agenda_enabled).toBe(1);
    expect(result.get(43)?.morning_agenda_enabled).toBe(1);
    expect(result.has(999)).toBe(false);
  });

  test('getMany returns empty map for empty input', () => {
    expect(repo.getMany([]).size).toBe(0);
  });
});
