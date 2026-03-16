import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('ContactRepository', () => {
  let db: Database;
  let repo: ContactRepository;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    repo = new ContactRepository(db);
  });

  test('list returns empty array when no contacts', () => {
    expect(repo.list(USER_ID)).toEqual([]);
  });

  test('add creates a contact and findByName retrieves it', () => {
    const contact = repo.add(USER_ID, 'Лена', 'larichkina_b', 716928723);
    expect(contact.name).toBe('Лена');
    expect(contact.username).toBe('larichkina_b');
    expect(contact.telegram_id).toBe(716928723);

    const found = repo.findByName(USER_ID, 'Лена');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(contact.id);
  });

  test('findByName is case-insensitive for ASCII', () => {
    repo.add(USER_ID, 'Elena');
    expect(repo.findByName(USER_ID, 'elena')).not.toBeNull();
  });

  test('findByName returns null for unknown name', () => {
    expect(repo.findByName(USER_ID, 'Nobody')).toBeNull();
  });

  test('list returns all contacts sorted by name', () => {
    repo.add(USER_ID, 'Вова');
    repo.add(USER_ID, 'Аня');
    const contacts = repo.list(USER_ID);
    expect(contacts.length).toBe(2);
    expect(contacts[0]!.name).toBe('Аня');
    expect(contacts[1]!.name).toBe('Вова');
  });

  test('update changes specified fields', () => {
    const contact = repo.add(USER_ID, 'Вова');
    repo.update(contact.id, { username: 'vova123', telegram_id: 999 });
    const updated = repo.findByName(USER_ID, 'Вова');
    expect(updated!.username).toBe('vova123');
    expect(updated!.telegram_id).toBe(999);
  });

  test('delete removes contact', () => {
    const contact = repo.add(USER_ID, 'Вова');
    repo.delete(contact.id);
    expect(repo.findByName(USER_ID, 'Вова')).toBeNull();
  });

  test('upsert creates new contact when none match', () => {
    const contact = repo.upsert(USER_ID, 'Вова', 'vova123', 999);
    expect(contact.name).toBe('Вова');
    expect(contact.username).toBe('vova123');
    expect(repo.list(USER_ID).length).toBe(1);
  });

  test('upsert deduplicates by telegram_id', () => {
    repo.add(USER_ID, 'Лена', 'larichkina_b', 716928723);
    repo.upsert(USER_ID, 'Elena', 'larichkina_b', 716928723);
    // Should NOT create duplicate — same telegram_id
    expect(repo.list(USER_ID).length).toBe(1);
  });

  test('upsert deduplicates by username', () => {
    repo.add(USER_ID, 'Лена', 'larichkina_b');
    repo.upsert(USER_ID, 'Elena', 'larichkina_b', 716928723);
    // Should update existing, not create new
    const contacts = repo.list(USER_ID);
    expect(contacts.length).toBe(1);
    expect(contacts[0]!.telegram_id).toBe(716928723);
  });

  test('upsert fills missing username on existing contact', () => {
    repo.add(USER_ID, 'Вова');
    repo.upsert(USER_ID, 'Вова', 'vova123', 999);
    const contact = repo.findByName(USER_ID, 'Вова');
    expect(contact!.username).toBe('vova123');
    expect(contact!.telegram_id).toBe(999);
  });

  test('findByTelegramId returns correct contact', () => {
    repo.add(USER_ID, 'Лена', 'larichkina_b', 716928723);
    const contact = repo.findByTelegramId(USER_ID, 716928723);
    expect(contact).not.toBeNull();
    expect(contact!.name).toBe('Лена');
  });

  test('findByUsername is case-insensitive and strips @', () => {
    repo.add(USER_ID, 'Лена', 'LarichKina_b');
    expect(repo.findByUsername(USER_ID, '@larichkina_b')).not.toBeNull();
  });

  test('contacts are isolated per user', () => {
    new UserRepository(db).create({ telegram_id: 200 });
    repo.add(USER_ID, 'Лена');
    repo.add(200, 'Лена');
    expect(repo.list(USER_ID).length).toBe(1);
    expect(repo.list(200).length).toBe(1);
  });
});
