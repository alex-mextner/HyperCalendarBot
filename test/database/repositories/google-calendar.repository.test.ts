// test/database/repositories/google-calendar.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';

describe('GoogleCalendarRepository', () => {
  let db: Database;
  let repo: GoogleCalendarRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT, first_name TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      country_code TEXT,
      google_refresh_token_enc TEXT,
      google_calendar_id TEXT,
      onboarding_completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE google_calendars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      google_calendar_id TEXT NOT NULL,
      calendar_name TEXT NOT NULL,
      color TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sync_enabled INTEGER NOT NULL DEFAULT 1,
      access_role TEXT NOT NULL DEFAULT 'owner'
        CHECK (access_role IN ('owner', 'writer', 'reader', 'freeBusyReader')),
      sync_token TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
      UNIQUE (user_id, google_calendar_id)
    )`);
    db.run(`CREATE TABLE google_watch_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_calendar_row_id INTEGER NOT NULL,
      channel_id TEXT NOT NULL UNIQUE,
      resource_id TEXT NOT NULL,
      expiration TEXT NOT NULL,
      channel_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (google_calendar_row_id) REFERENCES google_calendars(id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id, username) VALUES (42, 'alice')");
    repo = new GoogleCalendarRepository(db);
  });

  test('upsertCalendar creates calendar', () => {
    repo.upsertCalendar(42, {
      google_calendar_id: 'primary',
      calendar_name: 'My Calendar',
      color: '#4285f4',
      is_primary: true,
      access_role: 'owner',
    });
    const cals = repo.getCalendars(42);
    expect(cals.length).toBe(1);
    expect(cals[0]!.calendar_name).toBe('My Calendar');
    expect(cals[0]!.is_primary).toBe(1);
  });

  test('upsertCalendar updates on conflict', () => {
    repo.upsertCalendar(42, {
      google_calendar_id: 'primary',
      calendar_name: 'Old Name',
      is_primary: true,
      access_role: 'owner',
    });
    repo.upsertCalendar(42, {
      google_calendar_id: 'primary',
      calendar_name: 'New Name',
      is_primary: true,
      access_role: 'owner',
    });
    const cals = repo.getCalendars(42);
    expect(cals.length).toBe(1);
    expect(cals[0]!.calendar_name).toBe('New Name');
  });

  test('toggleSync flips sync_enabled', () => {
    repo.upsertCalendar(42, {
      google_calendar_id: 'cal1',
      calendar_name: 'Cal',
      is_primary: false,
      access_role: 'owner',
    });
    const cal = repo.getCalendars(42)[0]!;
    expect(cal.sync_enabled).toBe(1);
    repo.toggleSync(cal.id);
    expect(repo.getCalendars(42)[0]!.sync_enabled).toBe(0);
  });

  test('updateSyncToken stores token', () => {
    repo.upsertCalendar(42, {
      google_calendar_id: 'cal1',
      calendar_name: 'Cal',
      is_primary: false,
      access_role: 'owner',
    });
    const cal = repo.getCalendars(42)[0]!;
    repo.updateSyncToken(cal.id, 'sync-token-123');
    expect(repo.getCalendars(42)[0]!.sync_token).toBe('sync-token-123');
  });

  test('getEnabledCalendars returns only sync_enabled=1', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    repo.upsertCalendar(42, { google_calendar_id: 'b', calendar_name: 'B', is_primary: false, access_role: 'owner' });
    const calB = repo.getCalendars(42).find((c) => c.google_calendar_id === 'b')!;
    repo.toggleSync(calB.id);
    expect(repo.getEnabledCalendars(42).length).toBe(1);
  });

  test('deleteUserCalendars removes all calendars', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    repo.deleteUserCalendars(42);
    expect(repo.getCalendars(42).length).toBe(0);
  });

  test('addWatchChannel creates channel', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    const cal = repo.getCalendars(42)[0]!;
    repo.addWatchChannel(cal.id, 'ch-uuid', 'res-123', '2026-03-20T00:00:00Z', 'tok-1');
    const channels = repo.getWatchChannels(cal.id);
    expect(channels.length).toBe(1);
    expect(channels[0]!.channel_id).toBe('ch-uuid');
    expect(channels[0]!.channel_token).toBe('tok-1');
  });

  test('getExpiringChannels finds channels expiring before threshold', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    const cal = repo.getCalendars(42)[0]!;
    repo.addWatchChannel(cal.id, 'ch1', 'res1', '2026-03-14T00:00:00Z', 'tok-a');
    repo.addWatchChannel(cal.id, 'ch2', 'res2', '2026-04-01T00:00:00Z', 'tok-b');
    const expiring = repo.getExpiringChannels('2026-03-15T00:00:00Z');
    expect(expiring.length).toBe(1);
    expect(expiring[0]!.channel_id).toBe('ch1');
  });

  test('deleteWatchChannel removes channel', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    const cal = repo.getCalendars(42)[0]!;
    repo.addWatchChannel(cal.id, 'ch1', 'res1', '2026-03-20T00:00:00Z', 'tok-1');
    const ch = repo.getWatchChannels(cal.id)[0]!;
    repo.deleteWatchChannel(ch.id);
    expect(repo.getWatchChannels(cal.id).length).toBe(0);
  });

  test('findChannelByIds looks up by channel_id and resource_id', () => {
    repo.upsertCalendar(42, { google_calendar_id: 'a', calendar_name: 'A', is_primary: true, access_role: 'owner' });
    const cal = repo.getCalendars(42)[0]!;
    repo.addWatchChannel(cal.id, 'ch1', 'res1', '2026-03-20T00:00:00Z', 'tok-1');
    const found = repo.findChannelByIds('ch1', 'res1');
    expect(found).not.toBeNull();
    expect(found!.channel_id).toBe('ch1');
  });

  test('findChannelByIds returns null for unknown', () => {
    expect(repo.findChannelByIds('nope', 'nope')).toBeNull();
  });
});
