import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { _resetToolThrottleForTest, executeTool } from '../../src/services/ai/tool-executor.ts';
import {
  handleAddContact,
  handleFindContact,
  handleGetContacts,
} from '../../src/services/ai/tool-handlers/contacts.ts';
import { handleFindUser } from '../../src/services/ai/tool-handlers/meta.ts';
import { handleResendInvitation, handleSendInvitation } from '../../src/services/ai/tool-handlers/sharing.ts';
import { getToolDefinitions } from '../../src/services/ai/tools.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { InvitationService } from '../../src/services/sharing/invitation-service.ts';

function makeCtx(db: Database, overrides: Partial<AgentContext> = {}): AgentContext {
  const users = new UserRepository(db);
  const events = new EventRepository(db);
  const invitations = new InvitationRepository(db);
  return {
    user: users.findByTelegramId(10)!,
    chatId: 10,
    messageText: 'Invite Alex',
    isGroup: false,
    userRepo: users,
    contactRepo: new ContactRepository(db),
    eventService: new EventService({ eventRepo: events }),
    sharing: {
      invitationRepo: invitations,
      invitationService: new InvitationService(invitations, events, new SharingSettingsRepository(db)),
    },
    ...overrides,
  } as unknown as AgentContext;
}

describe('recipient and contact tool boundaries', () => {
  let db: Database;
  let ctx: AgentContext;
  beforeEach(() => {
    _resetToolThrottleForTest();
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    users.create({ telegram_id: 10, timezone: 'UTC', language: 'en' });
    users.create({ telegram_id: 5000000001, timezone: 'UTC', username: 'knownalex' });
    ctx = makeCtx(db);
    ctx.contactRepo!.upsert(10, 'Alex', 'knownalex', 5000000001);
  });
  afterEach(() => db.close());

  test('contact lookup exposes stable row ID and actual creation time', () => {
    const contact = ctx.contactRepo!.list(10)[0]!;
    const result = handleFindContact(ctx, { name: 'Alex' });
    expect(result.output).toContain(`contact_id: ${contact.id}`);
    expect(result.output).toContain(contact.created_at);
    expect(handleGetContacts(ctx, {}).output).toContain(`contact_id:${contact.id}`);
  });

  test('numeric contact search means an exact Telegram ID, not a fuzzy name', () => {
    const result = handleFindContact(ctx, { name: '5000000001' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('knownalex');
  });

  test('saving an invented username cannot bootstrap recipient verification', async () => {
    const saved = handleAddContact(ctx, { name: 'Someone', username: 'invented_handle' });
    expect(saved.success).toBe(false);
    expect(ctx.contactRepo!.findByUsername(10, 'invented_handle')).toBeNull();
    const lookedUp = await handleFindUser(ctx, { username: 'invented_handle' });
    expect(lookedUp.success).toBe(false);
  });

  test('plain name is not silently resolved as an unrelated public username', async () => {
    const resolve = mock(async () => ({ id: 5000000002, firstName: 'Stranger', username: 'alex' }));
    const result = await handleFindUser(makeCtx(db, { resolveUsername: resolve }), { username: 'alex' });
    expect(result.success).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(result.agentHint).toContain('find_contact');
  });

  test('an explicit @handle can intentionally identify a different person', async () => {
    const resolve = mock(async () => ({ id: 5000000002, firstName: 'Stranger', username: 'alex' }));
    const result = await handleFindUser(makeCtx(db, { messageText: 'Invite @alex', resolveUsername: resolve }), {
      username: 'alex',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ telegram_id: 5000000002, name: 'Stranger' });
  });

  test('delete_contact is advertised and deletes only the owned address-book row', async () => {
    const contact = ctx.contactRepo!.list(10)[0]!;
    expect(getToolDefinitions().some((t) => t.type === 'function' && t.function.name === 'delete_contact')).toBe(true);
    const result = await executeTool(ctx, 'delete_contact', { contact_id: contact.id });
    expect(result.success).toBe(true);
    expect(ctx.contactRepo!.list(10)).toEqual([]);
    expect(ctx.userRepo.findByTelegramId(5000000001)).not.toBeNull();
    expect(result.data).toEqual({ contact_id: contact.id, deleted: true });
  });

  test('foreign contact primary key cannot delete another user contact', async () => {
    const other = ctx.contactRepo!.add(5000000001, 'Private');
    await executeTool(ctx, 'delete_contact', { contact_id: other.id });
    expect(ctx.contactRepo!.findById(5000000001, other.id)).not.toBeNull();
  });

  test('unsafe and ambiguous delete arguments are rejected without mutations', async () => {
    for (const input of [{ contact_id: -1 }, { contact_id: 1.5 }, { contact_id: null }, { search: 'Alex' }]) {
      expect((await executeTool(ctx, 'delete_contact', input)).success).toBe(false);
    }
    expect(ctx.contactRepo!.list(10)).toHaveLength(1);
  });

  test('ID and username mismatch does not create an invitation or a contact', async () => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Synthetic',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const result = await handleSendInvitation(ctx, {
      event_id: event.id,
      invitee_id: 5000000002,
      invitee_username: 'knownalex',
    });
    expect(result.success).toBe(false);
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
    expect(ctx.contactRepo!.list(10)).toHaveLength(1);
  });

  test('unverified numeric ID is not auto-saved as a placeholder contact', async () => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Synthetic',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000002 });
    expect(result.success).toBe(false);
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
    expect(ctx.contactRepo!.list(10)).toHaveLength(1);
  });

  test('a stored autogenerated placeholder is not identity verification', async () => {
    ctx.contactRepo!.add(10, 'User 5000000002', undefined, 5000000002);
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Synthetic',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    expect((await handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000002 })).success).toBe(false);
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
  });

  test('fresh absence of username survives automatic contact persistence', async () => {
    ctx.lookupTelegramUser = async (id) => ({ id, firstName: 'Current', username: undefined });
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Synthetic',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000001 });
    expect(result.success).toBe(true);
    expect(ctx.contactRepo!.findByTelegramId(10, 5000000001)?.username).toBeNull();
  });

  test('global bot registration alone is not evidence of intended recipient', async () => {
    ctx.contactRepo!.deleteOwned(10, ctx.contactRepo!.list(10)[0]!.id);
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Synthetic',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000001 });
    expect(result.success).toBe(false);
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
  });

  test('conflict confirmation displays both numeric identities and escaped profile text', async () => {
    ctx.messageText = 'Invite @different';
    ctx.resolveUsername = async () => ({ id: 5000000002, firstName: '<b>Different</b>', username: 'different' });
    let shown = '';
    ctx.sender = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      sendMessageWithKeyboard: async (_chat, text) => {
        shown = text;
        return { message_id: 1 };
      },
    };
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Synthetic',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const result = await handleSendInvitation(ctx, {
      event_id: event.id,
      invitee_id: 5000000001,
      invitee_username: 'different',
    });
    expect(result.success).toBe(false);
    expect(shown).toContain('5000000001');
    expect(shown).toContain('5000000002');
    expect(shown).toContain('Alex');
    expect(shown).toContain('&lt;b&gt;Different&lt;/b&gt;');
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
  });

  test('a historical group username cannot turn a resend into a personal identity conflict', async () => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Synthetic group',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const invitation = ctx.sharing!.invitationService.sendInvitation(event.id, 10, -100500, 'old_group').invitation!;
    const kinds: string[] = [];
    ctx.sender = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      sendInvitation: async (...args) => {
        kinds.push(args[4]?.kind ?? 'personal');
        return { message_id: 1 };
      },
    };
    const result = await handleResendInvitation(ctx, { invitation_id: invitation.id });
    expect(result.success).toBe(true);
    expect(kinds).toEqual(['group']);
  });

  test('initial group delivery uses group RSVP and never adds a personal contact', async () => {
    const variants: string[] = [];
    ctx.sender = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      sendInvitation: async (...args) => {
        variants.push(args[4]?.kind ?? 'personal');
        return { message_id: 1 };
      },
    };
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Synthetic',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    expect((await handleSendInvitation(ctx, { event_id: event.id, invitee_id: -100001 })).success).toBe(true);
    expect(variants).toEqual(['group']);
    expect(ctx.contactRepo!.list(10)).toHaveLength(1);
  });
  test('resend cannot route an existing invite to an inconsistent username', async () => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Synthetic',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const invitation = ctx.sharing!.invitationService.sendInvitation(event.id, 10, 5000000001).invitation!;
    const send = mock(async () => ({ message_id: 1 }));
    ctx.sender = { sendMessage: send, editMessageText: async () => {}, sendInvitation: send };
    ctx.messageText = 'Resend to @different';
    ctx.resolveUsername = async () => ({ id: 5000000002, username: 'different' });
    const result = await handleResendInvitation(ctx, { invitation_id: invitation.id, invitee_username: 'different' });
    expect(result.success).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
