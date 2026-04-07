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

  test('findByName matches on preferred_name', () => {
    repo.add(USER_ID, '⚡𝓐𝓷𝓽𝓸𝓷⚡', 'tikididu', 173850803, 'Антон');
    const found = repo.findByName(USER_ID, 'Антон');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('⚡𝓐𝓷𝓽𝓸𝓷⚡');
    expect(found!.preferred_name).toBe('Антон');
  });

  test('findByName preferred_name is case-insensitive (Cyrillic)', () => {
    repo.add(USER_ID, 'Ivan', undefined, undefined, 'Вася');
    expect(repo.findByName(USER_ID, 'вася')).not.toBeNull();
    expect(repo.findByName(USER_ID, 'ВАСЯ')).not.toBeNull();
  });

  test('findByName name is case-insensitive (Cyrillic)', () => {
    repo.add(USER_ID, 'Антон');
    expect(repo.findByName(USER_ID, 'антон')).not.toBeNull();
  });

  test('upsert sets preferred_name on new contact', () => {
    const contact = repo.upsert(USER_ID, 'Vladimir', 'ikitheclaw', 999, 'Вова');
    expect(contact.preferred_name).toBe('Вова');
  });

  test('upsert does not overwrite existing preferred_name', () => {
    repo.add(USER_ID, 'Vladimir', 'ikitheclaw', 999, 'Вова');
    repo.upsert(USER_ID, 'Vladimir', 'ikitheclaw', 999, 'Volodya');
    const contact = repo.findByName(USER_ID, 'Vladimir');
    expect(contact!.preferred_name).toBe('Вова');
  });

  describe('findByName substring matching', () => {
    test('short form query finds full name (Лена → Елена)', () => {
      repo.add(USER_ID, 'Елена', 'elena_user', 111);
      const found = repo.findByName(USER_ID, 'Лена');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Елена');
    });

    test('full name query finds contact with short preferred_name (Елена → preferred Лена)', () => {
      repo.add(USER_ID, 'SomeTgName', 'lena_user', 222, 'Лена');
      const found = repo.findByName(USER_ID, 'Елена');
      expect(found).not.toBeNull();
      expect(found!.preferred_name).toBe('Лена');
    });

    test('exact match takes priority over substring match', () => {
      const exactContact = repo.add(USER_ID, 'Лена', 'lena_exact', 333);
      repo.add(USER_ID, 'Елена', 'elena_full', 444);
      const found = repo.findByName(USER_ID, 'Лена');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(exactContact.id);
    });

    test('short prefix query finds full name (Ал → Алексей)', () => {
      repo.add(USER_ID, 'Алексей', 'alex_user', 555);
      const found = repo.findByName(USER_ID, 'Ал');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Алексей');
    });

    test('substring match returns null when no contact matches', () => {
      repo.add(USER_ID, 'Вова', 'vova_user', 666);
      repo.add(USER_ID, 'Аня', 'anya_user', 777);
      expect(repo.findByName(USER_ID, 'Максим')).toBeNull();
    });

    test('substring match is case-insensitive', () => {
      repo.add(USER_ID, 'Елена');
      const found = repo.findByName(USER_ID, 'лена');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Елена');
    });

    test('preferred_name exact match takes priority over name substring', () => {
      repo.add(USER_ID, 'Елена', 'elena_user', 888);
      const preferred = repo.add(USER_ID, 'FancyName', 'fancy_user', 999, 'Лена');
      const found = repo.findByName(USER_ID, 'Лена');
      expect(found).not.toBeNull();
      // Exact match on preferred_name wins over substring of "Елена"
      expect(found!.id).toBe(preferred.id);
    });
  });

  test('contacts are isolated per user', () => {
    new UserRepository(db).create({ telegram_id: 200 });
    repo.add(USER_ID, 'Лена');
    repo.add(200, 'Лена');
    expect(repo.list(USER_ID).length).toBe(1);
    expect(repo.list(200).length).toBe(1);
  });
});
