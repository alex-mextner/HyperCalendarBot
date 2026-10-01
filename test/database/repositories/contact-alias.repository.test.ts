import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { ContactAliasRepository } from '../../../src/database/repositories/contact-alias.repository.ts';
import { ContactGroupRepository } from '../../../src/database/repositories/contact-group.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;
const OTHER_USER_ID = 200;

describe('ContactAliasRepository', () => {
  let db: Database;
  let repo: ContactAliasRepository;
  let contacts: ContactRepository;
  let groups: ContactGroupRepository;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    new UserRepository(db).create({ telegram_id: OTHER_USER_ID });
    repo = new ContactAliasRepository(db);
    contacts = new ContactRepository(db);
    groups = new ContactGroupRepository(db);
  });

  test('066_contact_directory backfills one primary alias per existing contact', () => {
    const contact = contacts.add(USER_ID, 'Lena');
    const aliases = repo.listForContact(USER_ID, contact.id);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]?.alias).toBe('Lena');
    expect(aliases[0]?.is_primary).toBe(1);
    expect(aliases[0]?.source).toBe('primary_name');
  });

  test('add creates a non-primary alias by default', () => {
    const contact = contacts.add(USER_ID, 'Lena');
    const alias = repo.add(USER_ID, contact.id, 'Lenka', 'manual');
    expect(alias.is_primary).toBe(0);
    expect(alias.source).toBe('manual');
    expect(repo.listForContact(USER_ID, contact.id).map((a) => a.alias)).toEqual(['Lena', 'Lenka']);
  });

  // Critical design fix: the original 066 draft made contact_aliases unique on
  // (user_id, LOWER(alias)) — a global-per-user constraint that reintroduced the exact bug
  // #654 set out to remove (idx_contacts_user_name blocking two different people sharing a
  // name). Two distinct contacts belonging to the SAME owner MUST be able to hold the same
  // alias/name; disambiguation happens at lookup time, not as a write-time rejection.
  test('two different contacts owned by the same user can share the same alias text', () => {
    const lena1 = contacts.add(USER_ID, 'Lena Ivanova');
    const lena2 = contacts.add(USER_ID, 'Lena Petrova');
    expect(() => repo.add(USER_ID, lena1.id, 'Лена', 'manual')).not.toThrow();
    expect(() => repo.add(USER_ID, lena2.id, 'Лена', 'manual')).not.toThrow();
    const holders = repo.findByAlias(USER_ID, 'Лена');
    expect(holders.map((a) => a.contact_id).sort()).toEqual([lena1.id, lena2.id].sort());
  });

  test('a single contact cannot hold the same alias twice (case-insensitive)', () => {
    const contact = contacts.add(USER_ID, 'Lena');
    repo.add(USER_ID, contact.id, 'Lenka', 'manual');
    expect(() => repo.add(USER_ID, contact.id, 'lenka', 'manual')).toThrow(/CONTACT_ALIAS_CONFLICT/);
  });

  // Critical fix (review finding): the exact-match namespace must be shared symmetrically with
  // contact_groups — group creation already rejected a name already used by a person alias, but
  // adding a person alias did not check the reverse, so it could be silently and permanently
  // shadowed by a same-named group at resolver exact-match time.
  test('adding an alias that already names a group is rejected', () => {
    groups.create(USER_ID, 'грюковы');
    const contact = contacts.add(USER_ID, 'Anna');
    expect(() => repo.add(USER_ID, contact.id, 'Грюковы', 'manual')).toThrow(/CONTACT_ALIAS_CONFLICT/);
  });

  test('findByAlias is case-insensitive and scoped to the owner', () => {
    const mine = contacts.add(USER_ID, 'Lena');
    const theirs = contacts.add(OTHER_USER_ID, 'Lena');
    repo.add(OTHER_USER_ID, theirs.id, 'Alias for other user', 'manual');
    const found = repo.findByAlias(USER_ID, 'lena');
    expect(found.map((a) => a.contact_id)).toEqual([mine.id]);
  });

  test('promote sets a new primary alias and clears the old one, syncing contacts.name', () => {
    const contact = contacts.add(USER_ID, 'Lena');
    const nickname = repo.add(USER_ID, contact.id, 'Lenka', 'manual');
    repo.promote(USER_ID, contact.id, nickname.id);
    const aliases = repo.listForContact(USER_ID, contact.id);
    const primary = aliases.find((a) => a.is_primary === 1);
    expect(primary?.alias).toBe('Lenka');
    expect(aliases.filter((a) => a.is_primary === 1)).toHaveLength(1);
    expect(contacts.findById(USER_ID, contact.id)?.name).toBe('Lenka');
  });

  // GH-654 confirmed blocker (parent's exact-head review of PR693): promote() mirrored the
  // promoted alias onto contacts.name but left contacts.preferred_name untouched. Every display
  // site (bot UI and AI tools) reads `preferred_name ?? name`, so a contact with a preferred_name
  // override kept showing the stale label after "make primary". Contract: the promoted alias
  // becomes the displayed primary label; a stale preferred_name is preserved as a plain alias
  // (not silently dropped) rather than merged into any other identity.
  test('promote clears a stale preferred_name and preserves it as a non-primary alias', () => {
    const contact = contacts.add(USER_ID, 'Elena Smirnova', undefined, undefined, 'Lenka');
    const nickname = repo.add(USER_ID, contact.id, 'Lenusik', 'manual');
    repo.promote(USER_ID, contact.id, nickname.id);
    const updated = contacts.findById(USER_ID, contact.id);
    expect(updated?.name).toBe('Lenusik');
    expect(updated?.preferred_name).toBeNull();
    const aliases = repo.listForContact(USER_ID, contact.id);
    const preserved = aliases.find((a) => a.alias === 'Lenka');
    expect(preserved?.is_primary).toBe(0);
  });

  test('promote does not duplicate an alias already matching the stale preferred_name', () => {
    const contact = contacts.add(USER_ID, 'Elena Smirnova', undefined, undefined, 'Lenka');
    repo.add(USER_ID, contact.id, 'Lenka', 'manual');
    const nickname = repo.add(USER_ID, contact.id, 'Lenusik', 'manual');
    repo.promote(USER_ID, contact.id, nickname.id);
    const aliases = repo.listForContact(USER_ID, contact.id);
    expect(aliases.filter((a) => a.alias === 'Lenka')).toHaveLength(1);
  });

  test('promoting the alias matching the current preferred_name just clears the override', () => {
    const contact = contacts.add(USER_ID, 'Elena Smirnova', undefined, undefined, 'Lenka');
    const nickname = repo.add(USER_ID, contact.id, 'Lenka', 'manual');
    repo.promote(USER_ID, contact.id, nickname.id);
    const updated = contacts.findById(USER_ID, contact.id);
    expect(updated?.preferred_name).toBeNull();
    const aliases = repo.listForContact(USER_ID, contact.id);
    expect(aliases.filter((a) => a.alias.toLowerCase() === 'lenka')).toHaveLength(1);
  });

  // Independent review finding: the auto-preserved alias must never land on a name a
  // contact_groups row already owns — that alias would be immediately and permanently shadowed at
  // exact-match resolution time, the same collision add() already refuses outright.
  test('promote drops the stale preferred_name instead of shadowing an existing group alias', () => {
    groups.create(USER_ID, 'Lenka');
    const contact = contacts.add(USER_ID, 'Elena Smirnova', undefined, undefined, 'Lenka');
    const nickname = repo.add(USER_ID, contact.id, 'Lenusik', 'manual');
    repo.promote(USER_ID, contact.id, nickname.id);
    const updated = contacts.findById(USER_ID, contact.id);
    expect(updated?.preferred_name).toBeNull();
    const aliases = repo.listForContact(USER_ID, contact.id);
    expect(aliases.some((a) => a.alias.toLowerCase() === 'lenka')).toBe(false);
  });

  test('promote refuses an alias belonging to another owner or contact', () => {
    const contact = contacts.add(USER_ID, 'Lena');
    const other = contacts.add(USER_ID, 'Vova');
    const otherAlias = repo.listForContact(USER_ID, other.id)[0]!;
    expect(() => repo.promote(USER_ID, contact.id, otherAlias.id)).toThrow(/CONTACT_ALIAS_NOT_FOUND/);
  });

  test('delete removes a non-primary alias', () => {
    const contact = contacts.add(USER_ID, 'Lena');
    const nickname = repo.add(USER_ID, contact.id, 'Lenka', 'manual');
    expect(repo.delete(USER_ID, contact.id, nickname.id)).toBe(true);
    expect(repo.listForContact(USER_ID, contact.id)).toHaveLength(1);
  });

  test('delete refuses to remove the current primary alias', () => {
    const contact = contacts.add(USER_ID, 'Lena');
    const primary = repo.listForContact(USER_ID, contact.id)[0]!;
    expect(() => repo.delete(USER_ID, contact.id, primary.id)).toThrow(/CONTACT_ALIAS_PRIMARY/);
    expect(repo.listForContact(USER_ID, contact.id)).toHaveLength(1);
  });

  test('delete is a no-op returning false for an alias outside the owner scope', () => {
    const theirs = contacts.add(OTHER_USER_ID, 'Lena');
    const theirAlias = repo.add(OTHER_USER_ID, theirs.id, 'Lenka', 'manual');
    expect(repo.delete(USER_ID, theirs.id, theirAlias.id)).toBe(false);
  });

  test('learning a confirmed fuzzy match records provenance', () => {
    const contact = contacts.add(USER_ID, 'Elena Larichkina');
    const alias = repo.add(USER_ID, contact.id, 'Ленка', 'confirmed_correction');
    expect(alias.source).toBe('confirmed_correction');
  });

  test('deleting a contact cascades its aliases', () => {
    const contact = contacts.add(USER_ID, 'Lena');
    repo.add(USER_ID, contact.id, 'Lenka', 'manual');
    contacts.delete(contact.id);
    expect(repo.listForContact(USER_ID, contact.id)).toEqual([]);
  });
});
