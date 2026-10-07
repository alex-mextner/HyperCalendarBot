import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  buildPlaceDetailKeyboard,
  buildPlacesListKeyboard,
  formatPlaceDetailText,
  handlePlaces,
  handlePlacesCallback,
} from '../../../src/bot/commands/places.ts';
import type { BotCallbackContext, BotCommandContext } from '../../../src/bot/types.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { ContactGroupRepository } from '../../../src/database/repositories/contact-group.repository.ts';
import { PlaceRepository } from '../../../src/database/repositories/place.repository.ts';
import { PlaceAliasRepository } from '../../../src/database/repositories/place-alias.repository.ts';
import { PlaceRoleRepository } from '../../../src/database/repositories/place-role.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { PlaceAlias, SavedPlace } from '../../../src/database/types.ts';

interface InlineButton {
  text: string;
  callback_data?: string;
}

function rows(kb: { toJSON(): { inline_keyboard: InlineButton[][] } }): InlineButton[][] {
  return kb.toJSON().inline_keyboard;
}

const USER_ID = 42;

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeDeps(db: Database) {
  return {
    placeRepo: new PlaceRepository(db),
    placeAliasRepo: new PlaceAliasRepository(db),
    placeRoleRepo: new PlaceRoleRepository(db),
    contactRepo: new ContactRepository(db),
    contactGroupRepo: new ContactGroupRepository(db),
  };
}

type TestPlacesDeps = ReturnType<typeof makeDeps>;

function makePlace(id: number, label: string, overrides: Partial<SavedPlace> = {}): SavedPlace {
  return {
    id,
    user_id: USER_ID,
    label,
    venue_name: null,
    address: null,
    latitude: null,
    longitude: null,
    provider: null,
    provider_place_id: null,
    map_url: null,
    notes: null,
    favorite: 0,
    verification: 'unconfirmed',
    provenance: null,
    revision: 1,
    created_at: '',
    updated_at: '',
    deleted_at: null,
    ...overrides,
  };
}

describe('buildPlacesListKeyboard', () => {
  test('one row per place, favorite gets a star', () => {
    const kb = buildPlacesListKeyboard([makePlace(1, 'Дом', { favorite: 1 }), makePlace(2, 'Офис')], 'en', 0);
    const r = rows(kb);
    expect(r[0]?.[0]?.text).toBe('⭐ Дом');
    expect(r[1]?.[0]?.text).toBe('Офис');
  });

  test('shows next button when more places than one page', () => {
    const places = Array.from({ length: 9 }, (_, i) => makePlace(i + 1, `P${i + 1}`));
    const kb = buildPlacesListKeyboard(places, 'en', 0);
    const flat = rows(kb).flat();
    expect(flat.some((b) => b.text === '▶️')).toBe(true);
    expect(flat.some((b) => b.text === '◀️')).toBe(false);
  });

  test('shows prev button on a later page', () => {
    const places = Array.from({ length: 9 }, (_, i) => makePlace(i + 1, `P${i + 1}`));
    const kb = buildPlacesListKeyboard(places, 'en', 8);
    const flat = rows(kb).flat();
    expect(flat.some((b) => b.text === '◀️')).toBe(true);
  });
});

describe('buildPlaceDetailKeyboard / formatPlaceDetailText', () => {
  function makeAlias(id: number, placeId: number, alias: string): PlaceAlias {
    return { id, user_id: USER_ID, place_id: placeId, alias, created_at: '' };
  }

  test('has an alias delete button, a favorite toggle, a delete button, and back', () => {
    const place = makePlace(1, 'Дом', { address: 'ул. Ленина 1' });
    const aliases = [makeAlias(1, 1, 'хата')];
    const kb = buildPlaceDetailKeyboard(place, aliases, 0, 'en');
    const flat = rows(kb).flat();
    expect(flat.some((b) => b.text.includes('хата'))).toBe(true);
    expect(flat.some((b) => b.text === '⭐ Mark favorite')).toBe(true);
    expect(flat.some((b) => b.text === '🗑 Delete place')).toBe(true);
    expect(flat.some((b) => b.text === '⬅️ Back')).toBe(true);
  });

  test('favorite place shows the unmark button', () => {
    const place = makePlace(1, 'Дом', { favorite: 1 });
    const kb = buildPlaceDetailKeyboard(place, [], 0, 'en');
    const flat = rows(kb).flat();
    expect(flat.some((b) => b.text === '☆ Unmark favorite')).toBe(true);
  });

  test('detail text includes address, verification, and aliases', () => {
    const place = makePlace(1, 'Дом', { address: 'ул. Ленина 1', verification: 'confirmed' });
    const text = formatPlaceDetailText(place, [makeAlias(1, 1, 'хата')], 'en');
    expect(text).toContain('ул. Ленина 1');
    expect(text).toContain('Verified');
    expect(text).toContain('хата');
  });

  test('detail text marks unverified places', () => {
    const place = makePlace(1, 'Дом', { verification: 'unconfirmed' });
    const text = formatPlaceDetailText(place, [], 'en');
    expect(text).toContain('Unverified');
  });
});

