import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';

// Deliberately synthetic data. No production user IDs, sessions or contact names.
describe('incident: contact identity and deletion boundaries', () => {
  let db: Database;
  let contacts: ContactRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      name TEXT NOT NULL, username TEXT, telegram_id INTEGER, preferred_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE UNIQUE INDEX idx_contacts_user_name ON contacts(user_id, LOWER(name));`);
    contacts = new ContactRepository(db);
  });
  afterEach(() => db.close());

  test('same name never silently merges two different Telegram identities', () => {
    const original = contacts.upsert(10, 'Alex', 'alex_one', 5000000001);
    assert.throws(() => contacts.upsert(10, 'Alex', 'alex_two', 5000000002), /CONTACT_IDENTITY_CONFLICT/);
    assert.equal(contacts.findByTelegramId(10, 5000000001)?.id, original.id);
    assert.equal(contacts.findByTelegramId(10, 5000000002), null);
    assert.equal(contacts.list(10).length, 1);
  });

  test('a username collision with a different ID is rejected', () => {
    contacts.upsert(10, 'First', 'shared_username', 5000000001);
    assert.throws(() => contacts.upsert(10, 'Second', 'shared_username', 5000000002), /CONTACT_IDENTITY_CONFLICT/);
    assert.equal(contacts.findByUsername(10, 'shared_username')?.telegram_id, 5000000001);
  });

  test('ID matching one row and username matching another never changes either row', () => {
    contacts.upsert(10, 'First', 'one', 5000000001);
    contacts.upsert(10, 'Second', 'two', 5000000002);
    assert.throws(() => contacts.upsert(10, 'First', 'two', 5000000001), /CONTACT_IDENTITY_CONFLICT/);
    assert.equal(contacts.findByTelegramId(10, 5000000001)?.username, 'one');
    assert.equal(contacts.findByTelegramId(10, 5000000002)?.username, 'two');
  });

  test('same-name unresolved contacts with contradictory usernames are not merged', () => {
    contacts.upsert(10, 'Alex', 'one');
    assert.throws(() => contacts.upsert(10, 'Alex', 'two', 5000000002), /CONTACT_IDENTITY_CONFLICT/);
    assert.equal(contacts.list(10)[0]?.telegram_id, null);
  });

  test('compatible enrichment fills the missing ID and is idempotent', () => {
    const original = contacts.upsert(10, 'Alex', 'known');
    const enriched = contacts.upsert(10, 'Alex', '@KNOWN', 5000000001);
    assert.equal(enriched.id, original.id);
    assert.equal(enriched.telegram_id, 5000000001);
    assert.equal(contacts.upsert(10, 'Alex', 'known', 5000000001).id, original.id);
    assert.equal(contacts.list(10).length, 1);
  });

  test('insert returns the inserted row, not a same-name Unicode-case predecessor', () => {
    const first = contacts.add(10, 'Алекс', 'one', 5000000001);
    const second = contacts.add(10, 'алекс', 'two', 5000000002);
    assert.notEqual(second.id, first.id);
    assert.equal(second.telegram_id, 5000000002);
  });

  test('new usernames are stored without @ and resolved case-insensitively', () => {
    const row = contacts.upsert(10, 'Alex', '@aLeX', 5000000001);
    assert.equal(contacts.findByUsername(10, 'ALEX')?.id, row.id);
    assert.equal(contacts.findByUsername(10, '@alex')?.id, row.id);
  });

  test('renaming username metadata preserves the established ID', () => {
    const row = contacts.upsert(10, 'Alex', 'oldname', 5000000001);
    contacts.update(row.id, { username: 'newname' });
    assert.equal(contacts.findByUsername(10, 'newname')?.telegram_id, 5000000001);
  });

  test('case-only username correction preserves the ID', () => {
    const row = contacts.upsert(10, 'Alex', 'oldname', 5000000001);
    contacts.update(row.id, { username: '@OLDNAME' });
    assert.equal(contacts.findByUsername(10, 'oldname')?.telegram_id, 5000000001);
  });

  test('deletion requires owner + contact primary key, and is idempotent', () => {
    const own = contacts.add(10, 'Own', undefined, 5000000001);
    const foreign = contacts.add(20, 'Foreign', undefined, 5000000002);
    assert.equal(contacts.deleteOwned(10, foreign.id), false);
    assert.equal(contacts.list(20).length, 1);
    assert.equal(contacts.deleteOwned(10, own.id), true);
    assert.equal(contacts.deleteOwned(10, own.id), false);
    assert.equal(contacts.list(10).length, 0);
  });
});
