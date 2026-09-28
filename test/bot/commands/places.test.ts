import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  buildPlaceDetailKeyboard,
  buildPlacesListKeyboard,
  formatPlaceDetailText,
  handlePlaces,
  handlePlacesCallback,
  type PlacesDeps,
} from '../../../src/bot/commands/places.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { PlaceRepository } from '../../../src/database/repositories/place.repository.ts';
import { PlaceAliasRepository } from '../../../src/database/repositories/place-alias.repository.ts';
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

function makeDeps(db: Database): PlacesDeps {
  return {
    placeRepo: new PlaceRepository(db),
    placeAliasRepo: new PlaceAliasRepository(db),
  };
}

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
  let deps: PlacesDeps;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID, timezone: 'UTC' });
    deps = makeDeps(db);
  });

  function makeCtx(args: string | null, chatType: 'private' | 'group' = 'private') {
    return {
      dbUser: { telegram_id: USER_ID, language: 'en' as const },
      args,
      chat: { type: chatType, id: chatType === 'group' ? -100 : USER_ID },
      send: mock(() => Promise.resolve()),
    };
  }

  test('refuses to run in a group chat', async () => {
    const ctx = makeCtx(null, 'group');
    await handlePlaces(ctx as never, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('private'));
  });

  test('no args, empty book shows the empty message', async () => {
    const ctx = makeCtx(null);
    await handlePlaces(ctx as never, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('empty'), expect.anything());
  });

  test('add creates a place', async () => {
    const ctx = makeCtx('add Дом');
    await handlePlaces(ctx as never, deps);
    expect(deps.placeRepo.list(USER_ID).map((p) => p.label)).toContain('Дом');
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('Дом'));
  });

  test('add allows two places with the same label', async () => {
    await handlePlaces(makeCtx('add Дом') as never, deps);
    await handlePlaces(makeCtx('add Дом') as never, deps);
    expect(deps.placeRepo.list(USER_ID)).toHaveLength(2);
  });

  test('alias adds an alias to an existing place', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    const ctx = makeCtx(`alias ${place.id} хата`);
    await handlePlaces(ctx as never, deps);
    expect(deps.placeAliasRepo.listForPlace(USER_ID, place.id).map((a) => a.alias)).toContain('хата');
  });

  test('alias reports a conflict without throwing', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    deps.placeAliasRepo.add(USER_ID, place.id, 'хата');
    const ctx = makeCtx(`alias ${place.id} хата`);
    await handlePlaces(ctx as never, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('already an alias'));
  });

  test('unknown subcommand shows usage', async () => {
    const ctx = makeCtx('bogus');
    await handlePlaces(ctx as never, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });
});

describe('handlePlacesCallback', () => {
  let db: Database;
  let deps: PlacesDeps;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID, timezone: 'UTC' });
    deps = makeDeps(db);
  });

  function makeCtx() {
    return { answer: mock(() => Promise.resolve()), editText: mock(() => Promise.resolve()) };
  }

  const user = { telegram_id: USER_ID, language: 'en' as const };

  test('view shows the place detail with its aliases', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    const ctx = makeCtx();
    await handlePlacesCallback(ctx as never, `view:${place.id}:0`, user, deps);
    expect(ctx.editText).toHaveBeenCalledWith(expect.stringContaining('Дом'), expect.anything());
  });

  test('fav toggles favorite on and back off', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    await handlePlacesCallback(makeCtx() as never, `fav:${place.id}:0`, user, deps);
    expect(deps.placeRepo.findById(USER_ID, place.id)?.favorite).toBe(1);
    await handlePlacesCallback(makeCtx() as never, `fav:${place.id}:0`, user, deps);
    expect(deps.placeRepo.findById(USER_ID, place.id)?.favorite).toBe(0);
  });

  test('delalias removes an alias', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    const alias = deps.placeAliasRepo.add(USER_ID, place.id, 'хата');
    await handlePlacesCallback(makeCtx() as never, `delalias:${place.id}:${alias.id}:0`, user, deps);
    expect(deps.placeAliasRepo.listForPlace(USER_ID, place.id)).toHaveLength(0);
  });

  test('delplace then delplaceok moves the place to trash', async () => {
    const place = deps.placeRepo.create(USER_ID, { label: 'Дом' });
    const askCtx = makeCtx();
    await handlePlacesCallback(askCtx as never, `delplace:${place.id}:0`, user, deps);
    expect(askCtx.editText).toHaveBeenCalledWith(expect.stringContaining('trash'), expect.anything());

    const confirmCtx = makeCtx();
    await handlePlacesCallback(confirmCtx as never, `delplaceok:${place.id}:0`, user, deps);
    expect(deps.placeRepo.findById(USER_ID, place.id)).toBeNull();
  });
});
