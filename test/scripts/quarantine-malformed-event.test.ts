import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyQuarantine, inspectMalformedPair } from '../../scripts/quarantine-malformed-event.ts';
import { migrations } from '../../src/database/migrations.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';

const INVALID = '22:59 local Europe/Belgrade to UTC';

describe('explicit malformed-event quarantine', () => {
  let directory: string;
  let dbPath: string;
  let db: Database;
  let repo: EventRepository;
  let ids: { ownerId: number; candidateId: number; replacementId: number };
  const raw = (id: number) =>
    db.query<{ is_deleted: number; title: string }, [number]>('SELECT is_deleted,title FROM events WHERE id=?').get(id);

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hcb-quarantine-'));
    dbPath = join(directory, 'calendar.db');
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    users.create({ telegram_id: 1001, timezone: 'UTC' });
    users.create({ telegram_id: 1002, timezone: 'UTC' });
    repo = new EventRepository(db);
    const base = {
      user_id: 1001,
      title: 'Private synthetic fixture',
      start_at: '2035-01-01T12:00:00Z',
      timezone: 'UTC',
    };
    const candidate = repo.create(base);
    const replacement = repo.create({
      ...base,
      title: 'Private synthetic replacement',
      start_at: '2035-01-01T21:59:00Z',
    });
    repo.create({ ...base, user_id: 1002 });
    // Simulate the stored pre-fix production corruption; the new repository forbids it.
    db.run('UPDATE events SET start_at=? WHERE id=?', [INVALID, candidate.id]);
    ids = { ownerId: 1001, candidateId: candidate.id, replacementId: replacement.id };
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('inspection is read-only and contains no event prose', () => {
    const plan = inspectMalformedPair(db, ids);
    expect(plan.candidateFingerprint).toHaveLength(64);
    expect(JSON.stringify(plan)).not.toContain('Private synthetic');
    expect(raw(ids.candidateId)?.is_deleted).toBe(0);
  });

  test('only the reviewed malformed row is soft-deleted; every other row is byte-for-byte unchanged', () => {
    const plan = inspectMalformedPair(db, ids);
    const result = applyQuarantine(db, plan);
    expect(result.status).toBe('quarantined');
    expect(result.changedIds).toEqual([ids.candidateId]);
    expect(raw(ids.candidateId)?.is_deleted).toBe(1);
    expect(repo.findById(ids.replacementId, 1001)?.title).toBe('Private synthetic replacement');
  });

  test('reapplying the exact plan is an idempotent no-op', () => {
    const plan = inspectMalformedPair(db, ids);
    applyQuarantine(db, plan);
    expect(applyQuarantine(db, plan)).toEqual({ status: 'already_quarantined', changedIds: [] });
  });

  test.each(['candidateId', 'replacementId'] as const)('concurrent edit to %s invalidates the fingerprint', (field) => {
    const plan = inspectMalformedPair(db, ids);
    repo.update(ids[field], 1001, { title: 'Concurrent user edit' });
    expect(() => applyQuarantine(db, plan)).toThrow('Fingerprint mismatch');
    expect(raw(ids.candidateId)?.is_deleted).toBe(0);
    expect(raw(ids[field])?.title).toBe('Concurrent user edit');
  });

  test('cross-owner manifest is rejected', () => {
    expect(() => inspectMalformedPair(db, { ...ids, ownerId: 1002 })).toThrow('Owner/scope mismatch');
  });

  test('a valid candidate may never be quarantined by this utility', () => {
    repo.update(ids.candidateId, 1001, { start_at: '2035-01-01T12:00:00Z' });
    expect(() => inspectMalformedPair(db, ids)).toThrow('Candidate timestamp is valid');
  });

  test('a candidate with Google sync evidence requires external reconciliation', () => {
    db.run('UPDATE events SET google_event_id=? WHERE id=?', ['synthetic-google-id', ids.candidateId]);
    expect(() => inspectMalformedPair(db, ids)).toThrow('Google synchronization evidence');
  });

  test('new dependent rows added after inspection prevent quarantine', () => {
    const plan = inspectMalformedPair(db, ids);
    db.exec('CREATE TABLE test_consumer (event_id INTEGER REFERENCES events(id))');
    db.run('INSERT INTO test_consumer(event_id) VALUES (?)', [ids.candidateId]);
    expect(() => applyQuarantine(db, plan)).toThrow('dependent rows');
    expect(raw(ids.candidateId)?.is_deleted).toBe(0);
  });

  test('unexpected trigger changes roll the complete transaction back', () => {
    const plan = inspectMalformedPair(db, ids);
    db.exec(`CREATE TRIGGER unexpected_change AFTER UPDATE OF is_deleted ON events
      WHEN NEW.id=${ids.candidateId} BEGIN UPDATE events SET title='Unexpected' WHERE id=${ids.replacementId}; END`);
    expect(() => applyQuarantine(db, plan)).toThrow('Unexpected write set');
    expect(raw(ids.candidateId)?.is_deleted).toBe(0);
    expect(raw(ids.replacementId)?.title).toBe('Private synthetic replacement');
  });

  function cli(args: string[]) {
    return Bun.spawnSync([
      process.execPath,
      '--no-env-file',
      resolve('scripts/quarantine-malformed-event.ts'),
      '--database',
      dbPath,
      ...args,
    ]);
  }

  test('CLI applies only with a manifest and creates a private WAL-consistent backup', () => {
    const manifest = join(directory, 'plan.json');
    const backup = join(directory, 'before.db');
    writeFileSync(manifest, JSON.stringify(inspectMalformedPair(db, ids)));
    const result = cli(['--apply', '--manifest', manifest, '--backup', backup]);
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
    expect(raw(ids.candidateId)?.is_deleted).toBe(1);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    const saved = new Database(backup, { readonly: true });
    try {
      expect(
        saved.query<{ is_deleted: number }, [number]>('SELECT is_deleted FROM events WHERE id=?').get(ids.candidateId)
          ?.is_deleted,
      ).toBe(0);
      expect(saved.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3);
    } finally {
      saved.close();
    }
  });

  test('CLI refuses missing backup and never overwrites an existing backup', () => {
    const manifest = join(directory, 'plan.json');
    const backup = join(directory, 'before.db');
    writeFileSync(manifest, JSON.stringify(inspectMalformedPair(db, ids)));
    const missingBackup = cli(['--apply', '--manifest', manifest]);
    expect(missingBackup.exitCode).toBe(1);
    expect(new TextDecoder().decode(missingBackup.stderr)).toContain('--apply requires both');
    writeFileSync(backup, 'keep existing backup');
    const existingBackup = cli(['--apply', '--manifest', manifest, '--backup', backup]);
    expect(existingBackup.exitCode).toBe(1);
    expect(new TextDecoder().decode(existingBackup.stderr)).toContain('EEXIST');
    expect(readFileSync(backup, 'utf8')).toBe('keep existing backup');
    expect(raw(ids.candidateId)?.is_deleted).toBe(0);
  });
  test.each([
    '2035-01-01T12:00:00',
    '2035-02-30T12:00:00Z',
  ])('parseable legacy timestamp %s needs separate normalization, not quarantine', (legacy) => {
    db.run('UPDATE events SET start_at=? WHERE id=?', [legacy, ids.candidateId]);
    expect(() => inspectMalformedPair(db, ids)).toThrow('parseable');
    expect(raw(ids.candidateId)?.is_deleted).toBe(0);
  });

  test('foreign keys with implicit primary-key target are not ignored', () => {
    const plan = inspectMalformedPair(db, ids);
    db.exec('CREATE TABLE implicit_consumer (event_id INTEGER REFERENCES events)');
    db.run('INSERT INTO implicit_consumer(event_id) VALUES (?)', [ids.candidateId]);
    expect(() => applyQuarantine(db, plan)).toThrow('dependent rows');
    expect(raw(ids.candidateId)?.is_deleted).toBe(0);
  });

  test('real reminder rows prevent a destructive cascade', () => {
    const reminders = new EventReminderRepository(db);
    const plan = inspectMalformedPair(db, ids);
    reminders.insert({
      event_id: ids.candidateId,
      user_id: 1001,
      remind_at_utc: '2035-01-01T12:00:00Z',
      interval_minutes: 10,
      interval_label: 'synthetic',
    });
    expect(() => applyQuarantine(db, plan)).toThrow('event_reminders');
    expect(reminders.getForEvent(ids.candidateId)).toHaveLength(1);
    expect(raw(ids.candidateId)?.is_deleted).toBe(0);
  });

  test('real child-event relation prevents quarantine of a parent', () => {
    const plan = inspectMalformedPair(db, ids);
    db.run('UPDATE events SET parent_event_id=? WHERE user_id=1002', [ids.candidateId]);
    expect(() => applyQuarantine(db, plan)).toThrow('dependent rows in events');
    expect(raw(ids.candidateId)?.is_deleted).toBe(0);
  });

  describe('pair safety preconditions', () => {
    const setCandidate = (column: string, value: string | number | null) =>
      db.run(`UPDATE events SET ${column}=? WHERE id=?`, [value, ids.candidateId]);
    const setReplacement = (column: string, value: string | number | null) =>
      db.run(`UPDATE events SET ${column}=? WHERE id=?`, [value, ids.replacementId]);

    test('candidate and replacement must be different rows', () => {
      expect(() => inspectMalformedPair(db, { ...ids, replacementId: ids.candidateId })).toThrow(
        'Candidate and replacement must differ',
      );
    });

    test('missing candidate or replacement row is rejected', () => {
      expect(() => inspectMalformedPair(db, { ...ids, candidateId: 99_999 })).toThrow('Expected rows not found');
      expect(() => inspectMalformedPair(db, { ...ids, replacementId: 99_999 })).toThrow('Expected rows not found');
    });

    test('non-positive or non-integer ids fail schema validation', () => {
      expect(() => inspectMalformedPair(db, { ...ids, candidateId: 0 })).toThrow();
      expect(() => inspectMalformedPair(db, { ...ids, replacementId: 1.5 })).toThrow();
    });

    test('the replacement row must also belong to the owner', () => {
      setReplacement('user_id', 1002);
      expect(() => inspectMalformedPair(db, ids)).toThrow('Owner/scope mismatch');
    });

    test('non-user-owned rows are rejected as a scope mismatch', () => {
      setCandidate('owner_type', 'group');
      expect(() => inspectMalformedPair(db, ids)).toThrow('Owner/scope mismatch');
    });

    test.each([
      ['is_cancelled', 1],
      ['recurrence_rule', 'FREQ=DAILY'],
    ] as const)('candidate with %s requires separate reconciliation', (column, value) => {
      setCandidate(column, value);
      expect(() => inspectMalformedPair(db, ids)).toThrow('Cancelled/recurring/exception rows');
    });

    test('replacement with an exception parent requires separate reconciliation', () => {
      setReplacement('parent_event_id', ids.candidateId);
      expect(() => inspectMalformedPair(db, ids)).toThrow('Cancelled/recurring/exception rows');
    });

    test('candidate row problems are reported before replacement row problems', () => {
      setCandidate('is_cancelled', 1);
      setReplacement('user_id', 1002);
      expect(() => inspectMalformedPair(db, ids)).toThrow('Cancelled/recurring/exception rows');
    });

    test('a deleted or malformed replacement is not a valid active event', () => {
      setReplacement('is_deleted', 1);
      expect(() => inspectMalformedPair(db, ids)).toThrow('Replacement is not a valid active event');
      setReplacement('is_deleted', 0);
      setReplacement('start_at', INVALID);
      expect(() => inspectMalformedPair(db, ids)).toThrow('Replacement is not a valid active event');
    });

    test.each([
      ['replacement created before candidate', '2035-01-01 00:00:00', '2034-12-31 23:59:59'],
      ['replacement created more than five minutes later', '2035-01-01 00:00:00', '2035-01-01 00:05:01'],
      ['unparseable replacement created_at', '2035-01-01 00:00:00', 'not a date'],
      ['unparseable candidate created_at', 'not a date', '2035-01-01 00:00:00'],
    ])('%s is outside one bounded repair window', (_label, candidateAt, replacementAt) => {
      setCandidate('created_at', candidateAt);
      setReplacement('created_at', replacementAt);
      expect(() => inspectMalformedPair(db, ids)).toThrow('Rows are not from one bounded repair window');
    });

    test('replacement created exactly five minutes later is within the window', () => {
      setCandidate('created_at', '2035-01-01 00:00:00');
      setReplacement('created_at', '2035-01-01 00:05:00');
      expect(inspectMalformedPair(db, ids).ownerId).toBe(1001);
    });

    test.each([
      ['google_calendar_id', 'synthetic-calendar'],
      ['last_synced_at', '2035-01-01 00:00:00'],
    ] as const)('candidate with %s counts as Google synchronization evidence', (column, value) => {
      setCandidate(column, value);
      expect(() => inspectMalformedPair(db, ids)).toThrow('Google synchronization evidence');
    });
  });
});
