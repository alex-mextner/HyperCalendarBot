// Migration 066 backfills recurrence exception identity from a local calendar date key to the
// exact original occurrence instant (spec §5/§10). Migration 067 backfills legacy NULL
// occurrence_start on recurring-event reminders and adds the real identity unique index
// (event_id, user_id, occurrence_start, interval_minutes, interval_label) — see
// docs/superpowers/specs/2026-09-28-recurrence-semantics-583.md §7/§10 and
// docs/reference/migrations/066_recurrence_exception_identity.md /
// docs/reference/migrations/067_event_reminders_identity_index.md.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';

const MIGRATION_066 = '066_recurrence_exception_identity';
const MIGRATION_067 = '067_event_reminders_identity_index';

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

test('067: the reviewed deploy document exists', () => {
  expect(existsSync(join(import.meta.dir, '../../docs/reference/migrations', `${MIGRATION_067}.md`))).toBe(true);
});

test('066: an unambiguous legacy exception is rewritten to the exact resolved instant', () => {
  const db = dbBefore([MIGRATION_066, MIGRATION_067]);
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
  const db = dbBefore([MIGRATION_066, MIGRATION_067]);
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
  const db = dbBefore([MIGRATION_066, MIGRATION_067]);
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
  const db = dbBefore([MIGRATION_066, MIGRATION_067]);
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
  const db = dbBefore([MIGRATION_066, MIGRATION_067]);
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

test('067: a legacy recurring-event reminder row with NULL occurrence_start is left NULL, not backfilled', () => {
  // Reviewed: an earlier version of this migration backfilled every NULL occurrence_start to
  // the template's own start_at. That is unsafe (see the next test) and was removed — NULL
  // stays NULL, which the unique index treats as always-distinct.
  const db = dbBefore([MIGRATION_067]);
  insertUser(db, 1);
  insertTemplate(db, {
    id: 1,
    userId: 1,
    startAt: '2026-01-05T11:30:00Z',
    timezone: 'UTC',
    recurrenceRule: 'FREQ=WEEKLY',
  });
  db.run(
    "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start) VALUES (1, 1, '2026-01-05T11:00:00Z', 30, '30 minutes', NULL)",
  );

  applyThrough(db, MIGRATION_067);

  const row = db.prepare('SELECT occurrence_start FROM event_reminders WHERE event_id = 1').get() as {
    occurrence_start: string | null;
  };
  expect(row.occurrence_start).toBeNull();
});

test('067: two already-sent legacy rows sharing (event, user, interval, label) with NULL occurrence_start do not conflict', () => {
  // Reviewed (Grok/security): a recurring template can have MULTIPLE already-sent legacy
  // rows for different historical occurrences, all with occurrence_start = NULL (inserted
  // before migration 046 added the column; 046 only deleted UNSENT rows). A backfill that set
  // every such NULL to the template's current start_at would collapse two genuinely distinct
  // historical rows onto one identical key, violating the very index this migration creates
  // and aborting the whole migration transaction. This must not happen — the migration must
  // apply cleanly even when such rows exist.
  const db = dbBefore([MIGRATION_067]);
  insertUser(db, 1);
  insertTemplate(db, {
    id: 1,
    userId: 1,
    startAt: '2026-01-05T11:30:00Z',
    timezone: 'UTC',
    recurrenceRule: 'FREQ=WEEKLY',
  });
  db.run(
    "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start, sent) VALUES (1, 1, '2026-01-05T11:00:00Z', 30, '30 minutes', NULL, 1)",
  );
  db.run(
    "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start, sent) VALUES (1, 1, '2026-01-12T11:00:00Z', 30, '30 minutes', NULL, 1)",
  );

  expect(() => applyThrough(db, MIGRATION_067)).not.toThrow();

  const rows = db.prepare('SELECT occurrence_start FROM event_reminders WHERE event_id = 1').all() as {
    occurrence_start: string | null;
  }[];
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.occurrence_start === null)).toBe(true);
});

test('067: a non-recurring event reminder row with NULL occurrence_start is left NULL', () => {
  const db = dbBefore([MIGRATION_067]);
  insertUser(db, 1);
  insertTemplate(db, { id: 1, userId: 1, startAt: '2026-01-05T11:30:00Z', timezone: 'UTC', recurrenceRule: null });
  db.run(
    "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start) VALUES (1, 1, '2026-01-05T11:00:00Z', 30, '30 minutes', NULL)",
  );

  applyThrough(db, MIGRATION_067);

  const row = db.prepare('SELECT occurrence_start FROM event_reminders WHERE event_id = 1').get() as {
    occurrence_start: string | null;
  };
  expect(row.occurrence_start).toBeNull();
});

test('067: the unique index accepts two recipients of the same occurrence/interval (distinct user_id)', () => {
  const db = dbBefore([MIGRATION_067]);
  insertUser(db, 1);
  insertUser(db, 2);
  insertTemplate(db, {
    id: 1,
    userId: 1,
    startAt: '2026-01-05T11:30:00Z',
    timezone: 'UTC',
    recurrenceRule: 'FREQ=WEEKLY',
  });
  applyThrough(db, MIGRATION_067);

  db.run(
    "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start) VALUES (1, 1, '2026-01-05T11:00:00Z', 30, '30 minutes', '2026-01-05T11:30:00Z')",
  );
  expect(() =>
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start) VALUES (1, 2, '2026-01-05T11:00:00Z', 30, '30 minutes', '2026-01-05T11:30:00Z')",
    ),
  ).not.toThrow();
});

test('067: the unique index accepts the all-day "day before"/"day of" pair sharing interval_minutes -1', () => {
  const db = dbBefore([MIGRATION_067]);
  insertUser(db, 1);
  insertTemplate(db, { id: 1, userId: 1, startAt: '2026-01-05T00:00:00Z', timezone: 'UTC', recurrenceRule: null });
  applyThrough(db, MIGRATION_067);

  db.run(
    "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start) VALUES (1, 1, '2026-01-04T09:00:00Z', -1, 'day before', '2026-01-05T00:00:00Z')",
  );
  expect(() =>
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start) VALUES (1, 1, '2026-01-05T09:00:00Z', -1, 'day of', '2026-01-05T00:00:00Z')",
    ),
  ).not.toThrow();
});

test('067: the unique index rejects a true duplicate (event, user, occurrence, interval, label)', () => {
  const db = dbBefore([MIGRATION_067]);
  insertUser(db, 1);
  insertTemplate(db, {
    id: 1,
    userId: 1,
    startAt: '2026-01-05T11:30:00Z',
    timezone: 'UTC',
    recurrenceRule: 'FREQ=WEEKLY',
  });
  applyThrough(db, MIGRATION_067);

  db.run(
    "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start) VALUES (1, 1, '2026-01-05T11:00:00Z', 30, '30 minutes', '2026-01-05T11:30:00Z')",
  );
  expect(() =>
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label, occurrence_start) VALUES (1, 1, '2026-01-05T11:00:00Z', 30, '30 minutes', '2026-01-05T11:30:00Z')",
    ),
  ).toThrow();
});
