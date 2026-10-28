// #875: the backfill relinks rows whose Google copy exists but whose Google id was never stored.
// Real SQLite, a synthetic calendar listing. The plan reads only; the apply writes ids and nothing else.
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import {
  applyGoogleIdBackfill,
  type BackfillCounts,
  createVerifiedBackup,
  dropContestedLinks,
  planGoogleIdBackfill,
} from '../../../src/services/google/event-id-backfill.ts';
import type { GoogleEvent } from '../../../src/services/google/event-mapper.ts';

const USER = 9401;
const OTHER = 9402;
const MARKER = 'hypercalendarbot_event_id';

/** A live event of the calendar; `marker` is the bot event it was made from, absent for a native one. */
function listed(id: string, summary: string, startUtc: string, marker?: number): GoogleEvent {
  return {
    id,
    summary,
    status: 'confirmed',
    start: { dateTime: startUtc },
    end: { dateTime: startUtc },
    ...(marker === undefined ? {} : { extendedProperties: { private: { [MARKER]: String(marker) } } }),
  };
}

interface RowDump {
  events: unknown[];
  participantLinks: unknown[];
  syncLog: unknown[];
}

describe('Google id backfill (#875)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    db.run(`INSERT INTO users (telegram_id, username) VALUES (${USER}, 'owner'), (${OTHER}, 'other')`);
  });

  function addEvent(
    title: string,
    startUtc: string,
    opts: { user?: number; status?: string; googleId?: string; deleted?: boolean; group?: boolean } = {},
  ): number {
    const result = db
      .query(
        `INSERT INTO events (user_id, title, start_at, end_at, timezone, sync_status, google_event_id, is_deleted, owner_type)
         VALUES (?, ?, ?, ?, 'UTC', ?, ?, ?, ?)`,
      )
      .run(
        opts.user ?? USER,
        title,
        startUtc,
        startUtc,
        opts.status ?? 'synced',
        opts.googleId ?? null,
        opts.deleted ? 1 : 0,
        opts.group ? 'group' : 'user',
      );
    return Number(result.lastInsertRowid);
  }

  function addParticipantLink(eventId: number, status = 'synced'): void {
    db.query('INSERT INTO participant_google_sync (user_id, event_id, sync_status) VALUES (?, ?, ?)').run(
      USER,
      eventId,
      status,
    );
  }

  function dump(): RowDump {
    return {
      events: db.query('SELECT * FROM events ORDER BY id').all(),
      participantLinks: db.query('SELECT * FROM participant_google_sync ORDER BY id').all(),
      syncLog: db.query('SELECT * FROM sync_log ORDER BY id').all(),
    };
  }

  const eventIdOf = (id: number): string | null =>
    db.query<{ google_event_id: string | null }, [number]>('SELECT google_event_id FROM events WHERE id = ?').get(id)!
      .google_event_id;

  /** A calendar exercising every outcome; returns the row ids by name. */
  function scenario() {
    const ids = {
      byMarker: addEvent('Alpha', '2026-10-30T10:00:00.000Z'),
      twoCopies: addEvent('Beta', '2026-10-30T11:00:00.000Z', { status: 'pending_push' }),
      linked: addEvent('Gamma', '2026-10-30T12:00:00.000Z', { googleId: 'g-gamma' }),
      deleted: addEvent('Delta', '2026-10-30T13:00:00.000Z', { deleted: true }),
      bySlot: addEvent('Epsilon', '2026-10-30T14:00:00.000Z'),
      slotTwice: addEvent('Zeta', '2026-10-30T15:00:00.000Z'),
      neverPushed: addEvent('Eta', '2026-10-30T16:00:00.000Z', { status: 'local_only' }),
      groupEvent: addEvent('Theta', '2026-10-30T17:00:00.000Z', { group: true, status: 'local_only' }),
      noCopy: addEvent('Iota', '2026-10-30T18:00:00.000Z'),
      otherUser: addEvent('Kappa', '2026-10-30T19:00:00.000Z', { user: OTHER }),
    };
    addParticipantLink(ids.groupEvent);
    const calendar: GoogleEvent[] = [
      listed('g-alpha', 'Alpha', '2026-10-30T10:00:00.000Z', ids.byMarker),
      listed('g-beta-1', 'Beta', '2026-10-30T11:00:00.000Z', ids.twoCopies),
      listed('g-beta-2', 'Beta', '2026-10-30T11:00:00.000Z', ids.twoCopies),
      listed('g-gamma', 'Gamma', '2026-10-30T12:00:00.000Z', ids.linked),
      listed('g-gamma-extra', 'Gamma', '2026-10-30T12:00:00.000Z', ids.linked),
      listed('g-delta', 'Delta', '2026-10-30T13:00:00.000Z', ids.deleted),
      // Native copy of Epsilon: no marker, the same time written with an offset.
      listed('g-epsilon', 'Epsilon', '2026-10-30T16:00:00+02:00'),
      listed('g-zeta-1', 'Zeta', '2026-10-30T15:00:00.000Z'),
      listed('g-zeta-2', 'Zeta', '2026-10-30T15:00:00.000Z'),
      listed('g-eta', 'Eta', '2026-10-30T16:00:00.000Z'),
      listed('g-theta', 'Theta', '2026-10-30T17:00:00.000Z', ids.groupEvent),
      { ...listed('g-gone', 'Gone', '2026-10-30T20:00:00.000Z'), status: 'cancelled' },
    ];
    return { ids, calendar };
  }

  const expectedCounts: BackfillCounts = {
    googleListed: 11,
    googleBotCopies: 7,
    alreadyLinked: 1,
    looseCopies: 6,
    unlinkedRows: 7,
    linkableByMarker: 2,
    linkableBySlot: 1,
    ambiguous: 2,
    copiesWithoutRow: 1,
    extraCopiesOfLinkedEvent: 1,
    rowsWithoutCopy: 3,
  };

  test('the plan reads only, and reports counts that name no event', () => {
    const { calendar } = scenario();
    const before = dump();

    const plan = planGoogleIdBackfill(db, USER, calendar);

    expect(dump()).toEqual(before);
    expect(plan.counts).toEqual(expectedCounts);
    expect(Object.values(plan.counts).every((value) => typeof value === 'number')).toBe(true);
  });

  test('only the unambiguous matches are planned: by marker, then by summary and time', () => {
    const { ids, calendar } = scenario();

    const plan = planGoogleIdBackfill(db, USER, calendar);

    expect(plan.links).toEqual([
      { kind: 'owner', userId: USER, eventId: ids.byMarker, googleEventId: 'g-alpha', via: 'marker' },
      { kind: 'participant', userId: USER, eventId: ids.groupEvent, googleEventId: 'g-theta', via: 'marker' },
      { kind: 'owner', userId: USER, eventId: ids.bySlot, googleEventId: 'g-epsilon', via: 'slot' },
    ]);
  });

  test('a row that never left the bot is not matched by its summary and time', () => {
    const { ids, calendar } = scenario();

    const plan = planGoogleIdBackfill(db, USER, calendar);

    expect(plan.links.map((link) => link.eventId)).not.toContain(ids.neverPushed);
  });

  test('the apply writes the missing ids and nothing else', () => {
    const { ids, calendar } = scenario();
    const before = dump();

    const applied = applyGoogleIdBackfill(db, planGoogleIdBackfill(db, USER, calendar));

    expect(applied).toEqual({ applied: 3, skippedChanged: 0 });
    const after = dump();
    const withoutIds = (rows: unknown[]) =>
      rows.map((row) => ({ ...(row as Record<string, unknown>), google_event_id: undefined }));
    expect(withoutIds(after.events)).toEqual(withoutIds(before.events));
    expect(withoutIds(after.participantLinks)).toEqual(withoutIds(before.participantLinks));
    expect(eventIdOf(ids.byMarker)).toBe('g-alpha');
    expect(eventIdOf(ids.bySlot)).toBe('g-epsilon');
    expect(eventIdOf(ids.groupEvent)).toBeNull();
    expect(
      db
        .query<{ google_event_id: string }, [number]>(
          'SELECT google_event_id FROM participant_google_sync WHERE event_id = ?',
        )
        .get(ids.groupEvent)?.google_event_id,
    ).toBe('g-theta');
    // Rows the plan did not name keep their state, other users' rows included.
    for (const untouched of [ids.twoCopies, ids.slotTwice, ids.neverPushed, ids.noCopy, ids.otherUser, ids.deleted]) {
      expect(eventIdOf(untouched)).toBeNull();
    }
    expect(eventIdOf(ids.linked)).toBe('g-gamma');
  });

  test('every applied link leaves a log row that names how it was found', () => {
    const { calendar } = scenario();

    applyGoogleIdBackfill(db, planGoogleIdBackfill(db, USER, calendar));

    const rows = db
      .query<{ google_event_id: string; direction: string; action: string; details: string }, []>(
        'SELECT google_event_id, direction, action, details FROM sync_log ORDER BY id',
      )
      .all();
    expect(rows.map((row) => [row.google_event_id, row.direction, row.action])).toEqual([
      ['g-alpha', 'pull', 'update'],
      ['g-theta', 'pull', 'update'],
      ['g-epsilon', 'pull', 'update'],
    ]);
    expect(rows.map((row) => JSON.parse(row.details))).toEqual([
      { reason: 'google_id_backfill', via: 'marker', kind: 'owner' },
      { reason: 'google_id_backfill', via: 'marker', kind: 'participant' },
      { reason: 'google_id_backfill', via: 'slot', kind: 'owner' },
    ]);
  });

  test('a second run finds nothing to do', () => {
    const { calendar } = scenario();
    applyGoogleIdBackfill(db, planGoogleIdBackfill(db, USER, calendar));
    const afterFirst = dump();

    const again = planGoogleIdBackfill(db, USER, calendar);
    const applied = applyGoogleIdBackfill(db, again);

    expect(again.links).toEqual([]);
    expect(applied).toEqual({ applied: 0, skippedChanged: 0 });
    expect(dump()).toEqual(afterFirst);
  });

  test('a row linked or deleted since the plan was made is left alone', () => {
    const { ids, calendar } = scenario();
    const plan = planGoogleIdBackfill(db, USER, calendar);
    db.query("UPDATE events SET google_event_id = 'g-someone-else' WHERE id = ?").run(ids.byMarker);
    db.query('UPDATE events SET is_deleted = 1 WHERE id = ?').run(ids.bySlot);

    const applied = applyGoogleIdBackfill(db, plan);

    expect(applied).toEqual({ applied: 1, skippedChanged: 2 });
    expect(eventIdOf(ids.byMarker)).toBe('g-someone-else');
    expect(eventIdOf(ids.bySlot)).toBeNull();
  });

  test('a copy another row of the user already points at is never written to a second row', () => {
    const first = addEvent('Alpha', '2026-10-30T10:00:00.000Z');
    const plan = planGoogleIdBackfill(db, USER, [listed('g-alpha', 'Alpha', '2026-10-30T10:00:00.000Z', first)]);
    addEvent('Taken', '2026-10-30T09:00:00.000Z', { googleId: 'g-alpha' });

    const applied = applyGoogleIdBackfill(db, plan);

    expect(applied).toEqual({ applied: 0, skippedChanged: 1 });
    expect(eventIdOf(first)).toBeNull();
  });

  test("a copy another user's row already owns is not this user's to claim", () => {
    // Two users on one Google calendar: the other user's link row owns g-shared.
    const theirs = addEvent('Alpha', '2026-10-30T10:00:00.000Z', { user: OTHER, googleId: 'g-shared' });
    const mine = addEvent('Alpha', '2026-10-30T10:00:00.000Z');
    const calendar = [
      listed('g-shared', 'Alpha', '2026-10-30T10:00:00.000Z', theirs),
      listed('g-mine', 'Alpha', '2026-10-30T10:00:00.000Z', mine),
    ];

    const plan = planGoogleIdBackfill(db, USER, calendar);

    expect(plan.links).toEqual([
      { kind: 'owner', userId: USER, eventId: mine, googleEventId: 'g-mine', via: 'marker' },
    ]);
    expect(plan.counts.alreadyLinked).toBe(1);
  });

  test('an instance of a series is not counted as a copy, whatever marker it inherits', () => {
    const series = addEvent('Alpha', '2026-10-30T10:00:00.000Z', { googleId: 'g-series' });
    const calendar: GoogleEvent[] = [
      listed('g-series', 'Alpha', '2026-10-30T10:00:00.000Z', series),
      { ...listed('g-series_20261106', 'Alpha', '2026-11-06T10:00:00.000Z', series), recurringEventId: 'g-series' },
    ];

    const plan = planGoogleIdBackfill(db, USER, calendar);

    expect(plan.counts).toMatchObject({ googleListed: 1, googleBotCopies: 1, extraCopiesOfLinkedEvent: 0 });
  });

  describe('matching by summary and time', () => {
    test("a timed row in another zone matches the same instant written with that zone's offset", () => {
      const row = addEvent('Eta', '2026-10-30T10:00:00.000Z');
      db.query("UPDATE events SET timezone = 'Europe/Moscow' WHERE id = ?").run(row);

      const plan = planGoogleIdBackfill(db, USER, [listed('g-eta', 'Eta', '2026-10-30T13:00:00+03:00')]);

      expect(plan.links).toEqual([{ kind: 'owner', userId: USER, eventId: row, googleEventId: 'g-eta', via: 'slot' }]);
    });

    test('an all-day row matches an all-day copy on its day', () => {
      const row = addEvent('Holiday', '2026-10-31');
      db.query('UPDATE events SET all_day = 1 WHERE id = ?').run(row);
      const copy: GoogleEvent = {
        id: 'g-holiday',
        summary: 'Holiday',
        status: 'confirmed',
        start: { date: '2026-10-31' },
        end: { date: '2026-11-01' },
      };

      const plan = planGoogleIdBackfill(db, USER, [copy]);

      expect(plan.links.map((link) => link.googleEventId)).toEqual(['g-holiday']);
    });

    test('two rows with the same summary and time against one copy are ambiguous: nothing is linked', () => {
      addEvent('Standup', '2026-10-30T10:00:00.000Z');
      addEvent('Standup', '2026-10-30T10:00:00.000Z');

      const plan = planGoogleIdBackfill(db, USER, [listed('g-standup', 'Standup', '2026-10-30T10:00:00.000Z')]);

      expect(plan.links).toEqual([]);
      expect(plan.counts.ambiguous).toBe(2);
    });

    test('a copy marked for another bot event is not taken for this row, even with the same summary and time', () => {
      addEvent('Standup', '2026-10-30T10:00:00.000Z');
      const elsewhere = addEvent('Standup', '2026-10-30T10:00:00.000Z', { user: OTHER, googleId: 'g-theirs' });

      const plan = planGoogleIdBackfill(db, USER, [
        listed('g-theirs', 'Standup', '2026-10-30T10:00:00.000Z', elsewhere),
        listed('g-lost', 'Standup', '2026-10-30T10:00:00.000Z', elsewhere + 1000),
      ]);

      expect(plan.links).toEqual([]);
    });

    test('a series row is never matched this way, and neither is the master copy of a series', () => {
      const seriesRow = addEvent('Weekly', '2026-10-30T10:00:00.000Z');
      db.query("UPDATE events SET recurrence_rule = 'RRULE:FREQ=WEEKLY' WHERE id = ?").run(seriesRow);
      addEvent('Single', '2026-10-31T10:00:00.000Z');
      const calendar: GoogleEvent[] = [
        listed('g-weekly', 'Weekly', '2026-10-30T10:00:00.000Z'),
        { ...listed('g-single-series', 'Single', '2026-10-31T10:00:00.000Z'), recurrence: ['RRULE:FREQ=DAILY'] },
      ];

      expect(planGoogleIdBackfill(db, USER, calendar).links).toEqual([]);
    });
  });

  test('a participant link whose event was deleted since the plan is left alone', () => {
    const event = addEvent('Theta', '2026-10-30T17:00:00.000Z', { user: OTHER });
    addParticipantLink(event);
    const plan = planGoogleIdBackfill(db, USER, [listed('g-theta', 'Theta', '2026-10-30T17:00:00.000Z', event)]);
    db.query('UPDATE events SET is_deleted = 1 WHERE id = ?').run(event);

    const applied = applyGoogleIdBackfill(db, plan);

    expect(plan.links).toHaveLength(1);
    expect(applied).toEqual({ applied: 0, skippedChanged: 1 });
  });

  test("a copy another user's plan found ambiguous is not linked to this user either", () => {
    addEvent('Standup', '2026-10-30T10:00:00.000Z');
    addEvent('Standup', '2026-10-30T10:00:00.000Z', { user: OTHER });
    addEvent('Standup', '2026-10-30T10:00:00.000Z', { user: OTHER });
    const calendar = [listed('g-shared', 'Standup', '2026-10-30T10:00:00.000Z')];
    const plans = [planGoogleIdBackfill(db, USER, calendar), planGoogleIdBackfill(db, OTHER, calendar)];
    expect(plans.map((plan) => plan.links.length)).toEqual([1, 0]);

    const resolved = dropContestedLinks(plans);

    expect(resolved.map((plan) => plan.links.length)).toEqual([0, 0]);
  });

  test("a copy two users' plans both want is dropped from both, and counted as ambiguous", () => {
    const mine = addEvent('Standup', '2026-10-30T10:00:00.000Z');
    const theirs = addEvent('Standup', '2026-10-30T10:00:00.000Z', { user: OTHER });
    const calendar = [listed('g-shared', 'Standup', '2026-10-30T10:00:00.000Z')];
    const plans = [planGoogleIdBackfill(db, USER, calendar), planGoogleIdBackfill(db, OTHER, calendar)];
    expect(plans.map((plan) => plan.links.map((link) => link.eventId))).toEqual([[mine], [theirs]]);

    const resolved = dropContestedLinks(plans);

    expect(resolved.map((plan) => plan.links)).toEqual([[], []]);
    expect(resolved.map((plan) => plan.counts.ambiguous)).toEqual([1, 1]);
    expect(resolved.map((plan) => plan.counts.linkableBySlot)).toEqual([0, 0]);
  });

  describe('the backup taken before an apply', () => {
    test('is a 0600 copy that opens, holds the same rows, and is never overwritten', () => {
      scenario();
      const dir = mkdtempSync(join(tmpdir(), 'hcb-backfill-'));
      try {
        const target = join(dir, 'before-backfill.db');

        createVerifiedBackup(db, target);

        expect(statSync(target).mode & 0o777).toBe(0o600);
        const copy = new Database(target, { readonly: true });
        expect(copy.query('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 10 });
        copy.close();
        expect(() => createVerifiedBackup(db, target)).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
