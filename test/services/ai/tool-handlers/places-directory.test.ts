import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ContactRepository } from '../../../../src/database/repositories/contact.repository.ts';
import { ContactAliasRepository } from '../../../../src/database/repositories/contact-alias.repository.ts';
import { ContactGroupRepository } from '../../../../src/database/repositories/contact-group.repository.ts';
import { PlaceRepository } from '../../../../src/database/repositories/place.repository.ts';
import { PlaceAliasRepository } from '../../../../src/database/repositories/place-alias.repository.ts';
import { PlaceRoleRepository } from '../../../../src/database/repositories/place-role.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  handleManagePlace,
  handleManagePlaceRole,
  handleResolvePlace,
} from '../../../../src/services/ai/tool-handlers/places.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { ContactResolver } from '../../../../src/services/contacts/contact-resolver.ts';
import { PlaceResolver } from '../../../../src/services/places/place-resolver.ts';

const USER_ID = 42;

function makeCtx(db: Database, isGroup = false): AgentContext {
  const userRepo = new UserRepository(db);
  userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
  const contactRepo = new ContactRepository(db);
  const contactAliasRepo = new ContactAliasRepository(db);
  const contactGroupRepo = new ContactGroupRepository(db);
  const placeRepo = new PlaceRepository(db);
  const placeAliasRepo = new PlaceAliasRepository(db);
  const placeRoleRepo = new PlaceRoleRepository(db);
  return {
    user: userRepo.findByTelegramId(USER_ID)!,
    chatId: USER_ID,
    messageText: '',
    isGroup,
    eventService: {} as AgentContext['eventService'],
    holidayService: {} as AgentContext['holidayService'],
    chatHistory: {} as AgentContext['chatHistory'],
    conversationLogger: null as unknown as AgentContext['conversationLogger'],
    userRepo,
    eventReminderRepo: {} as AgentContext['eventReminderRepo'],
    contactRepo,
    contactDirectory: {
      contactAliasRepo,
      contactGroupRepo,
      contactResolver: new ContactResolver(contactRepo, contactAliasRepo, contactGroupRepo),
    },
    placeRepo,
    placeDirectory: {
      placeAliasRepo,
      placeRoleRepo,
      placeResolver: new PlaceResolver(placeRepo, placeAliasRepo),
    },
  };
}

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('saved place AI tool handlers', () => {
  let db: Database;
  let ctx: AgentContext;

  beforeEach(() => {
    db = createTestDb();
    ctx = makeCtx(db);
  });

  test('manage_place add creates a place; list/get show it', () => {
    const added = handleManagePlace(ctx, { action: 'add', label: 'Дом', address: 'ул. Ленина 1' });
    expect(added.success).toBe(true);
    expect(added.output).toContain('Дом');

    const list = handleManagePlace(ctx, { action: 'list' });
    expect(list.output).toContain('Дом');

    const placeId = ctx.placeRepo!.list(USER_ID)[0]!.id;
    const got = handleManagePlace(ctx, { action: 'get', place_id: placeId });
    expect(got.output).toContain('ул. Ленина 1');
  });

  test('manage_place add without label reports the missing field instead of throwing', () => {
    const result = handleManagePlace(ctx, { action: 'add' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('label');
  });

  test('manage_place add allows two places to share a label — no per-user name uniqueness', () => {
    expect(handleManagePlace(ctx, { action: 'add', label: 'Дом' }).success).toBe(true);
    expect(handleManagePlace(ctx, { action: 'add', label: 'Дом' }).success).toBe(true);
    expect(ctx.placeRepo!.list(USER_ID)).toHaveLength(2);
  });

  test('manage_place update changes fields and resets verification when address changes', () => {
    const place = ctx.placeRepo!.create(USER_ID, {
      label: 'Офис',
      address: 'ул. Тверская 1',
      verification: 'confirmed',
    });
    const updated = handleManagePlace(ctx, { action: 'update', place_id: place.id, address: 'ул. Тверская 2' });
    expect(updated.success).toBe(true);
    expect(ctx.placeRepo!.findById(USER_ID, place.id)?.verification).toBe('unconfirmed');
  });

  test('manage_place update with confirmed=true re-asserts verification', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Офис' });
    handleManagePlace(ctx, { action: 'update', place_id: place.id, address: 'ул. Тверская 2', confirmed: true });
    expect(ctx.placeRepo!.findById(USER_ID, place.id)?.verification).toBe('confirmed');
  });

  test('manage_place update on an unknown place_id reports not found', () => {
    const result = handleManagePlace(ctx, { action: 'update', place_id: 999, label: 'x' });
    expect(result.success).toBe(false);
  });

  test('manage_place set_favorite toggles favorite', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Дом' });
    const result = handleManagePlace(ctx, { action: 'set_favorite', place_id: place.id, favorite: true });
    expect(result.success).toBe(true);
    expect(ctx.placeRepo!.findById(USER_ID, place.id)?.favorite).toBe(1);
  });

  test('manage_place delete/restore round-trips through trash', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Дом' });
    expect(handleManagePlace(ctx, { action: 'delete', place_id: place.id }).success).toBe(true);
    expect(ctx.placeRepo!.findById(USER_ID, place.id)).toBeNull();
    expect(handleManagePlace(ctx, { action: 'restore', place_id: place.id }).success).toBe(true);
    expect(ctx.placeRepo!.findById(USER_ID, place.id)).not.toBeNull();
  });

  test('manage_place purge permanently removes a place', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Дом' });
    ctx.placeRepo!.softDelete(USER_ID, place.id);
    expect(handleManagePlace(ctx, { action: 'purge', place_id: place.id }).success).toBe(true);
    expect(ctx.placeRepo!.findById(USER_ID, place.id, { includeDeleted: true })).toBeNull();
  });

  test('manage_place purge refuses an active (not yet trashed) place', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Дом' });
    const result = handleManagePlace(ctx, { action: 'purge', place_id: place.id });
    expect(result.success).toBe(false);
    expect(ctx.placeRepo!.findById(USER_ID, place.id)).not.toBeNull();
  });

  test('manage_place add_alias/list_aliases/delete_alias round-trip', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Дом' });
    expect(handleManagePlace(ctx, { action: 'add_alias', place_id: place.id, alias: 'хата' }).success).toBe(true);
    const listed = handleManagePlace(ctx, { action: 'list_aliases', place_id: place.id });
    expect(listed.output).toContain('хата');
    const aliasId = ctx.placeDirectory!.placeAliasRepo.listForPlace(USER_ID, place.id)[0]!.id;
    expect(handleManagePlace(ctx, { action: 'delete_alias', place_id: place.id, alias_id: aliasId }).success).toBe(
      true,
    );
    expect(ctx.placeDirectory!.placeAliasRepo.listForPlace(USER_ID, place.id)).toHaveLength(0);
  });

  test('manage_place add_alias rejects a duplicate alias on the same place', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Дом' });
    handleManagePlace(ctx, { action: 'add_alias', place_id: place.id, alias: 'хата' });
    const dupe = handleManagePlace(ctx, { action: 'add_alias', place_id: place.id, alias: 'хата' });
    expect(dupe.success).toBe(false);
  });

  test('manage_place add_alias allows two different places to share an alias', () => {
    const home = ctx.placeRepo!.create(USER_ID, { label: 'Мой дом' });
    const office = ctx.placeRepo!.create(USER_ID, { label: 'Офис' });
    expect(handleManagePlace(ctx, { action: 'add_alias', place_id: home.id, alias: 'дом' }).success).toBe(true);
    expect(handleManagePlace(ctx, { action: 'add_alias', place_id: office.id, alias: 'дом' }).success).toBe(true);
  });

  test('manage_place mutations are refused inside a group chat', () => {
    const groupCtx: AgentContext = { ...ctx, isGroup: true };
    expect(handleManagePlace(groupCtx, { action: 'list' }).success).toBe(false);
  });

  test('resolve_place exact_unique resolves directly', () => {
    ctx.placeRepo!.create(USER_ID, { label: 'Дом' });
    const result = handleResolvePlace(ctx, { query: 'дом' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Exact match');
  });

  test('resolve_place exact_ambiguous asks — never silently picks one of two same-alias places', () => {
    const home1 = ctx.placeRepo!.create(USER_ID, { label: 'дом' });
    const home2 = ctx.placeRepo!.create(USER_ID, { label: 'дача' });
    ctx.placeDirectory!.placeAliasRepo.add(USER_ID, home2.id, 'дом');
    const result = handleResolvePlace(ctx, { query: 'дом' });
    expect(result.success).toBe(true);
    expect(result.output).toContain(String(home1.id));
    expect(result.output).toContain(String(home2.id));
    expect(result.agentHint).toContain('ask the user');
  });

  test('resolve_place fuzzy_confirm always needs confirmation', () => {
    ctx.placeRepo!.create(USER_ID, { label: 'Ушће' });
    const result = handleResolvePlace(ctx, { query: 'Ушце' });
    expect(result.success).toBe(true);
    expect(result.agentHint).toContain('confirm');
  });

  test('resolve_place returns none for an unknown query', () => {
    const result = handleResolvePlace(ctx, { query: 'Nowhere' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('No saved place');
  });

  test('manage_place_role set links a place as home and get returns it', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Дом' });
    const set = handleManagePlaceRole(ctx, { action: 'set', role: 'home', owner_type: 'self', place_id: place.id });
    expect(set.success).toBe(true);
    const got = handleManagePlaceRole(ctx, { action: 'get', role: 'home', owner_type: 'self' });
    expect(got.output).toContain('Дом');
  });

  test('manage_place_role set for a contact needs owner_ref_id and validates ownership', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Дом Лены' });
    const missingRef = handleManagePlaceRole(ctx, {
      action: 'set',
      role: 'home',
      owner_type: 'contact',
      place_id: place.id,
    });
    expect(missingRef.success).toBe(false);

    const notMine = handleManagePlaceRole(ctx, {
      action: 'set',
      role: 'home',
      owner_type: 'contact',
      owner_ref_id: 999,
      place_id: place.id,
    });
    expect(notMine.success).toBe(false);

    const lena = ctx.contactRepo!.add(USER_ID, 'Lena');
    const result = handleManagePlaceRole(ctx, {
      action: 'set',
      role: 'home',
      owner_type: 'contact',
      owner_ref_id: lena.id,
      place_id: place.id,
    });
    expect(result.success).toBe(true);
  });

  // Independent review finding (#655): once a link exists, deleting the linked contact must not
  // strand the place_roles row — get/clear must keep working, only `set` needs a live contact.
  test('manage_place_role get/clear still work for a link whose contact was later deleted', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: "Lena's place" });
    const lena = ctx.contactRepo!.add(USER_ID, 'Lena');
    handleManagePlaceRole(ctx, {
      action: 'set',
      role: 'home',
      owner_type: 'contact',
      owner_ref_id: lena.id,
      place_id: place.id,
    });
    ctx.contactRepo!.deleteOwned(USER_ID, lena.id);

    const got = handleManagePlaceRole(ctx, {
      action: 'get',
      role: 'home',
      owner_type: 'contact',
      owner_ref_id: lena.id,
    });
    expect(got.success).toBe(true);
    expect(got.output).toContain("Lena's place");

    const cleared = handleManagePlaceRole(ctx, {
      action: 'clear',
      role: 'home',
      owner_type: 'contact',
      owner_ref_id: lena.id,
    });
    expect(cleared.success).toBe(true);
  });

  test('manage_place_role set for a group validates the group belongs to this user', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Семейный дом' });
    const group = ctx.contactDirectory!.contactGroupRepo.create(USER_ID, 'грюковы');
    const result = handleManagePlaceRole(ctx, {
      action: 'set',
      role: 'home',
      owner_type: 'group',
      owner_ref_id: group.id,
      place_id: place.id,
    });
    expect(result.success).toBe(true);
  });

  test('manage_place_role get returns unset when no link exists', () => {
    const result = handleManagePlaceRole(ctx, { action: 'get', role: 'work', owner_type: 'self' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('not set');
  });

  test('manage_place_role clear removes the link', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Дом' });
    handleManagePlaceRole(ctx, { action: 'set', role: 'home', owner_type: 'self', place_id: place.id });
    const cleared = handleManagePlaceRole(ctx, { action: 'clear', role: 'home', owner_type: 'self' });
    expect(cleared.success).toBe(true);
    const got = handleManagePlaceRole(ctx, { action: 'get', role: 'home', owner_type: 'self' });
    expect(got.output).toContain('not set');
  });

  test('manage_place_role set on a deleted place reports not found', () => {
    const place = ctx.placeRepo!.create(USER_ID, { label: 'Дом' });
    ctx.placeRepo!.softDelete(USER_ID, place.id);
    const result = handleManagePlaceRole(ctx, { action: 'set', role: 'home', owner_type: 'self', place_id: place.id });
    expect(result.success).toBe(false);
  });

  test('manage_place_role mutations are refused inside a group chat', () => {
    const groupCtx: AgentContext = { ...ctx, isGroup: true };
    expect(handleManagePlaceRole(groupCtx, { action: 'get', role: 'home', owner_type: 'self' }).success).toBe(false);
  });
});
