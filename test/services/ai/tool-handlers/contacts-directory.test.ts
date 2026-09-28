import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ContactRepository } from '../../../../src/database/repositories/contact.repository.ts';
import { ContactAliasRepository } from '../../../../src/database/repositories/contact-alias.repository.ts';
import { ContactGroupRepository } from '../../../../src/database/repositories/contact-group.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  handleAddContactAlias,
  handleAddContactGroupMember,
  handleConfirmContactAlias,
  handleCreateContactGroup,
  handleDeleteContactAlias,
  handleDeleteContactGroup,
  handleListContactAliases,
  handleListContactGroupMembers,
  handleListContactGroups,
  handlePromoteContactAlias,
  handleRemoveContactGroupMember,
  handleResolveContact,
} from '../../../../src/services/ai/tool-handlers/contacts.ts';
import type { AgentContext, ToolResult } from '../../../../src/services/ai/types.ts';
import { ContactResolver } from '../../../../src/services/contacts/contact-resolver.ts';

/** Narrows a resolve_contact/find_contact-style ToolResult.data down to its matches' contact ids. */
function matchedIds(result: ToolResult): number[] {
  if (!result.data || typeof result.data !== 'object' || !('matches' in result.data)) return [];
  return result.data.matches.map((match) => match.id);
}

const USER_ID = 42;

