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

describe('ContactGroupRepository', () => {
  let db: Database;
  let repo: ContactGroupRepository;
  let contacts: ContactRepository;
  let aliases: ContactAliasRepository;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    new UserRepository(db).create({ telegram_id: OTHER_USER_ID });
    repo = new ContactGroupRepository(db);
    contacts = new ContactRepository(db);
    aliases = new ContactAliasRepository(db);
  });

  test('create makes an explicit collective alias', () => {
    const group = repo.create(USER_ID, 'грюковы');
    expect(group.alias).toBe('грюковы');
    expect(repo.listGroups(USER_ID).map((g) => g.id)).toEqual([group.id]);
  });

  test('create refuses a duplicate group alias for the same user', () => {
    repo.create(USER_ID, 'грюковы');
    expect(() => repo.create(USER_ID, 'Грюковы')).toThrow(/CONTACT_GROUP_ALIAS_CONFLICT/);
  });

  test('create refuses a group alias that collides with an existing person alias', () => {
    const contact = contacts.add(USER_ID, 'Lena');
    void aliases;
    expect(() => repo.create(USER_ID, 'Lena')).toThrow(/CONTACT_GROUP_ALIAS_CONFLICT/);
    void contact;
  });

  // Creating two contacts that happen to share an alias must NOT silently create a group —
  // collective membership is always explicit (#654 mission: "Don't auto-create shared group
  // merely because 2 contacts have same alias unless marked collective").
  test('two contacts sharing an alias does not implicitly create a group', () => {
    const lena1 = contacts.add(USER_ID, 'Lena Ivanova');
    const lena2 = contacts.add(USER_ID, 'Lena Petrova');
    aliases.add(USER_ID, lena1.id, 'Лена', 'manual');
    aliases.add(USER_ID, lena2.id, 'Лена', 'manual');
    expect(repo.listGroups(USER_ID)).toEqual([]);
    expect(repo.findByAlias(USER_ID, 'Лена')).toBeNull();
  });

  test('rename changes the group alias', () => {
    const group = repo.create(USER_ID, 'грюковы');
    repo.rename(USER_ID, group.id, 'семья Грюковых');
    expect(repo.findById(USER_ID, group.id)?.alias).toBe('семья Грюковых');
  });

  test("rename refuses landing on another group's alias", () => {
    repo.create(USER_ID, 'грюковы');
    const other = repo.create(USER_ID, 'ивановы');
    expect(() => repo.rename(USER_ID, other.id, 'Грюковы')).toThrow(/CONTACT_GROUP_ALIAS_CONFLICT/);
  });

  // GH-654 review finding: rename previously only checked other groups, not person aliases —
  // a group could be renamed onto an existing person's exact alias, leaving that person shadowed
  // at exact-match resolution (the resolver checks groups first).
  test('rename refuses landing on an existing person alias', () => {
    const group = repo.create(USER_ID, 'грюковы');
    contacts.add(USER_ID, 'Lena');
    expect(() => repo.rename(USER_ID, group.id, 'Lena')).toThrow(/CONTACT_GROUP_ALIAS_CONFLICT/);
    expect(repo.findById(USER_ID, group.id)?.alias).toBe('грюковы');
  });

  test('findByAlias is case-insensitive and owner-scoped', () => {
    repo.create(USER_ID, 'грюковы');
    repo.create(OTHER_USER_ID, 'грюковы');
    const found = repo.findByAlias(USER_ID, 'ГРЮКОВЫ');
    expect(found?.user_id).toBe(USER_ID);
  });

  test('addMember and listMembers return owned contacts only', () => {
    const group = repo.create(USER_ID, 'грюковы');
    const a = contacts.add(USER_ID, 'Anna Gryukova');
    const b = contacts.add(USER_ID, 'Boris Gryukov');
    repo.addMember(USER_ID, group.id, a.id);
    repo.addMember(USER_ID, group.id, b.id);
    const members = repo.listMembers(USER_ID, group.id);
    expect(members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  });

  test('addMember refuses a contact owned by a different user', () => {
    const group = repo.create(USER_ID, 'грюковы');
    const theirs = contacts.add(OTHER_USER_ID, 'Not mine');
    expect(() => repo.addMember(USER_ID, group.id, theirs.id)).toThrow(/CONTACT_GROUP_MEMBER_NOT_OWNED/);
  });

  test('removeMember removes membership without deleting the contact', () => {
    const group = repo.create(USER_ID, 'грюковы');
    const a = contacts.add(USER_ID, 'Anna Gryukova');
    repo.addMember(USER_ID, group.id, a.id);
    expect(repo.removeMember(USER_ID, group.id, a.id)).toBe(true);
    expect(repo.listMembers(USER_ID, group.id)).toEqual([]);
    expect(contacts.findById(USER_ID, a.id)).not.toBeNull();
  });

  test('delete removes the group and its memberships', () => {
    const group = repo.create(USER_ID, 'грюковы');
    const a = contacts.add(USER_ID, 'Anna Gryukova');
    repo.addMember(USER_ID, group.id, a.id);
    expect(repo.delete(USER_ID, group.id)).toBe(true);
    expect(repo.listGroups(USER_ID)).toEqual([]);
    expect(contacts.findById(USER_ID, a.id)).not.toBeNull();
  });

  test('groups are isolated per user', () => {
    repo.create(USER_ID, 'грюковы');
    expect(repo.listGroups(OTHER_USER_ID)).toEqual([]);
  });
});
