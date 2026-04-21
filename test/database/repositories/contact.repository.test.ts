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

  describe('findByName fuzzy matching', () => {
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

    test('exact match takes priority over fuzzy match', () => {
      const exactContact = repo.add(USER_ID, 'Лена', 'lena_exact', 333);
      repo.add(USER_ID, 'Елена', 'elena_full', 444);
      const found = repo.findByName(USER_ID, 'Лена');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(exactContact.id);
    });

    test('returns null when edit distance exceeds threshold (Ал → Алексей)', () => {
      // "ал" (2) vs "алексей" (7): dist 5, maxLen 7, maxEdit(7)=2 → rejected
      repo.add(USER_ID, 'Алексей', 'alex_user', 555);
      expect(repo.findByName(USER_ID, 'Ал')).toBeNull();
    });

    test('returns null when no contact is similar enough', () => {
      repo.add(USER_ID, 'Вова', 'vova_user', 666);
      repo.add(USER_ID, 'Аня', 'anya_user', 777);
      expect(repo.findByName(USER_ID, 'Максим')).toBeNull();
    });

    test('fuzzy match is case-insensitive', () => {
      repo.add(USER_ID, 'Елена');
      const found = repo.findByName(USER_ID, 'лена');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Елена');
    });

    test('preferred_name exact match takes priority over name fuzzy match', () => {
      repo.add(USER_ID, 'Елена', 'elena_user', 888);
      const preferred = repo.add(USER_ID, 'FancyName', 'fancy_user', 999, 'Лена');
      const found = repo.findByName(USER_ID, 'Лена');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(preferred.id);
    });
  });

  describe('searchByName', () => {
    test('returns empty array for empty query', () => {
      repo.add(USER_ID, 'Лена');
      expect(repo.searchByName(USER_ID, '')).toEqual([]);
    });

    test('returns empty array when nothing is similar enough', () => {
      repo.add(USER_ID, 'Вова');
      expect(repo.searchByName(USER_ID, 'Максим')).toEqual([]);
    });

    test('scores exact match at 1.0', () => {
      repo.add(USER_ID, 'Лена');
      const results = repo.searchByName(USER_ID, 'Лена');
      expect(results.length).toBe(1);
      expect(results[0]!.confidence).toBe(1);
    });

    test('scores exact match case-insensitively', () => {
      repo.add(USER_ID, 'Елена');
      const results = repo.searchByName(USER_ID, 'елена');
      expect(results[0]!.confidence).toBe(1);
    });

    test('phonetic normalization collapses ё and е (capped at 0.99)', () => {
      repo.add(USER_ID, 'Алёна');
      const results = repo.searchByName(USER_ID, 'Алена');
      expect(results.length).toBe(1);
      // Not strict-equal (ё !== е) but phonetic-equal → capped below 1
      expect(results[0]!.confidence).toBe(0.99);
    });

    test('phonetic normalization collapses voiced/voiceless pairs (capped at 0.99)', () => {
      // З → С in phoneticNormalize, so "Зарема" and "Сарема" become identical.
      repo.add(USER_ID, 'Зарема');
      const results = repo.searchByName(USER_ID, 'Сарема');
      expect(results.length).toBe(1);
      expect(results[0]!.confidence).toBe(0.99);
    });

    test('strict trim+lowerCase equality scores 1.0 even with whitespace/case', () => {
      repo.add(USER_ID, 'Лена');
      expect(repo.searchByName(USER_ID, '  Лена  ')[0]!.confidence).toBe(1);
      expect(repo.searchByName(USER_ID, 'ЛЕНА')[0]!.confidence).toBe(1);
    });

    test('strict match wins over phonetic tie (Вова typed as Вова, not Фофа)', () => {
      repo.add(USER_ID, 'Вова');
      repo.add(USER_ID, 'Фофа');
      const results = repo.searchByName(USER_ID, 'Вова');
      expect(results.length).toBe(2);
      expect(results[0]!.contact.name).toBe('Вова');
      expect(results[0]!.confidence).toBe(1);
      expect(results[1]!.contact.name).toBe('Фофа');
      expect(results[1]!.confidence).toBe(0.99);
    });

    test('single-edit mismatch scores below 1 but above threshold (Лена → Елена)', () => {
      repo.add(USER_ID, 'Елена');
      const results = repo.searchByName(USER_ID, 'Лена');
      expect(results.length).toBe(1);
      // lev=1, maxLen=5 → 1 - 1/5 = 0.8
      expect(results[0]!.confidence).toBeCloseTo(0.8, 5);
    });

    test('rejects matches beyond edit-distance threshold', () => {
      // "Ал" (2 chars) vs "Алексей" (7): 5 edits, allowed max is 2 → no match
      repo.add(USER_ID, 'Алексей');
      expect(repo.searchByName(USER_ID, 'Ал')).toEqual([]);
    });

    test('returns multiple matches ranked by confidence', () => {
      repo.add(USER_ID, 'Лена', 'lena_exact');
      repo.add(USER_ID, 'Елена', 'elena_full');
      repo.add(USER_ID, 'Олена', 'olena');
      const results = repo.searchByName(USER_ID, 'Лена');
      expect(results.length).toBe(3);
      expect(results[0]!.contact.name).toBe('Лена');
      expect(results[0]!.confidence).toBe(1);
      // Both "Елена" and "Олена" are one insertion away from "Лена" → tie at 0.8
      expect(results[1]!.confidence).toBeCloseTo(0.8, 5);
      expect(results[2]!.confidence).toBeCloseTo(0.8, 5);
    });

    test('uses the best of name and preferred_name for scoring', () => {
      repo.add(USER_ID, 'FancyName', 'fancy', 1, 'Лена');
      const results = repo.searchByName(USER_ID, 'Лена');
      expect(results.length).toBe(1);
      expect(results[0]!.confidence).toBe(1);
    });

    test('does not return contacts of other users', () => {
      new UserRepository(db).create({ telegram_id: 200 });
      repo.add(USER_ID, 'Лена');
      repo.add(200, 'Лена');
      const results = repo.searchByName(USER_ID, 'Лена');
      expect(results.length).toBe(1);
    });

    test('ordering is stable for ties by name ascending', () => {
      repo.add(USER_ID, 'Олена');
      repo.add(USER_ID, 'Елена');
      const results = repo.searchByName(USER_ID, 'Лена');
      expect(results.length).toBe(2);
      expect(results[0]!.confidence).toBeCloseTo(0.8, 5);
      expect(results[1]!.confidence).toBeCloseTo(0.8, 5);
      expect(results[0]!.contact.name).toBe('Елена');
      expect(results[1]!.contact.name).toBe('Олена');
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