function makeCtx(db: Database, isGroup = false): AgentContext {
  const userRepo = new UserRepository(db);
  userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
  const contactRepo = new ContactRepository(db);
  const contactAliasRepo = new ContactAliasRepository(db);
  const contactGroupRepo = new ContactGroupRepository(db);
  return {
    user: userRepo.findByTelegramId(USER_ID)!,
    chatId: USER_ID,
    messageText: '',
    isGroup,
    eventService: {} as AgentContext['eventService'],
    holidayService: {} as AgentContext['holidayService'],
    chatHistory: {} as AgentContext['chatHistory'],
    conversationLogger: null as never,
    userRepo,
    eventReminderRepo: {} as AgentContext['eventReminderRepo'],
    contactRepo,
    contactDirectory: {
      contactAliasRepo,
      contactGroupRepo,
      contactResolver: new ContactResolver(contactRepo, contactAliasRepo, contactGroupRepo),
    },
  };
}

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('contact alias/group AI tool handlers', () => {
  let db: Database;
  let ctx: AgentContext;

  beforeEach(() => {
    db = createTestDb();
    ctx = makeCtx(db);
  });

  test('add_contact_alias adds an alias and list_contact_aliases shows it, primary marked', () => {
    const contact = ctx.contactRepo!.add(USER_ID, 'Elena Larichkina');
    const added = handleAddContactAlias(ctx, { contact_id: contact.id, alias: 'Ленка' });
    expect(added.success).toBe(true);

    const listed = handleListContactAliases(ctx, { contact_id: contact.id });
    expect(listed.success).toBe(true);
    expect(listed.output).toContain('Ленка');
    expect(listed.output).toContain('primary');
  });

  test('add_contact_alias rejects a duplicate alias on the same contact', () => {
    const contact = ctx.contactRepo!.add(USER_ID, 'Elena');
    handleAddContactAlias(ctx, { contact_id: contact.id, alias: 'Ленка' });
    const dupe = handleAddContactAlias(ctx, { contact_id: contact.id, alias: 'ленка' });
    expect(dupe.success).toBe(false);
  });

  test('add_contact_alias allows two different contacts to share an alias', () => {
    const lena1 = ctx.contactRepo!.add(USER_ID, 'Lena Ivanova');
    const lena2 = ctx.contactRepo!.add(USER_ID, 'Lena Petrova');
    expect(handleAddContactAlias(ctx, { contact_id: lena1.id, alias: 'Лена' }).success).toBe(true);
    expect(handleAddContactAlias(ctx, { contact_id: lena2.id, alias: 'Лена' }).success).toBe(true);
  });

  test('promote_contact_alias makes an alias primary and updates the contact name', () => {
    const contact = ctx.contactRepo!.add(USER_ID, 'Elena');
    handleAddContactAlias(ctx, { contact_id: contact.id, alias: 'Ленка' });
    const aliasId = ctx
      .contactDirectory!.contactAliasRepo.listForContact(USER_ID, contact.id)
      .find((a) => a.alias === 'Ленка')!.id;
    const result = handlePromoteContactAlias(ctx, { contact_id: contact.id, alias_id: aliasId });
    expect(result.success).toBe(true);
    expect(ctx.contactRepo!.findById(USER_ID, contact.id)?.name).toBe('Ленка');
  });

  test('delete_contact_alias refuses to remove the primary alias', () => {
    const contact = ctx.contactRepo!.add(USER_ID, 'Elena');
    const primaryId = ctx.contactDirectory!.contactAliasRepo.listForContact(USER_ID, contact.id)[0]!.id;
    const result = handleDeleteContactAlias(ctx, { contact_id: contact.id, alias_id: primaryId });
    expect(result.success).toBe(false);
  });

  test('delete_contact_alias removes a non-primary alias', () => {
    const contact = ctx.contactRepo!.add(USER_ID, 'Elena');
    handleAddContactAlias(ctx, { contact_id: contact.id, alias: 'Ленка' });
    const aliasId = ctx
      .contactDirectory!.contactAliasRepo.listForContact(USER_ID, contact.id)
      .find((a) => a.alias === 'Ленка')!.id;
    expect(handleDeleteContactAlias(ctx, { contact_id: contact.id, alias_id: aliasId }).success).toBe(true);
    expect(ctx.contactDirectory!.contactAliasRepo.listForContact(USER_ID, contact.id)).toHaveLength(1);
  });

  test('confirm_contact_alias learns an alias with confirmed_correction provenance', () => {
    const contact = ctx.contactRepo!.add(USER_ID, 'Elena');
    const result = handleConfirmContactAlias(ctx, { contact_id: contact.id, alias: 'Ленка' });
    expect(result.success).toBe(true);
    const learned = ctx
      .contactDirectory!.contactAliasRepo.listForContact(USER_ID, contact.id)
      .find((a) => a.alias === 'Ленка');
    expect(learned?.source).toBe('confirmed_correction');
  });

  test('alias mutations are refused inside a group chat', () => {
    const contact = ctx.contactRepo!.add(USER_ID, 'Elena');
    const groupCtx: AgentContext = { ...ctx, isGroup: true };
    expect(handleAddContactAlias(groupCtx, { contact_id: contact.id, alias: 'Ленка' }).success).toBe(false);
  });

  test('create_contact_group creates an explicit collective alias', () => {
    const result = handleCreateContactGroup(ctx, { alias: 'грюковы' });
    expect(result.success).toBe(true);
    const groups = handleListContactGroups(ctx);
    expect(groups.output).toContain('грюковы');
  });

  test('create_contact_group rejects a duplicate group alias', () => {
    handleCreateContactGroup(ctx, { alias: 'грюковы' });
    const dupe = handleCreateContactGroup(ctx, { alias: 'Грюковы' });
    expect(dupe.success).toBe(false);
  });

  test('create_contact_group rejects an alias already used by a person', () => {
    const contact = ctx.contactRepo!.add(USER_ID, 'Lena');
    void contact;
    const dupe = handleCreateContactGroup(ctx, { alias: 'Lena' });
    expect(dupe.success).toBe(false);
  });

  test('add_contact_group_member and list_contact_group_members show the members', () => {
    const createResult = handleCreateContactGroup(ctx, { alias: 'грюковы' });
    const group = ctx.contactDirectory!.contactGroupRepo.findByAlias(USER_ID, 'грюковы')!;
    void createResult;
    const anna = ctx.contactRepo!.add(USER_ID, 'Anna Gryukova');
    expect(handleAddContactGroupMember(ctx, { group_id: group.id, contact_id: anna.id }).success).toBe(true);
    const members = handleListContactGroupMembers(ctx, { group_id: group.id });
    expect(members.output).toContain('Anna Gryukova');
  });

  test('add_contact_group_member refuses a contact not owned by the user', () => {
    const group = ctx.contactDirectory!.contactGroupRepo.create(USER_ID, 'грюковы');
    new UserRepository(db).create({ telegram_id: 999, timezone: 'UTC' });
    const notMine = ctx.contactRepo!.add(999, 'Not Mine');
    const result = handleAddContactGroupMember(ctx, { group_id: group.id, contact_id: notMine.id });
    expect(result.success).toBe(false);
  });

  test('remove_contact_group_member removes membership without deleting the contact', () => {
    const group = ctx.contactDirectory!.contactGroupRepo.create(USER_ID, 'грюковы');
    const anna = ctx.contactRepo!.add(USER_ID, 'Anna Gryukova');
    ctx.contactDirectory!.contactGroupRepo.addMember(USER_ID, group.id, anna.id);
    const result = handleRemoveContactGroupMember(ctx, { group_id: group.id, contact_id: anna.id });
    expect(result.success).toBe(true);
    expect(ctx.contactRepo!.findById(USER_ID, anna.id)).not.toBeNull();
  });

  test('delete_contact_group removes the group, not its members', () => {
    const group = ctx.contactDirectory!.contactGroupRepo.create(USER_ID, 'грюковы');
    const anna = ctx.contactRepo!.add(USER_ID, 'Anna Gryukova');
    ctx.contactDirectory!.contactGroupRepo.addMember(USER_ID, group.id, anna.id);
    expect(handleDeleteContactGroup(ctx, { group_id: group.id }).success).toBe(true);
    expect(handleListContactGroups(ctx).output).not.toContain('грюковы');
    expect(ctx.contactRepo!.findById(USER_ID, anna.id)).not.toBeNull();
  });

  test('resolve_contact exact_unique carries the matched contact in data.matches', () => {
    const contact = ctx.contactRepo!.add(USER_ID, 'Vova');
    const result = handleResolveContact(ctx, { query: 'vova' });
    expect(result.success).toBe(true);
    expect(matchedIds(result)).toEqual([contact.id]);
  });

  test('resolve_contact exact_ambiguous asks — never silently picks one of two same-alias contacts', () => {
    const lena1 = ctx.contactRepo!.add(USER_ID, 'Лена');
    const lena2 = ctx.contactRepo!.add(USER_ID, 'Другая Лена');
    ctx.contactDirectory!.contactAliasRepo.add(USER_ID, lena2.id, 'Лена', 'manual');
    const result = handleResolveContact(ctx, { query: 'Лена' });
    expect(result.success).toBe(true);
    expect(matchedIds(result).sort()).toEqual([lena1.id, lena2.id].sort());
    expect(result.agentHint).toContain('ask the user');
  });

  test('resolve_contact exact_group expands every member with no per-member confirmation hint', () => {
    const group = ctx.contactDirectory!.contactGroupRepo.create(USER_ID, 'грюковы');
    const anna = ctx.contactRepo!.add(USER_ID, 'Anna Gryukova');
    const boris = ctx.contactRepo!.add(USER_ID, 'Boris Gryukov');
    ctx.contactDirectory!.contactGroupRepo.addMember(USER_ID, group.id, anna.id);
    ctx.contactDirectory!.contactGroupRepo.addMember(USER_ID, group.id, boris.id);
    const result = handleResolveContact(ctx, { query: 'грюковы' });
    expect(result.success).toBe(true);
    expect(matchedIds(result).sort()).toEqual([anna.id, boris.id].sort());
    expect(result.agentHint).not.toContain('ask the user');
  });

  test('resolve_contact fuzzy_confirm always needs confirmation, even with one candidate', () => {
    ctx.contactRepo!.add(USER_ID, 'Елена');
    const result = handleResolveContact(ctx, { query: 'Лена' });
    expect(result.success).toBe(true);
    expect(matchedIds(result)).toHaveLength(1);
    expect(result.agentHint).toContain('confirm');
  });

  test('resolve_contact returns none for an unknown query', () => {
    const result = handleResolveContact(ctx, { query: 'Nobody' });
    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
  });
});