describe('handlePlaces command', () => {
  let db: Database;
  let deps: TestPlacesDeps;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID, timezone: 'UTC' });
    deps = makeDeps(db);
  });

  function makeCtx(args: string | null, chatType: 'private' | 'group' = 'private'): BotCommandContext {
    return {
      dbUser: { telegram_id: USER_ID, language: 'en' as const },
      args,
      chat: { type: chatType, id: chatType === 'group' ? -100 : USER_ID },
      send: mock(() => Promise.resolve()),
    } as unknown as BotCommandContext;
  }

  test('refuses to run in a group chat', async () => {
    const ctx = makeCtx(null, 'group');
    await handlePlaces(ctx, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('private'));
  });

  test('no args, empty book shows the empty message', async () => {
    const ctx = makeCtx(null);
    await handlePlaces(ctx, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('empty'), expect.anything());
  });

  test('add creates a place', async () => {
    const ctx = makeCtx('add Дом');
    await handlePlaces(ctx, deps);
    expect(deps.placeRepo.list(USER_ID).map((p) => p.label)).toContain('Дом');
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('Дом'));
  });

  test('add allows two places with the same label', async () => {
    await handlePlaces(makeCtx('add Дом'), deps);
    await handlePlaces(makeCtx('add Дом'), deps);
    expect(deps.placeRepo.list(USER_ID)).toHaveLength(2);
  });

  test('alias adds an alias to an existing place', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    const ctx = makeCtx(`alias ${place.id} хата`);
    await handlePlaces(ctx, deps);
    expect(deps.placeAliasRepo.listForPlace(USER_ID, place.id).map((a) => a.alias)).toContain('хата');
  });

  test('alias reports a conflict without throwing', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    deps.placeAliasRepo.add(USER_ID, place.id, 'хата');
    const ctx = makeCtx(`alias ${place.id} хата`);
    await handlePlaces(ctx, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('already an alias'));
  });

  test('edit renames a place and edits address without re-verifying changed geography', async () => {
    const place = deps.placeRepo.create(USER_ID, {
      label: 'Old office',
      address: 'Old street 1',
      verification: 'confirmed',
    });

    await handlePlaces(makeCtx(`edit ${place.id} label New office`), deps);
    await handlePlaces(makeCtx(`edit ${place.id} address New street 2`), deps);

    const updated = deps.placeRepo.findById(USER_ID, place.id)!;
    expect(updated.label).toBe('New office');
    expect(updated.address).toBe('New street 2');
    expect(updated.verification).toBe('unconfirmed');
  });

  test('edit can set and clear optional fields and coordinates', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Park' });

    await handlePlaces(makeCtx(`edit ${place.id} venue Ada Ciganlija`), deps);
    await handlePlaces(makeCtx(`edit ${place.id} map https://maps.example/place`), deps);
    await handlePlaces(makeCtx(`edit ${place.id} notes lake side`), deps);
    await handlePlaces(makeCtx(`edit ${place.id} coords 44.7866 20.4489`), deps);

    let updated = deps.placeRepo.findById(USER_ID, place.id)!;
    expect(updated.venue_name).toBe('Ada Ciganlija');
    expect(updated.map_url).toBe('https://maps.example/place');
    expect(updated.notes).toBe('lake side');
    expect(updated.latitude).toBeCloseTo(44.7866);
    expect(updated.longitude).toBeCloseTo(20.4489);

    await handlePlaces(makeCtx(`edit ${place.id} notes -`), deps);
    await handlePlaces(makeCtx(`edit ${place.id} coords -`), deps);
    updated = deps.placeRepo.findById(USER_ID, place.id)!;
    expect(updated.notes).toBeNull();
    expect(updated.latitude).toBeNull();
    expect(updated.longitude).toBeNull();
  });

  test('trash lists deleted places and restore revives the same place and its role link', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Home' });
    deps.placeRoleRepo.set(USER_ID, 'home', { ownerType: 'self' }, place.id);
    deps.placeRepo.softDelete(USER_ID, place.id);
    expect(deps.placeRoleRepo.getPlace(USER_ID, 'home', { ownerType: 'self' })).toBeNull();

    const trashCtx = makeCtx('trash');
    await handlePlaces(trashCtx, deps);
    expect(trashCtx.send).toHaveBeenCalledWith(expect.stringContaining('Home'));

    const restoreCtx = makeCtx(`restore ${place.id}`);
    await handlePlaces(restoreCtx, deps);
    expect(deps.placeRepo.findById(USER_ID, place.id)?.label).toBe('Home');
    expect(deps.placeRoleRepo.getPlace(USER_ID, 'home', { ownerType: 'self' })?.id).toBe(place.id);
    expect(restoreCtx.send).toHaveBeenCalledWith(expect.stringContaining('Home'));
  });

  test('role set/get supports self, contact and collective group owners', async () => {
    const home = deps.placeRepo.create(USER_ID, { label: 'Home' });
    const office = deps.placeRepo.create(USER_ID, { label: 'Office' });
    const contact = deps.contactRepo.add(USER_ID, 'Lena');
    const group = deps.contactGroupRepo.create(USER_ID, 'Gryukovs');

    await handlePlaces(makeCtx(`role set home self ${home.id}`), deps);
    await handlePlaces(makeCtx(`role set work contact ${contact.id} ${office.id}`), deps);
    await handlePlaces(makeCtx(`role set home group ${group.id} ${home.id}`), deps);

    expect(deps.placeRoleRepo.getPlace(USER_ID, 'home', { ownerType: 'self' })?.id).toBe(home.id);
    expect(deps.placeRoleRepo.getPlace(USER_ID, 'work', { ownerType: 'contact', ownerRefId: contact.id })?.id).toBe(
      office.id,
    );
    expect(deps.placeRoleRepo.getPlace(USER_ID, 'home', { ownerType: 'group', ownerRefId: group.id })?.id).toBe(
      home.id,
    );

    const getCtx = makeCtx(`role get work contact ${contact.id}`);
    await handlePlaces(getCtx, deps);
    expect(getCtx.send).toHaveBeenCalledWith(expect.stringContaining('Office'));
    expect(getCtx.send).toHaveBeenCalledWith(expect.stringContaining('Lena'));
  });

  test('role clear requires confirmation and names the exact current target', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Home' });
    deps.placeRoleRepo.set(USER_ID, 'home', { ownerType: 'self' }, place.id);

    const ctx = makeCtx('role clear home self');
    await handlePlaces(ctx, deps);

    expect(deps.placeRoleRepo.getPlace(USER_ID, 'home', { ownerType: 'self' })?.id).toBe(place.id);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('Home'), expect.anything());
    const sendMock = ctx.send as unknown as ReturnType<typeof mock>;
    const markup = sendMock.mock.calls[0]?.[1] as
      | { reply_markup?: { toJSON(): { inline_keyboard: InlineButton[][] } } }
      | undefined;
    const callbackData = markup?.reply_markup?.toJSON().inline_keyboard.flat()[0]?.callback_data;
    expect(callbackData).toContain('roleclearok:home:self:0:');
  });

  test('purge requires explicit confirmation and does not delete on the command alone', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Old home' });
    deps.placeRepo.softDelete(USER_ID, place.id);

    const ctx = makeCtx(`purge ${place.id}`);
    await handlePlaces(ctx, deps);

    expect(deps.placeRepo.findById(USER_ID, place.id, { includeDeleted: true })).not.toBeNull();
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('Old home'), expect.anything());
  });
  test('unknown subcommand shows usage', async () => {
    const ctx = makeCtx('bogus');
    await handlePlaces(ctx, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });
});

