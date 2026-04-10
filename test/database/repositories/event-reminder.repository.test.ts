import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';

describe('EventReminderRepository', () => {
  let db: Database;
  let repo: EventReminderRepository;

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
    db.run(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT,
      location TEXT,
      resolved_address TEXT,
      latitude REAL,
      longitude REAL,
      google_maps_url TEXT,
      venue_name TEXT,
      location_verified INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      all_day INTEGER NOT NULL DEFAULT 0,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE event_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      remind_at_utc TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      interval_label TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      occurrence_start TEXT,
      occurrence_end TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2026-03-15T10:00:00Z')");
    repo = new EventReminderRepository(db);
  });

  test('insert creates a reminder row', () => {
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });
    const rows = repo.getForEvent(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interval_minutes).toBe(15);
  });

  test('getDue returns reminders in time window', () => {
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });
    const due = repo.getDue('2026-03-15T09:45:00Z', '2026-03-15T09:46:00Z');
    expect(due.length).toBe(1);
  });

  test('getDue excludes already-sent reminders', () => {
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });
    const rows = repo.getForEvent(1);
    repo.markSent(rows[0]!.id);
    const due = repo.getDue('2026-03-15T09:45:00Z', '2026-03-15T09:46:00Z');
    expect(due.length).toBe(0);
  });

  test('deleteForEvent removes all reminders for an event', () => {
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });
    repo.deleteForEvent(1);
    expect(repo.getForEvent(1).length).toBe(0);
  });

  test('deleteUnsentForUser removes unsent reminders for a user', () => {
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });
    repo.deleteUnsentForUser(42);
    expect(repo.getForEvent(1).length).toBe(0);
  });

  test('getDue uses occurrence_start/end when set (recurring events)', () => {
    // Event template: start_at = 10:00, end_at = 11:00 (template times)
    db.run("UPDATE events SET end_at = '2026-03-15T11:00:00Z' WHERE id = 1");

    // Reminder with occurrence-specific times (different from template)
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-22T09:30:00Z',
      interval_minutes: 30,
      interval_label: '30 minutes',
      occurrence_start: '2026-03-22T10:00:00Z',
      occurrence_end: '2026-03-22T11:00:00Z',
    });

    const due = repo.getDue('2026-03-22T09:30:00Z', '2026-03-22T09:31:00Z');
    expect(due.length).toBe(1);
    // Should return occurrence times, not template times
    expect(due[0]!.event_start_at).toBe('2026-03-22T10:00:00Z');
    expect(due[0]!.event_end_at).toBe('2026-03-22T11:00:00Z');
  });

  test('getDue falls back to template times when occurrence_start is null', () => {
    db.run("UPDATE events SET end_at = '2026-03-15T11:00:00Z' WHERE id = 1");

    // Reminder without occurrence times (non-recurring or legacy)
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });

    const due = repo.getDue('2026-03-15T09:45:00Z', '2026-03-15T09:46:00Z');
    expect(due.length).toBe(1);
    // Falls back to event.start_at and event.end_at
    expect(due[0]!.event_start_at).toBe('2026-03-15T10:00:00Z');
    expect(due[0]!.event_end_at).toBe('2026-03-15T11:00:00Z');
  });
});
