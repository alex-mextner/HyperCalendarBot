import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { ContactAliasRepository } from '../../../src/database/repositories/contact-alias.repository.ts';
import { ContactGroupRepository } from '../../../src/database/repositories/contact-group.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { ContactResolver } from '../../../src/services/contacts/contact-resolver.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;
const OTHER_USER_ID = 200;

describe('ContactResolver', () => {
  let db: Database;
  let contacts: ContactRepository;
  let aliases: ContactAliasRepository;
  let groups: ContactGroupRepository;
  let resolver: ContactResolver;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    new UserRepository(db).create({ telegram_id: OTHER_USER_ID });
    contacts = new ContactRepository(db);
    aliases = new ContactAliasRepository(db);
    groups = new ContactGroupRepository(db);
    resolver = new ContactResolver(contacts, aliases, groups);
  });

  test('unknown query resolves to none', () => {
    expect(resolver.resolve(USER_ID, 'Nobody')).toEqual({ kind: 'none' });
  });

  test('blank query resolves to none without touching the database', () => {
    expect(resolver.resolve(USER_ID, '   ')).toEqual({ kind: 'none' });
  });

  test('exact unique alias resolves directly, no question asked', () => {
    const contact = contacts.add(USER_ID, 'Elena Larichkina');
    aliases.add(USER_ID, contact.id, 'Ленка', 'manual');
    const result = resolver.resolve(USER_ID, 'Ленка');
    expect(result).toEqual({ kind: 'exact_unique', contact, matchedAlias: 'Ленка' });
  });

  test('exact primary-name match resolves directly', () => {
    const contact = contacts.add(USER_ID, 'Vova');
    expect(resolver.resolve(USER_ID, 'vova')).toEqual({ kind: 'exact_unique', contact, matchedAlias: 'Vova' });
  });

  // Critical design finding: two contacts owned by the same user sharing an exact alias/name
  // MUST require selection, never silently pick the first (#654 mission).
  test('two Lenas with the same primary alias require selection, not a silent pick', () => {
    const lena1 = contacts.add(USER_ID, 'Лена');
    const lena2 = contacts.add(USER_ID, 'Другая Лена');
    aliases.add(USER_ID, lena2.id, 'Лена', 'manual');
    const result = resolver.resolve(USER_ID, 'Лена');
    expect(result.kind).toBe('exact_ambiguous');
    if (result.kind !== 'exact_ambiguous') throw new Error('unreachable');
    expect(result.candidates.map((c) => c.contact.id).sort()).toEqual([lena1.id, lena2.id].sort());
  });

  test('two Lenas owned by different users are isolated — each resolves uniquely within its own owner', () => {
    contacts.add(USER_ID, 'Лена');
    contacts.add(OTHER_USER_ID, 'Лена');
    const mine = resolver.resolve(USER_ID, 'Лена');
    const theirs = resolver.resolve(OTHER_USER_ID, 'Лена');
    expect(mine.kind).toBe('exact_unique');
    expect(theirs.kind).toBe('exact_unique');
    if (mine.kind !== 'exact_unique' || theirs.kind !== 'exact_unique') throw new Error('unreachable');
    expect(mine.contact.id).not.toBe(theirs.contact.id);
  });

  test('fuzzy match with exactly one candidate still requires confirmation', () => {
    contacts.add(USER_ID, 'Елена');
    const result = resolver.resolve(USER_ID, 'Лена');
    expect(result.kind).toBe('fuzzy_confirm');
    if (result.kind !== 'fuzzy_confirm') throw new Error('unreachable');
    expect(result.candidates).toHaveLength(1);
  });

  test('confirming a fuzzy match learns the alias with provenance', () => {
    const contact = contacts.add(USER_ID, 'Елена');
    resolver.resolve(USER_ID, 'Лена');
    resolver.confirmFuzzyMatch(USER_ID, contact.id, 'Лена');
    const learned = aliases.listForContact(USER_ID, contact.id).find((a) => a.alias === 'Лена');
    expect(learned?.source).toBe('confirmed_correction');
    // Learned alias now resolves exactly next time — no repeat fuzzy confirmation.
    expect(resolver.resolve(USER_ID, 'Лена')).toEqual({ kind: 'exact_unique', contact, matchedAlias: 'Лена' });
  });

  test('confirming an already-known alias is a harmless no-op', () => {
    const contact = contacts.add(USER_ID, 'Vova');
    expect(() => resolver.confirmFuzzyMatch(USER_ID, contact.id, 'Vova')).not.toThrow();
  });

  // "Настолки у грюковых" example: an explicit collective alias expands to every member with
  // no per-person confirmation once the group alias itself matches exactly.
  test('an explicit collective alias expands to every member, no per-person confirmation', () => {
    const anna = contacts.add(USER_ID, 'Anna Gryukova');
    const boris = contacts.add(USER_ID, 'Boris Gryukov');
    const group = groups.create(USER_ID, 'грюковы');
    groups.addMember(USER_ID, group.id, anna.id);
    groups.addMember(USER_ID, group.id, boris.id);
    const result = resolver.resolve(USER_ID, 'грюковы');
    expect(result.kind).toBe('exact_group');
    if (result.kind !== 'exact_group') throw new Error('unreachable');
    expect(result.members.map((m) => m.id).sort()).toEqual([anna.id, boris.id].sort());
  });

  // Two contacts merely sharing an alias is a duplicate-name collision, NOT a collective group —
  // it must resolve as exact_ambiguous, never silently expand as if it were a group.
  test('two contacts sharing an alias without an explicit group stays an ambiguous pick, never a silent group expansion', () => {
    const lena1 = contacts.add(USER_ID, 'Lena Ivanova');
    const lena2 = contacts.add(USER_ID, 'Lena Petrova');
    aliases.add(USER_ID, lena1.id, 'Лена', 'manual');
    aliases.add(USER_ID, lena2.id, 'Лена', 'manual');
    const result = resolver.resolve(USER_ID, 'Лена');
    expect(result.kind).toBe('exact_ambiguous');
  });

  test('group alias takes precedence over a coincidentally matching fuzzy person name', () => {
    const group = groups.create(USER_ID, 'грюковы');
    const result = resolver.resolve(USER_ID, 'грюковы');
    expect(result).toEqual({ kind: 'exact_group', group, members: [] });
  });
});
