// Characterization tests for handleUpdateContact / handleGetUserInfo guard and outcome branches
// (null-deletion rejection, username confirmation, identity conflicts, repo conflict mapping,
// private-chat gating, recipient verification, profile caching/refresh).
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { t } from '../../../../src/config/constants.ts';
import { migrations } from '../../../../src/database/migrations.ts';
import { ContactRepository } from '../../../../src/database/repositories/contact.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleGetUserInfo, handleUpdateContact } from '../../../../src/services/ai/tool-handlers/contacts.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

const OWNER = 10;
const meta = t('en').aiTools.meta;

describe('contacts handlers: update_contact and get_user_info branches', () => {
  let db: Database;
  let ctx: AgentContext;
  let contacts: ContactRepository;
  let users: UserRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    users = new UserRepository(db);
    users.create({ telegram_id: OWNER, timezone: 'UTC', language: 'en' });
    users.create({ telegram_id: 777, timezone: 'UTC', username: 'cached777' });
    users.create({ telegram_id: 888, timezone: 'UTC', username: 'cached888' });
    contacts = new ContactRepository(db);
    ctx = {
      user: users.findByTelegramId(OWNER)!,
      chatId: OWNER,
      messageText: '',
      isGroup: false,
      userRepo: users,
      contactRepo: contacts,
    } as unknown as AgentContext;
  });
  afterEach(() => db.close());

  describe('handleUpdateContact', () => {
    test('requires contactRepo', () => {
      const result = handleUpdateContact({ ...ctx, contactRepo: undefined } as AgentContext, {
        search: 'x',
        name: 'y',
      });
      expect(result).toEqual({ success: false, error: 'Contacts not configured.' });
    });

    test('unknown contact is reported by query', () => {
      expect(handleUpdateContact(ctx, { search: 'Ghost', name: 'G' })).toEqual({
        success: false,
        error: 'No contact named "Ghost" in address book.',
      });
    });

    test('literal "null" in any field is routed to delete_contact with the contact id', () => {
      const row = contacts.add(OWNER, 'Alex');
      for (const input of [{ name: ' Null ' }, { preferred_name: 'NULL' }, { username: 'null' }]) {
        const result = handleUpdateContact(ctx, { search: 'Alex', ...input });
        expect(result.success).toBe(false);
        expect(result.error).toBe(meta.contactDeleteRequiresTool);
        expect(result.agentHint).toBe(
          `Use delete_contact with contact_id ${row.id} for the explicit deletion request.`,
        );
      }
      expect(contacts.findById(OWNER, row.id)?.name).toBe('Alex');
    });

    test('no updatable fields yields an explicit error', () => {
      contacts.add(OWNER, 'Alex');
      expect(handleUpdateContact(ctx, { search: 'Alex' })).toEqual({
        success: false,
        error: 'No fields to update provided.',
      });
    });

    test('username that was never confirmed by the user is rejected', () => {
      const row = contacts.add(OWNER, 'Alex');
      const result = handleUpdateContact(ctx, { search: 'Alex', username: 'invented' });
      expect(result).toEqual({ success: false, error: meta.recipientUsernameUnconfirmed });
      expect(contacts.findById(OWNER, row.id)?.username).toBeNull();
    });

    test('explicit username binds the cached Telegram ID for an unlinked contact', () => {
      const row = contacts.add(OWNER, 'Alex');
      ctx.messageText = 'save @cached777 for Alex';
      const result = handleUpdateContact(ctx, { search: 'Alex', username: '@cached777' });
      expect(result.success).toBe(true);
      expect(result.output).toBe(meta.contactUpdated('"Alex" (@cached777)'));
      expect(contacts.findById(OWNER, row.id)).toMatchObject({ username: 'cached777', telegram_id: 777 });
    });

    test('username whose cached account differs from the linked contact is an identity conflict', () => {
      const row = contacts.upsert(OWNER, 'Alex', 'cached777', 777);
      ctx.messageText = 'now @cached888';
      const result = handleUpdateContact(ctx, { search: 'Alex', username: 'cached888' });
      expect(result).toEqual({ success: false, error: meta.recipientIdentityConflict });
      expect(contacts.findById(OWNER, row.id)).toMatchObject({ username: 'cached777', telegram_id: 777 });
    });

    test('repository identity conflict maps to a not_applied result', () => {
      contacts.add(OWNER, 'Alex');
      const repo = Object.create(contacts) as ContactRepository;
      repo.update = () => {
        throw new Error('CONTACT_IDENTITY_CONFLICT: boom');
      };
      const result = handleUpdateContact({ ...ctx, contactRepo: repo } as AgentContext, {
        search: 'Alex',
        preferred_name: 'Al',
      });
      expect(result).toEqual({
        success: false,
        mutationState: 'not_applied',
        error: meta.recipientIdentityConflict,
      });
    });

    test('other repository errors propagate', () => {
      contacts.add(OWNER, 'Alex');
      const repo = Object.create(contacts) as ContactRepository;
      repo.update = () => {
        throw new Error('disk on fire');
      };
      expect(() =>
        handleUpdateContact({ ...ctx, contactRepo: repo } as AgentContext, { search: 'Alex', preferred_name: 'Al' }),
      ).toThrow('disk on fire');
    });

    test('success label prefers preferred_name over name', () => {
      contacts.add(OWNER, 'Alexander');
      const result = handleUpdateContact(ctx, { search: 'Alexander', preferred_name: 'Sasha' });
      expect(result.output).toBe(meta.contactUpdated('"Sasha"'));
    });

    test('ambiguous exact-name ties ask the user to choose', () => {
      contacts.add(OWNER, 'Lena');
      const other = contacts.add(OWNER, 'Elena');
      contacts.update(other.id, { preferred_name: 'lena' });
      const result = handleUpdateContact(ctx, { search: 'Lena', name: 'L' });
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'Multiple contacts match "Lena". Ask the user which one to update:\n- contact_id:',
      );
    });
  });

  describe('handleGetUserInfo', () => {
    test('requires a private chat with a contact repository', async () => {
      const group = await handleGetUserInfo({ ...ctx, isGroup: true } as AgentContext, { telegram_id: 777 });
      expect(group).toEqual({ success: false, error: meta.contactsPrivateOnly });
      const noRepo = await handleGetUserInfo({ ...ctx, contactRepo: undefined } as AgentContext, { telegram_id: 777 });
      expect(noRepo).toEqual({ success: false, error: meta.contactsPrivateOnly });
    });

    test('an ID the user never supplied or saved is unverified', async () => {
      const result = await handleGetUserInfo(ctx, { telegram_id: 777 });
      expect(result).toEqual({ success: false, error: meta.recipientUnverified });
    });

    test('own ID needs no prior verification and falls back to cached data without a service account', async () => {
      const result = await handleGetUserInfo(ctx, { telegram_id: OWNER });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        telegram_id: OWNER,
        display_name: null,
        preferred_name: null,
        username: null,
        contact_created_at: null,
        profile_checked_at: null,
        profile_source: 'cached',
        deleted: null,
      });
      expect(result.output).toBe(meta.userInfo(JSON.stringify(result.data, null, 2)));
      expect(result.agentHint).toStartWith('ID is authoritative.');
    });

    test('saved contact supplies cached metadata when the live lookup is unavailable', async () => {
      const row = contacts.upsert(OWNER, 'Alex', 'alexh', 777);
      contacts.update(row.id, { preferred_name: 'Sasha' });
      const result = await handleGetUserInfo(ctx, { telegram_id: 777 });
      expect(result.data).toMatchObject({
        telegram_id: 777,
        display_name: 'Alex',
        preferred_name: 'Sasha',
        username: 'alexh',
        profile_source: 'cached',
        deleted: null,
      });
    });

    test('a live profile answering for a different ID is an identity conflict', async () => {
      ctx.messageText = 'inspect 777';
      ctx.lookupTelegramUser = async () => ({ id: 999, firstName: 'Other' });
      expect(await handleGetUserInfo(ctx, { telegram_id: 777 })).toEqual({
        success: false,
        error: meta.recipientIdentityConflict,
      });
    });

    test('a live profile wins and refreshes the saved contact', async () => {
      const row = contacts.upsert(OWNER, 'Alex', 'oldhandle', 777);
      ctx.lookupTelegramUser = async (id) => ({ id, username: 'newhandle', firstName: 'Alexander' });
      const result = await handleGetUserInfo(ctx, { telegram_id: 777 });
      expect(result.data).toMatchObject({
        display_name: 'Alexander',
        username: 'newhandle',
        profile_source: 'telegram',
      });
      expect(contacts.findById(OWNER, row.id)?.username).toBe('newhandle');
    });

    test('a deleted live profile is reported and does not rewrite the saved contact', async () => {
      const row = contacts.upsert(OWNER, 'Alex', 'oldhandle', 777);
      ctx.lookupTelegramUser = async (id) => ({ id, firstName: 'Deleted Account', deleted: true });
      const result = await handleGetUserInfo(ctx, { telegram_id: 777 });
      expect(result.data).toMatchObject({ profile_source: 'telegram', deleted: true, username: null });
      expect(contacts.findById(OWNER, row.id)?.username).toBe('oldhandle');
    });
  });
});
