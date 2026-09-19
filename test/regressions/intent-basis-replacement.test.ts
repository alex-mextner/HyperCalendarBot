import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';
import {
  applySeedReplacement,
  type CanonicalSeed,
  intentRows,
  planSeedReplacement,
} from '../../src/services/intent/seed-replacement.ts';
import { WorkflowSchema } from '../../src/services/intent/workflow-schema.ts';

let db: Database;
let directory: string;
const seed: CanonicalSeed[] = [
  {
    canonical_name: 'basis.help',
    pattern: '^(?:помощь|help)$',
    phrases: ['помощь', 'help'],
    trigger_words: ['помощь', 'help'],
    source_message: 'помощь',
    workflow: { version: 2, steps: [{ call: 'get_bot_info', input: {} }] },
  },
];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'intent-basis-'));
  db = new Database(join(directory, 'live.db'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  runMigrations(db, migrations);
  db.run('INSERT INTO intents(canonical_name,workflow,status) VALUES(?,?,?)', ['old-invalid', '{}', 'approved']);
  db.run('INSERT INTO users(telegram_id) VALUES (?)', [1001]);
  db.run('INSERT INTO events(user_id,title,start_at,timezone) VALUES(?,?,?,?)', [
    1001,
    'Synthetic unchanged event',
    '2035-01-01T12:00:00Z',
    'UTC',
  ]);
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function backup(): string {
  const path = join(directory, 'before.db');
  db.query('VACUUM INTO ?').run(path);
  return path;
}
test('one atomic replacement removes old definitions, preserves other tables and archives original IDs', () => {
  const plan = planSeedReplacement(db, seed);
  const saved = backup();
  const before = db.query('SELECT * FROM events').all();
  const result = applySeedReplacement(db, seed, plan, saved);
  expect(result.status).toBe('replaced');
  expect(intentRows(db).map((r) => r.canonical_name)).toEqual(['basis.help']);
  expect(db.query('SELECT * FROM events').all()).toEqual(before);
  const archive = new Database(saved, { readonly: true });
  expect(intentRows(archive)[0]?.canonical_name).toBe('old-invalid');
  archive.close();
  expect(applySeedReplacement(db, seed, plan, saved).status).toBe('already_installed');
});
test('changed definition after planning refuses replacement', () => {
  const plan = planSeedReplacement(db, seed);
  const saved = backup();
  db.run('UPDATE intents SET phrases=?', ['["new unreviewed example"]']);
  expect(() => applySeedReplacement(db, seed, plan, saved)).toThrow('changed');
  expect(intentRows(db)[0]?.canonical_name).toBe('old-invalid');
});
test('pending workflow cannot have its saved definition silently replaced', () => {
  const plan = planSeedReplacement(db, seed);
  const saved = backup();
  db.run('INSERT INTO workflow_sessions VALUES(?,?,?,?)', [1001, 1001, '{}', Date.now()]);
  expect(() => applySeedReplacement(db, seed, plan, saved)).toThrow('active workflow');
  expect(intentRows(db)).toHaveLength(1);
});
test('invalid v2 seed, wrong backup and unreviewed triggers fail before deletion', () => {
  expect(() =>
    planSeedReplacement(db, [{ ...seed[0]!, workflow: { version: 2, steps: [{ call: 'made_up', input: {} }] } }]),
  ).toThrow();
  const plan = planSeedReplacement(db, seed);
  const saved = backup();
  const archive = new Database(saved);
  archive.exec('DELETE FROM intents');
  archive.close();
  expect(() => applySeedReplacement(db, seed, plan, saved)).toThrow('backup');
  db.exec('CREATE TRIGGER malicious AFTER DELETE ON intents BEGIN DELETE FROM events; END;');
  expect(() => applySeedReplacement(db, seed, plan, saved)).toThrow();
  expect(db.query('SELECT * FROM events').all()).toHaveLength(1);
});
test('source-managed catalogue rejects old admin and learner mutation paths', async () => {
  const { IntentRepository } = await import('../../src/database/repositories/intent.repository.ts');
  const plan = planSeedReplacement(db, seed);
  const saved = backup();
  applySeedReplacement(db, seed, plan, saved);
  const repository = new IntentRepository(db, seed);
  expect(repository.isManagedBasis()).toBe(true);
  expect(repository.getApproved()).toHaveLength(1);
  const row = intentRows(db)[0]!;
  expect(() => repository.updateStatus(row.id, 'rejected')).toThrow('INTENT_BASIS_READ_ONLY');
  expect(() => repository.appendPhrases(row.id, ['unsafe new alias'])).toThrow('INTENT_BASIS_READ_ONLY');
  expect(() => repository.update(row.id, { workflow: '{}' })).toThrow('INTENT_BASIS_READ_ONLY');
  expect(() =>
    repository.create({ ...seed[0]!, workflow: WorkflowSchema.parse(seed[0]!.workflow), format: 'text' }),
  ).toThrow('INTENT_BASIS_READ_ONLY');
  expect(repository.getApproved()).toHaveLength(1);
  db.run('UPDATE intents SET phrases=?', ['["unreviewed"]']);
  expect(repository.getApproved()).toHaveLength(0);
});
test('malformed old JSON can be archived and replaced, not interpreted', () => {
  db.run('UPDATE intents SET workflow=?', ['not JSON']);
  const plan = planSeedReplacement(db, seed);
  const saved = backup();
  expect(applySeedReplacement(db, seed, plan, saved).status).toBe('replaced');
});
test('stale source revision cannot load an otherwise approved managed basis', async () => {
  const { IntentRepository } = await import('../../src/database/repositories/intent.repository.ts');
  const plan = planSeedReplacement(db, seed);
  applySeedReplacement(db, seed, plan, backup());
  const other = [{ ...seed[0]!, phrases: ['помощь', 'help', 'changed'] }];
  expect(new IntentRepository(db, other).getApproved()).toHaveLength(0);
});
test('new unrelated user writes made before replacement survive; stale backup is never restored', () => {
  const plan = planSeedReplacement(db, seed);
  const saved = backup();
  db.run('UPDATE events SET title=?', ['Created or edited after backup']);
  expect(applySeedReplacement(db, seed, plan, saved).status).toBe('replaced');
  expect(db.query<{ title: string }, []>('SELECT title FROM events').get()?.title).toBe(
    'Created or edited after backup',
  );
});
test('expired sessions do not block replacement and are not rewritten', () => {
  db.run('INSERT INTO workflow_sessions VALUES(?,?,?,?)', [1001, 1001, '{"expired":true}', Date.now() - 600001]);
  const plan = planSeedReplacement(db, seed);
  const saved = backup();
  const sessions = db.query('SELECT * FROM workflow_sessions').all();
  expect(applySeedReplacement(db, seed, plan, saved).status).toBe('replaced');
  expect(db.query('SELECT * FROM workflow_sessions').all()).toEqual(sessions);
});
test('an unexpected reference to legacy intent IDs prevents deletion', () => {
  db.exec('CREATE TABLE external_intent_consumer (intent_id INTEGER REFERENCES intents(id))');
  const plan = planSeedReplacement(db, seed);
  const saved = backup();
  expect(() => applySeedReplacement(db, seed, plan, saved)).toThrow('Foreign-key');
  expect(intentRows(db)[0]?.canonical_name).toBe('old-invalid');
});
