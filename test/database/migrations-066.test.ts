// Migration 066 backfills recurrence exception identity from a local calendar date key to the
// exact original occurrence instant (spec §5/§10) — see
// docs/superpowers/specs/2026-09-28-recurrence-semantics-583.md §5/§10 and
// docs/reference/migrations/066_recurrence_exception_identity.md.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

const MIGRATION_066 = '066_recurrence_exception_identity';

function dbBefore(names: string[]): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(
    db,
    migrations.filter((m) => !names.includes(m.name)),
  );
  return db;
}

function applyThrough(db: Database, name: string): void {
  const idx = migrations.findIndex((m) => m.name === name);
  runMigrations(db, migrations.slice(0, idx + 1));
}

function insertUser(db: Database, telegramId: number): void {
  db.run('INSERT INTO users (telegram_id) VALUES (?)', [telegramId]);
}

function insertTemplate(
  db: Database,
  opts: { id: number; userId: number; startAt: string; timezone: string; recurrenceRule: string | null },
): void {
  db.run('INSERT INTO events (id, user_id, title, start_at, timezone, recurrence_rule) VALUES (?, ?, ?, ?, ?, ?)', [
    opts.id,
    opts.userId,
    'Template',
    opts.startAt,
    opts.timezone,
    opts.recurrenceRule,
  ]);
}

function insertException(
  db: Database,
  opts: { id: number; userId: number; parentId: number; startAt: string; originalStartAt: string },
): void {
  db.run(
    'INSERT INTO events (id, user_id, title, start_at, timezone, parent_event_id, original_start_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [opts.id, opts.userId, 'Exception', opts.startAt, 'UTC', opts.parentId, opts.originalStartAt],
  );
}

test('066: the reviewed deploy document exists', () => {
  expect(existsSync(join(import.meta.dir, '../../docs/reference/migrations', `${MIGRATION_066}.md`))).toBe(true);
});

test('066: an unambiguous legacy exception is rewritten to the exact resolved instant', () => {
  const db = dbBefore([MIGRATION_066]);
  insertUser(db, 1);
  insertTemplate(db, {
    id: 1,
    userId: 1,
    startAt: '2026-01-05T11:30:00Z',
    timezone: 'UTC',
    recurrenceRule: 'FREQ=WEEKLY',
  });
  // Legacy exception stored with an off-by-one-second instant, but unambiguously the Jan-12
  // occurrence (the only one that week).
  insertException(db, {
    id: 2,
    userId: 1,
    parentId: 1,
    startAt: '2026-01-12T12:00:00Z',
    originalStartAt: '2026-01-12T11:30:01Z',
  });

  applyThrough(db, MIGRATION_066);

  const row = db.prepare('SELECT original_start_at, identity_status FROM events WHERE id = 2').get() as {
    original_start_at: string;
    identity_status: string | null;
  };
  expect(row.original_start_at).toBe('2026-01-12T11:30:00.000Z');
  expect(row.identity_status).toBeNull();
});

test('066: an exception whose instant already matches exactly is left untouched (idempotent)', () => {
  const db = dbBefore([MIGRATION_066]);
  insertUser(db, 1);
  insertTemplate(db, {
    id: 1,
    userId: 1,
    startAt: '2026-01-05T11:30:00Z',
    timezone: 'UTC',
    recurrenceRule: 'FREQ=WEEKLY',
  });
  insertException(db, {
    id: 2,
    userId: 1,
    parentId: 1,
    startAt: '2026-01-12T12:00:00Z',
    originalStartAt: '2026-01-12T11:30:00.000Z',
  });

  applyThrough(db, MIGRATION_066);

  const row = db.prepare('SELECT original_start_at, identity_status FROM events WHERE id = 2').get() as {
    original_start_at: string;
    identity_status: string | null;
  };
  expect(row.original_start_at).toBe('2026-01-12T11:30:00.000Z');
  expect(row.identity_status).toBeNull();
});

test('066: an exception matching zero template occurrences that date is flagged unresolved, not guessed', () => {
  const db = dbBefore([MIGRATION_066]);
  insertUser(db, 1);
  insertTemplate(db, {
    id: 1,
    userId: 1,
    startAt: '2026-01-05T11:30:00Z',
    timezone: 'UTC',
    recurrenceRule: 'FREQ=WEEKLY',
  });
  // No template occurrence lands on Jan 13 (a Tuesday; the series is Mondays only).
  insertException(db, {
    id: 2,
    userId: 1,
    parentId: 1,
    startAt: '2026-01-13T12:00:00Z',
    originalStartAt: '2026-01-13T11:30:00Z',
  });

  applyThrough(db, MIGRATION_066);

  const row = db.prepare('SELECT original_start_at, identity_status FROM events WHERE id = 2').get() as {
    original_start_at: string;
    identity_status: string | null;
  };
  expect(row.original_start_at).toBe('2026-01-13T11:30:00Z'); // unchanged
  expect(row.identity_status).toBe('unresolved');
});

test('066: an exception whose parent template no longer has a recurrence_rule is left untouched', () => {
  const db = dbBefore([MIGRATION_066]);
  insertUser(db, 1);
  insertTemplate(db, { id: 1, userId: 1, startAt: '2026-01-05T11:30:00Z', timezone: 'UTC', recurrenceRule: null });
  insertException(db, {
    id: 2,
    userId: 1,
    parentId: 1,
    startAt: '2026-01-12T12:00:00Z',
    originalStartAt: '2026-01-12T11:30:00Z',
  });

  applyThrough(db, MIGRATION_066);

  const row = db.prepare('SELECT original_start_at, identity_status FROM events WHERE id = 2').get() as {
    original_start_at: string;
    identity_status: string | null;
  };
  expect(row.original_start_at).toBe('2026-01-12T11:30:00Z');
  expect(row.identity_status).toBeNull();
});

test('066: an exception whose parent template rule is itself unsupported (multi-RRULE) is left untouched, not flagged unresolved', () => {
  // Reviewed: the backfill must not guess at a parent it cannot validate, and must not
  // conflate "parent rule unsupported" with "zero/ambiguous matching occurrences" — both are
  // "can't validate", but only the deploy doc's case 5 (no live/valid parent) leaves the row
  // completely untouched.
  const db = dbBefore([MIGRATION_066]);
  insertUser(db, 1);
  insertTemplate(db, {
    id: 1,
    userId: 1,
    startAt: '2026-01-05T11:30:00Z',
    timezone: 'UTC',
    recurrenceRule: 'RRULE:FREQ=WEEKLY;COUNT=6\nRRULE:FREQ=DAILY;COUNT=3',
  });
  insertException(db, {
    id: 2,
    userId: 1,
    parentId: 1,
    startAt: '2026-01-12T12:00:00Z',
    originalStartAt: '2026-01-12T11:30:00Z',
  });

  applyThrough(db, MIGRATION_066);

  const row = db.prepare('SELECT original_start_at, identity_status FROM events WHERE id = 2').get() as {
    original_start_at: string;
    identity_status: string | null;
  };
  expect(row.original_start_at).toBe('2026-01-12T11:30:00Z');
  expect(row.identity_status).toBeNull();
});
