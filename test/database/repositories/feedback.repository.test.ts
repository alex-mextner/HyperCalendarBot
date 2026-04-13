import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { FeedbackRepository } from '../../../src/database/repositories/feedback.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function insertTestUser(db: Database, telegramId: number): void {
  db.run('INSERT OR IGNORE INTO users (telegram_id) VALUES (?)', [telegramId]);
}

describe('FeedbackRepository', () => {
  let db: Database;
  let repo: FeedbackRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new FeedbackRepository(db);
    insertTestUser(db, 123);
    insertTestUser(db, 456);
  });

  test('createThread inserts thread with open status and returns id', () => {
    const id = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Calendar not syncing',
    });

    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    const thread = repo.getThread(id);
    expect(thread).not.toBeNull();
    expect(thread!.user_id).toBe(123);
    expect(thread!.type).toBe('bug');
    expect(thread!.subject).toBe('Calendar not syncing');
    expect(thread!.status).toBe('open');
    expect(thread!.closed_at).toBeNull();
  });

  test('createThread stores chat_id when provided', () => {
    const id = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Group feedback',
      chat_id: -100999,
    });

    const thread = repo.getThread(id);
    expect(thread).not.toBeNull();
    expect(thread!.chat_id).toBe(-100999);
  });

  test('createThread stores topic_thread_id when provided', () => {
    const id = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Topic feedback',
      chat_id: -100999,
      topic_thread_id: 42,
    });

    const thread = repo.getThread(id);
    expect(thread).not.toBeNull();
    expect(thread!.topic_thread_id).toBe(42);
  });

  test('createThread defaults chat_id to null when not provided', () => {
    const id = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Private feedback',
    });

    const thread = repo.getThread(id);
    expect(thread).not.toBeNull();
    expect(thread!.chat_id).toBeNull();
  });

  test('getThread returns null for non-existent thread', () => {
    expect(repo.getThread(999)).toBeNull();
  });

  test('getOpenThreadForUser returns most recent open thread', () => {
    const threadId1 = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'First issue',
    });

    repo.createThread({
      user_id: 456,
      type: 'feature',
      subject: 'Other user issue',
    });

    const threadId2 = repo.createThread({
      user_id: 123,
      type: 'feature',
      subject: 'Second issue',
    });

    const openThread = repo.getOpenThreadForUser(123);
    expect(openThread).not.toBeNull();
    expect(openThread!.id).toBe(threadId2);
    expect(openThread!.subject).toBe('Second issue');
    expect(openThread!.status).toBe('open');

    // Verify the first thread is not returned
    expect(openThread!.id).not.toBe(threadId1);
  });

  test('getOpenThreadForUser returns null when no open thread', () => {
    const threadId = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Test issue',
    });

    repo.closeThread(threadId);

    const openThread = repo.getOpenThreadForUser(123);
    expect(openThread).toBeNull();
  });

  test('getOpenThreadForUser returns null when user has no threads', () => {
    expect(repo.getOpenThreadForUser(999)).toBeNull();
  });

  test('closeThread sets status to closed and closed_at timestamp', () => {
    const id = repo.createThread({
      user_id: 123,
      type: 'question',
      subject: 'How do I sync?',
    });

    repo.closeThread(id);

    const thread = repo.getThread(id);
    expect(thread).not.toBeNull();
    expect(thread!.status).toBe('closed');
    expect(thread!.closed_at).not.toBeNull();
  });

  test('addMessage inserts message and returns id', () => {
    const threadId = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Test',
    });

    const messageId = repo.addMessage({
      thread_id: threadId,
      sender: 'user',
      text: 'The calendar is broken',
    });

    expect(typeof messageId).toBe('number');
    expect(messageId).toBeGreaterThan(0);
  });

  test('addMessage with telegram_message_id', () => {
    const threadId = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Test',
    });

    repo.addMessage({
      thread_id: threadId,
      sender: 'admin',
      text: 'We are looking into this',
      telegram_message_id: 99999,
    });

    const messages = repo.getMessages(threadId);
    expect(messages.length).toBe(1);
    expect(messages[0]!.telegram_message_id).toBe(99999);
  });

  test('getMessages returns messages ordered by created_at ASC', () => {
    const threadId = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Test',
    });

    const msg1Id = repo.addMessage({
      thread_id: threadId,
      sender: 'user',
      text: 'First message',
    });

    const msg2Id = repo.addMessage({
      thread_id: threadId,
      sender: 'admin',
      text: 'Admin reply',
    });

    const msg3Id = repo.addMessage({
      thread_id: threadId,
      sender: 'user',
      text: 'Follow-up',
    });

    const messages = repo.getMessages(threadId);
    expect(messages.length).toBe(3);
    expect(messages[0]!.id).toBe(msg1Id);
    expect(messages[1]!.id).toBe(msg2Id);
    expect(messages[2]!.id).toBe(msg3Id);
    expect(messages[0]!.text).toBe('First message');
    expect(messages[1]!.text).toBe('Admin reply');
    expect(messages[2]!.text).toBe('Follow-up');
  });

  test('getMessages returns empty array for thread with no messages', () => {
    const threadId = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Test',
    });

    const messages = repo.getMessages(threadId);
    expect(messages).toEqual([]);
  });

  test('countOpenThreads counts only open threads for user', () => {
    repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Issue 1',
    });

    const threadId2 = repo.createThread({
      user_id: 123,
      type: 'feature',
      subject: 'Issue 2',
    });

    repo.createThread({
      user_id: 123,
      type: 'question',
      subject: 'Issue 3',
    });

    repo.closeThread(threadId2);

    const count = repo.countOpenThreads(123);
    expect(count).toBe(2);
  });

  test('countOpenThreads returns 0 for user with no threads', () => {
    expect(repo.countOpenThreads(999)).toBe(0);
  });

  test('countOpenThreads returns 0 for user with only closed threads', () => {
    const threadId = repo.createThread({
      user_id: 123,
      type: 'bug',
      subject: 'Test',
    });

    repo.closeThread(threadId);

    expect(repo.countOpenThreads(123)).toBe(0);
  });
});
