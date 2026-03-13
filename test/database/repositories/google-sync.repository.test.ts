// test/database/repositories/google-sync.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';

describe('GoogleSyncRepository', () => {
  let db: Database;
  let repo: GoogleSyncRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    // Create minimal schema
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
    db.run(`CREATE TABLE google_sync_state (
      user_id INTEGER PRIMARY KEY,
      access_token TEXT,
      expires_at TEXT,
      scopes TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked', 'expired')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_id INTEGER,
      google_event_id TEXT,
      direction TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
      action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'conflict_resolve')),
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id, username) VALUES (42, 'alice')");
    repo = new GoogleSyncRepository(db);
  });

  test('upsertSyncState creates new record', () => {
    repo.upsertSyncState(42, 'calendar.readonly calendar.events');
    const state = repo.getSyncState(42);
    expect(state).not.toBeNull();
    expect(state!.status).toBe('active');
    expect(state!.scopes).toBe('calendar.readonly calendar.events');
  });

  test('upsertSyncState updates existing record', () => {
    repo.upsertSyncState(42, 'scope1');
    repo.upsertSyncState(42, 'scope1 scope2');
    const state = repo.getSyncState(42);
    expect(state!.scopes).toBe('scope1 scope2');
  });

  test('updateAccessToken stores token', () => {
    repo.upsertSyncState(42, 'scopes');
    repo.updateAccessToken(42, 'token123', '2026-03-14T00:00:00Z');
    const state = repo.getSyncState(42);
    expect(state!.access_token).toBe('token123');
    expect(state!.expires_at).toBe('2026-03-14T00:00:00Z');
  });

  test('markRevoked sets status', () => {
    repo.upsertSyncState(42, 'scopes');
    repo.markRevoked(42);
    const state = repo.getSyncState(42);
    expect(state!.status).toBe('revoked');
  });

  test('deleteSyncState removes record', () => {
    repo.upsertSyncState(42, 'scopes');
    repo.deleteSyncState(42);
    expect(repo.getSyncState(42)).toBeNull();
  });

  test('logSync creates sync log entry', () => {
    repo.logSync({ user_id: 42, event_id: 1, google_event_id: 'g1', direction: 'push', action: 'create' });
    const logs = repo.getRecentLogs(42, 10);
    expect(logs.length).toBe(1);
    expect(logs[0]!.direction).toBe('push');
    expect(logs[0]!.action).toBe('create');
  });

  test('pruneOldLogs removes entries older than N days', () => {
    repo.logSync({ user_id: 42, direction: 'push', action: 'create' });
    // Manually backdate
    db.run("UPDATE sync_log SET created_at = datetime('now', '-31 days')");
    repo.pruneOldLogs(30);
    expect(repo.getRecentLogs(42, 10).length).toBe(0);
  });

  test('getActiveUsers returns users with active status', () => {
    repo.upsertSyncState(42, 'scopes');
    const users = repo.getActiveUsers();
    expect(users.length).toBe(1);
    expect(users[0]).toBe(42);
  });
});
