import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { ContactGroupRepository } from '../../../src/database/repositories/contact-group.repository.ts';
import { PlaceRepository } from '../../../src/database/repositories/place.repository.ts';
import { PlaceRoleRepository } from '../../../src/database/repositories/place-role.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('PlaceRoleRepository', () => {
  let db: Database;
  let repo: PlaceRoleRepository;
  let places: PlaceRepository;
  let contacts: ContactRepository;
  let groups: ContactGroupRepository;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    repo = new PlaceRoleRepository(db);
    places = new PlaceRepository(db);
    contacts = new ContactRepository(db);
    groups = new ContactGroupRepository(db);
  });

  test("set links the owner's own home", () => {
    const home = places.create(USER_ID, { label: 'Моя квартира' });
    repo.set(USER_ID, 'home', { ownerType: 'self' }, home.id);
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'self' })?.id).toBe(home.id);
  });

  test('work is independent of home', () => {
    const home = places.create(USER_ID, { label: 'Дом' });
    const work = places.create(USER_ID, { label: 'Офис' });
    repo.set(USER_ID, 'home', { ownerType: 'self' }, home.id);
    repo.set(USER_ID, 'work', { ownerType: 'self' }, work.id);
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'self' })?.id).toBe(home.id);
    expect(repo.getPlace(USER_ID, 'work', { ownerType: 'self' })?.id).toBe(work.id);
  });

  test('unset role resolves to null, never guesses', () => {
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'self' })).toBeNull();
  });

  test('set replaces a previous link instead of creating a second row', () => {
    const first = places.create(USER_ID, { label: 'Старая квартира' });
    const second = places.create(USER_ID, { label: 'Новая квартира' });
    repo.set(USER_ID, 'home', { ownerType: 'self' }, first.id);
    repo.set(USER_ID, 'home', { ownerType: 'self' }, second.id);
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'self' })?.id).toBe(second.id);
  });

  test('set refuses a place outside the owner scope', () => {
    new UserRepository(db).create({ telegram_id: 999 });
    const notMine = places.create(999, { label: 'Чужая квартира' });
    expect(() => repo.set(USER_ID, 'home', { ownerType: 'self' }, notMine.id)).toThrow(/PLACE_ROLE_PLACE_NOT_FOUND/);
  });
  test('set refuses a contact ownerRefId belonging to another user', () => {
    new UserRepository(db).create({ telegram_id: 999 });
    const theirContact = new ContactRepository(db).add(999, 'Not Mine');
    const home = places.create(USER_ID, { label: 'Дом' });
    expect(() => repo.set(USER_ID, 'home', { ownerType: 'contact', ownerRefId: theirContact.id }, home.id)).toThrow(
      /PLACE_ROLE_OWNER_NOT_FOUND/,
    );
  });

  test('set refuses a contact ownerRefId that does not exist at all', () => {
    const home = places.create(USER_ID, { label: 'Дом' });
    expect(() => repo.set(USER_ID, 'home', { ownerType: 'contact', ownerRefId: 999999 }, home.id)).toThrow(
      /PLACE_ROLE_OWNER_NOT_FOUND/,
    );
  });

  test('set refuses a group ownerRefId belonging to another user', () => {
    new UserRepository(db).create({ telegram_id: 999 });
    const theirGroup = new ContactGroupRepository(db).create(999, 'чужие');
    const home = places.create(USER_ID, { label: 'Дом' });
    expect(() => repo.set(USER_ID, 'home', { ownerType: 'group', ownerRefId: theirGroup.id }, home.id)).toThrow(
      /PLACE_ROLE_OWNER_NOT_FOUND/,
    );
  });

  test('a contact-bound place ("Lena\'s home") is a private note of the requesting owner', () => {
    const lena = contacts.add(USER_ID, 'Lena');
    const lenaHome = places.create(USER_ID, { label: "Lena's place", address: 'ул. Ленина 5' });
    repo.set(USER_ID, 'home', { ownerType: 'contact', ownerRefId: lena.id }, lenaHome.id);
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'contact', ownerRefId: lena.id })?.id).toBe(lenaHome.id);
    // Independent of the owner's own home.
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'self' })).toBeNull();
  });

  test('a household (group) home is a link, not a copy — updating the place updates what the role resolves to', () => {
    const group = groups.create(USER_ID, 'грюковы');
    const home = places.create(USER_ID, { label: 'Дом Грюковых', address: 'ул. Первая 1' });
    repo.set(USER_ID, 'home', { ownerType: 'group', ownerRefId: group.id }, home.id);
    places.update(USER_ID, home.id, { address: 'ул. Вторая 2' });
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'group', ownerRefId: group.id })?.address).toBe('ул. Вторая 2');
  });

  test("a trashed place resolves to null — never treated as anyone's active home", () => {
    const group = groups.create(USER_ID, 'грюковы');
    const home = places.create(USER_ID, { label: 'Дом Грюковых' });
    repo.set(USER_ID, 'home', { ownerType: 'group', ownerRefId: group.id }, home.id);
    places.softDelete(USER_ID, home.id);
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'group', ownerRefId: group.id })).toBeNull();
  });

  test('clear removes the link', () => {
    const home = places.create(USER_ID, { label: 'Дом' });
    repo.set(USER_ID, 'home', { ownerType: 'self' }, home.id);
    expect(repo.clear(USER_ID, 'home', { ownerType: 'self' })).toBe(true);
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'self' })).toBeNull();
  });

  test('clear is a no-op returning false when nothing is linked', () => {
    expect(repo.clear(USER_ID, 'home', { ownerType: 'self' })).toBe(false);
  });

  test('two different contacts can have independent home links to the same place', () => {
    const lena = contacts.add(USER_ID, 'Lena');
    const vova = contacts.add(USER_ID, 'Vova');
    const sharedHouse = places.create(USER_ID, { label: 'Общий дом' });
    repo.set(USER_ID, 'home', { ownerType: 'contact', ownerRefId: lena.id }, sharedHouse.id);
    repo.set(USER_ID, 'home', { ownerType: 'contact', ownerRefId: vova.id }, sharedHouse.id);
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'contact', ownerRefId: lena.id })?.id).toBe(sharedHouse.id);
    expect(repo.getPlace(USER_ID, 'home', { ownerType: 'contact', ownerRefId: vova.id })?.id).toBe(sharedHouse.id);
  });

  test('listForPlace lists every role pointing at a place', () => {
    const home = places.create(USER_ID, { label: 'Дом' });
    const group = groups.create(USER_ID, 'грюковы');
    repo.set(USER_ID, 'home', { ownerType: 'self' }, home.id);
    repo.set(USER_ID, 'home', { ownerType: 'group', ownerRefId: group.id }, home.id);
    expect(repo.listForPlace(USER_ID, home.id)).toHaveLength(2);
  });
});