describe('handlePlacesCallback', () => {
  let db: Database;
  let deps: TestPlacesDeps;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID, timezone: 'UTC' });
    deps = makeDeps(db);
  });

  function makeCtx(): BotCallbackContext {
    return {
      chat: { type: 'private' as const, id: USER_ID },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    } as unknown as BotCallbackContext;
  }

  const user = { telegram_id: USER_ID, language: 'en' as const };

  test('view shows the place detail with its aliases', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    const ctx = makeCtx();
    await handlePlacesCallback(ctx, `view:${place.id}:0`, user, deps);
    expect(ctx.editText).toHaveBeenCalledWith(expect.stringContaining('Дом'), expect.anything());
  });

  test('fav toggles favorite on and back off', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    await handlePlacesCallback(makeCtx(), `fav:${place.id}:0`, user, deps);
    expect(deps.placeRepo.findById(USER_ID, place.id)?.favorite).toBe(1);
    await handlePlacesCallback(makeCtx(), `fav:${place.id}:0`, user, deps);
    expect(deps.placeRepo.findById(USER_ID, place.id)?.favorite).toBe(0);
  });

  test('delalias removes an alias', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    const alias = deps.placeAliasRepo.add(USER_ID, place.id, 'хата');
    await handlePlacesCallback(makeCtx(), `delalias:${place.id}:${alias.id}:0`, user, deps);
    expect(deps.placeAliasRepo.listForPlace(USER_ID, place.id)).toHaveLength(0);
  });

  test('delplace then delplaceok moves the place to trash', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    const askCtx = makeCtx();
    await handlePlacesCallback(askCtx, `delplace:${place.id}:0`, user, deps);
    expect(askCtx.editText).toHaveBeenCalledWith(expect.stringContaining('trash'), expect.anything());

    const confirmCtx = makeCtx();
    await handlePlacesCallback(confirmCtx, `delplaceok:${place.id}:0`, user, deps);
    expect(deps.placeRepo.findById(USER_ID, place.id)).toBeNull();
  });

  test('roleclearok clears only the role that was explicitly confirmed', async () => {
    const first = deps.placeRepo.create(USER_ID, { label: 'First home' });
    const second = deps.placeRepo.create(USER_ID, { label: 'Second home' });
    deps.placeRoleRepo.set(USER_ID, 'home', { ownerType: 'self' }, first.id);

    await handlePlacesCallback(makeCtx(), `roleclearok:home:self:0:${first.id}`, user, deps);
    expect(deps.placeRoleRepo.getPlace(USER_ID, 'home', { ownerType: 'self' })).toBeNull();

    deps.placeRoleRepo.set(USER_ID, 'home', { ownerType: 'self' }, first.id);
    deps.placeRoleRepo.set(USER_ID, 'home', { ownerType: 'self' }, second.id);
    const staleCtx = makeCtx();
    await handlePlacesCallback(staleCtx, `roleclearok:home:self:0:${first.id}`, user, deps);
    expect(deps.placeRoleRepo.getPlace(USER_ID, 'home', { ownerType: 'self' })?.id).toBe(second.id);
    expect(staleCtx.editText).toHaveBeenCalledWith(expect.stringContaining('changed'));
  });

  test('purgeplaceok permanently deletes only an already trashed place', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Old home' });
    deps.placeRepo.softDelete(USER_ID, place.id);

    await handlePlacesCallback(makeCtx(), `purgeplaceok:${place.id}`, user, deps);
    expect(deps.placeRepo.findById(USER_ID, place.id, { includeDeleted: true })).toBeNull();
  });
});

