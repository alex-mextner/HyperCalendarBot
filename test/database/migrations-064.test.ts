// Migration 064 records which group chat's card carried a member's answer. It ships after 065, which
// production already applied, and only adds columns: every existing answer keeps its values and has no
// known origin, and the statements of the image before it keep working on the migrated table.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { ParticipantRepository } from '../../src/database/repositories/participant.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { addAsPre064Image, answerAsPre064Image } from '../helpers/pre-064-image.ts';

const MIGRATION = '064_event_participant_source_group';
const before = migrations.slice(
  0,
  migrations.findIndex((migration) => migration.name === MIGRATION),
);

function answers(db: Database) {
  return db
    .query('SELECT id, event_id, user_id, status, role, created_at, updated_at FROM event_participants ORDER BY id')
    .all();
}

function ledger(db: Database) {
  return db.query<{ name: string }, []>('SELECT name FROM migrations ORDER BY id').all();
}

test('runs once after the already applied 065 and leaves every existing answer without a known origin', () => {
  const db = new Database(':memory:');
  runMigrations(db, before);
  const eventId = new EventRepository(db).create({
    user_id: 100,
    title: 'Dinner',
    start_at: '2031-01-01T10:00:00.000Z',
    timezone: 'UTC',
  }).id;
  addAsPre064Image(db, eventId, 301, 'accepted');
  addAsPre064Image(db, eventId, 302, 'declined');
  const answersBefore = answers(db);
  const ledgerBefore = ledger(db);
  expect(ledgerBefore.at(-1)).toEqual({ name: '065_intent_revisions' });

  runMigrations(db, migrations);
  runMigrations(db, migrations);

  expect(ledger(db)).toEqual([
    ...ledgerBefore,
    ...migrations.slice(before.length).map((migration) => ({ name: migration.name })),
  ]);
  expect(answers(db)).toEqual(answersBefore);
  const participants = new ParticipantRepository(db);
  expect(participants.getByEvent(eventId).map((row) => row.source_group_id)).toEqual([null, null]);
});

test('the image before 064 can still add and answer on the migrated table, recording no origin', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const eventId = new EventRepository(db).create({
    user_id: 100,
    title: 'Dinner',
    start_at: '2031-01-01T10:00:00.000Z',
    timezone: 'UTC',
  }).id;

  addAsPre064Image(db, eventId, 301, 'pending');
  answerAsPre064Image(db, eventId, 301, 'maybe');

  expect(new ParticipantRepository(db).findByEventAndUser(eventId, 301)).toMatchObject({
    status: 'maybe',
    source_group_id: null,
  });
});
