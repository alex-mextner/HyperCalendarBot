import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { Workflow } from '../../../src/services/intent/workflow-schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

/** Minimal valid Workflow for tests that don't care about workflow content. */
const stubWorkflow: Workflow = {
  tools: [{ name: 'get_events', input: { start_date: '{{today}}', end_date: '{{today}}' } }],
};

describe('IntentRepository', () => {
  let db: Database;
  let repo: IntentRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new IntentRepository(db);
  });

  test('create inserts intent with pending status and returns id', () => {
    const id = repo.create({
      canonical_name: 'schedule_meeting',
      phrases: ['schedule meeting', 'set up call'],
      trigger_words: ['schedule', 'meeting'],
      workflow: stubWorkflow,
      format: 'text',
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    const intent = repo.getById(id);
    expect(intent).not.toBeNull();
    expect(intent!.canonical_name).toBe('schedule_meeting');
    expect(intent!.status).toBe('pending');
  });

  test('create serializes phrases and trigger_words as JSON', () => {
    const id = repo.create({
      canonical_name: 'test_intent',
      phrases: ['phrase1', 'phrase2'],
      trigger_words: ['word1', 'word2'],
      workflow: stubWorkflow,
      format: 'text',
    });

    const intent = repo.getById(id);
    expect(intent).not.toBeNull();
    expect(JSON.parse(intent!.phrases)).toEqual(['phrase1', 'phrase2']);
    expect(JSON.parse(intent!.trigger_words)).toEqual(['word1', 'word2']);
  });

  test('create serializes workflow as JSON', () => {
    const workflow: Workflow = {
      steps: [{ call: 'get_events', input: { start_date: '{{today}}', end_date: '{{today}}' } }],
    };
    const id = repo.create({
      canonical_name: 'workflow_test',
      phrases: ['test'],
      workflow,
      format: 'text',
    });

    const intent = repo.getById(id);
    expect(JSON.parse(intent!.workflow)).toEqual(workflow);
  });

  test('getById returns null for non-existent intent', () => {
    expect(repo.getById(999)).toBeNull();
  });

  test('getApproved returns only approved intents', () => {
    repo.create({
      canonical_name: 'pending_intent',
      phrases: ['test'],
      workflow: stubWorkflow,
      format: 'text',
    });

    const approvedId = repo.create({
      canonical_name: 'approved_intent',
      phrases: ['test'],
      workflow: stubWorkflow,
      format: 'text',
    });

    repo.updateStatus(approvedId, 'approved');

    const approved = repo.getApproved();
    expect(approved.length).toBe(1);
    expect(approved[0]!.canonical_name).toBe('approved_intent');
    expect(approved[0]!.status).toBe('approved');
  });

  test('updateStatus changes intent status', () => {
    const id = repo.create({
      canonical_name: 'status_test',
      phrases: ['test'],
      workflow: stubWorkflow,
      format: 'text',
    });

    repo.updateStatus(id, 'approved');
    let intent = repo.getById(id);
    expect(intent!.status).toBe('approved');

    repo.updateStatus(id, 'rejected');
    intent = repo.getById(id);
    expect(intent!.status).toBe('rejected');
  });

  test('appendPhrases adds new phrases without duplicates', () => {
    const id = repo.create({
      canonical_name: 'phrase_test',
      phrases: ['phrase1', 'phrase2'],
      workflow: stubWorkflow,
      format: 'text',
    });

    repo.appendPhrases(id, ['phrase2', 'phrase3', 'phrase4']);

    const intent = repo.getById(id);
    const phrases = JSON.parse(intent!.phrases) as string[];
    expect(phrases).toEqual(['phrase1', 'phrase2', 'phrase3', 'phrase4']);
  });

  test('appendPhrases handles empty existing phrases', () => {
    const id = repo.create({
      canonical_name: 'empty_phrases',
      phrases: [],
      workflow: stubWorkflow,
      format: 'text',
    });

    repo.appendPhrases(id, ['new1', 'new2']);

    const intent = repo.getById(id);
    const phrases = JSON.parse(intent!.phrases) as string[];
    expect(phrases).toEqual(['new1', 'new2']);
  });

  test('findByCanonicalName returns intent or null', () => {
    repo.create({
      canonical_name: 'unique_name',
      phrases: ['test'],
      workflow: stubWorkflow,
      format: 'text',
    });

    const found = repo.findByCanonicalName('unique_name');
    expect(found).not.toBeNull();
    expect(found!.canonical_name).toBe('unique_name');

    const notFound = repo.findByCanonicalName('non_existent');
    expect(notFound).toBeNull();
  });

  test('update modifies specific fields', () => {
    const id = repo.create({
      canonical_name: 'update_test',
      phrases: ['old1'],
      trigger_words: ['old_word'],
      pattern: 'old_pattern',
      workflow: stubWorkflow,
      format: 'text',
    });

    repo.update(id, {
      phrases: ['new1', 'new2'],
      trigger_words: ['new_word1', 'new_word2'],
      pattern: 'new_pattern',
      format: 'html',
    });

    const intent = repo.getById(id);
    expect(JSON.parse(intent!.phrases)).toEqual(['new1', 'new2']);
    expect(JSON.parse(intent!.trigger_words)).toEqual(['new_word1', 'new_word2']);
    expect(intent!.pattern).toBe('new_pattern');
    expect(intent!.format).toBe('html');
  });

  test('update preserves unchanged fields', () => {
    const originalWorkflow: Workflow = {
      steps: [{ call: 'get_events', input: { start_date: '{{today}}', end_date: '{{today}}' } }],
    };
    const id = repo.create({
      canonical_name: 'preserve_test',
      phrases: ['original'],
      workflow: originalWorkflow,
      format: 'json',
    });

    repo.update(id, {
      phrases: ['updated'],
    });

    const intent = repo.getById(id);
    expect(JSON.parse(intent!.phrases)).toEqual(['updated']);
    expect(JSON.parse(intent!.workflow)).toEqual(originalWorkflow);
    expect(intent!.format).toBe('json');
  });
});