// GH-712: CB.PLACES can be delivered in a group independently of the /places command.
// Every branch must reject before reading or mutating the private place directory.
describe('handlePlacesCallback refuses group chat scope', () => {
  let db: Database;
  let deps: TestPlacesDeps;
  let place: SavedPlace;
  let alias: PlaceAlias;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID, timezone: 'UTC' });
    deps = makeDeps(db);
    place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    alias = deps.placeAliasRepo.add(USER_ID, place.id, 'хата');
  });

  const user = { telegram_id: USER_ID, language: 'en' as const };

  function makeGroupCtx(): BotCallbackContext {
    return {
      chat: { type: 'group' as const, id: -100 },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    } as unknown as BotCallbackContext;
  }

  test('list callback in a group never renders the private place book', async () => {
    const ctx = makeGroupCtx();
    await handlePlacesCallback(ctx, 'list:0', user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
  });

  test('view callback in a group never renders place detail', async () => {
    const ctx = makeGroupCtx();
    await handlePlacesCallback(ctx, `view:${place.id}:0`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('favorite callback in a group never mutates the place', async () => {
    const ctx = makeGroupCtx();
    await handlePlacesCallback(ctx, `fav:${place.id}:0`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(deps.placeRepo.findById(USER_ID, place.id)?.favorite).toBe(0);
  });

  test('delete-alias callback in a group never mutates aliases', async () => {
    const ctx = makeGroupCtx();
    await handlePlacesCallback(ctx, `delalias:${place.id}:${alias.id}:0`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(deps.placeAliasRepo.listForPlace(USER_ID, place.id)).toHaveLength(1);
  });

  test('delete prompt callback in a group never renders the private target', async () => {
    const ctx = makeGroupCtx();
    await handlePlacesCallback(ctx, `delplace:${place.id}:0`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('delete-confirm callback in a group never trashes the place', async () => {
    const ctx = makeGroupCtx();
    await handlePlacesCallback(ctx, `delplaceok:${place.id}:0`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(deps.placeRepo.findById(USER_ID, place.id)).not.toBeNull();
  });

  test('role-clear confirmation in a group cannot mutate a private role', async () => {
    deps.placeRoleRepo.set(USER_ID, 'home', { ownerType: 'self' }, place.id);
    const ctx = makeGroupCtx();
    await handlePlacesCallback(ctx, `roleclearok:home:self:0:${place.id}`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(deps.placeRoleRepo.getPlace(USER_ID, 'home', { ownerType: 'self' })?.id).toBe(place.id);
  });

  test('purge confirmation in a group cannot permanently delete a private place', async () => {
    deps.placeRepo.softDelete(USER_ID, place.id);
    const ctx = makeGroupCtx();
    await handlePlacesCallback(ctx, `purgeplaceok:${place.id}`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(deps.placeRepo.findById(USER_ID, place.id, { includeDeleted: true })).not.toBeNull();
  });
});
