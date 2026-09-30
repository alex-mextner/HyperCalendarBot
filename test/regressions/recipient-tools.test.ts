import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createCallbackHandler } from '../../src/bot/handlers/callback.handler.ts';
import { migrations } from '../../src/database/migrations.ts';
import { ActionLogRepository } from '../../src/database/repositories/action-log.repository.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { DeepLinkRepository } from '../../src/database/repositories/deep-link.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { GroupChatRepository } from '../../src/database/repositories/group-chat.repository.ts';
import { GroupMemberRepository } from '../../src/database/repositories/group-member.repository.ts';
import { InvitationRepository } from '../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import type { User } from '../../src/database/types.ts';
import { toolResultContent } from '../../src/services/ai/agent.ts';
import { issueRecipientApproval } from '../../src/services/ai/recipient-confirmation.ts';
import { _resetToolThrottleForTest, executeTool } from '../../src/services/ai/tool-executor.ts';
import {
  handleAddContact,
  handleFindContact,
  handleGetContacts,
  handleGetUserInfo,
  handleUpdateContact,
} from '../../src/services/ai/tool-handlers/contacts.ts';
import { handleFindUser } from '../../src/services/ai/tool-handlers/meta.ts';
import { handleResendInvitation, handleSendInvitation } from '../../src/services/ai/tool-handlers/sharing.ts';
import { getToolDefinitions } from '../../src/services/ai/tools.ts';
import type { AgentContext, ContactMatch, ToolResult } from '../../src/services/ai/types.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { GroupMemberService } from '../../src/services/group/member-service.ts';
import { DeepLinkService } from '../../src/services/sharing/deep-link-service.ts';
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

function groupCapability(
  db: Database,
  checkGroupMembership: () => Promise<boolean>,
): NonNullable<AgentContext['group']> {
  const groupMemberRepo = new GroupMemberRepository(db);
  return {
    checkGroupMembership,
    groupMemberRepo,
    groupChatRepo: new GroupChatRepository(db),
    groupMemberService: new GroupMemberService(groupMemberRepo, new UserRepository(db)),
  };
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

  test('matching global ID plus guessed username supplies no intent evidence', async () => {
    ctx.contactRepo!.deleteOwned(10, ctx.contactRepo!.list(10)[0]!.id);
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Intent',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const result = await handleSendInvitation(ctx, {
      event_id: event.id,
      invitee_id: 5000000001,
      invitee_username: 'knownalex',
    });
    expect(result.success).toBe(false);
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
    expect(ctx.contactRepo!.list(10)).toHaveLength(0);
  });

  test('name-only update cannot launder either registered or unknown guessed usernames', async () => {
    ctx.contactRepo!.deleteOwned(10, ctx.contactRepo!.list(10)[0]!.id);
    const row = ctx.contactRepo!.add(10, 'Alex');
    for (const username of ['knownalex', 'invented_handle']) {
      expect(handleUpdateContact(ctx, { search: 'Alex', username }).success).toBe(false);
      expect(ctx.contactRepo!.findById(10, row.id)).toMatchObject({ username: null, telegram_id: null });
      expect((await handleFindUser(ctx, { username })).success).toBe(false);
    }
    ctx.messageText = 'Save @knownalex';
    expect(handleUpdateContact(ctx, { search: 'Alex', username: 'knownalex' }).success).toBe(true);
    expect(ctx.contactRepo!.findById(10, row.id)?.telegram_id).toBe(5000000001);
  });

  test('resend keeps historical numeric identity after contact metadata disappears', async () => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Resend',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const invitation = ctx.sharing!.invitationService.sendInvitation(event.id, 10, 5000000001, 'knownalex').invitation!;
    ctx.contactRepo!.deleteOwned(10, ctx.contactRepo!.list(10)[0]!.id);
    const send = mock(async (_id: number) => ({ message_id: 1 }));
    ctx.sender = { sendMessage: send, editMessageText: async () => {}, sendInvitation: send };
    expect((await handleResendInvitation(ctx, { invitation_id: invitation.id })).success).toBe(true);
    expect(send.mock.calls[0]?.[0]).toBe(5000000001);
  });

  test('get_user_info reports only the saved contact and rechecks owner scope', async () => {
    const result = await handleGetUserInfo(ctx, { telegram_id: 5000000001 });
    expect(result.data).toEqual({
      telegram_id: 5000000001,
      display_name: 'Alex',
      preferred_name: null,
      username: 'knownalex',
      contact_created_at: expect.any(String),
    });
    ctx.contactRepo!.deleteOwned(10, ctx.contactRepo!.list(10)[0]!.id);
    expect((await handleGetUserInfo(ctx, { telegram_id: 5000000001 })).success).toBe(false);
    ctx.messageText = 'Inspect 5000000002';
    expect((await handleGetUserInfo(ctx, { telegram_id: 5000000002 })).data).toEqual({
      telegram_id: 5000000002,
      display_name: null,
      preferred_name: null,
      username: null,
      contact_created_at: null,
    });
  });

  test('inspection is audited, never rewrites contacts, and checks privacy again on repeated execution', async () => {
    ctx.actionLogRepo = new ActionLogRepository(db);
    const old = ctx.contactRepo!.list(10)[0]!;
    ctx.contactRepo!.update(old.id, { preferred_name: 'Sasha' });
    const other = ctx.contactRepo!.add(10, 'Other', 'reassigned', 5000000002, 'Friend');
    const result = await executeTool(ctx, 'get_user_info', { telegram_id: 5000000001 });
    expect(result.data).toMatchObject({ telegram_id: 5000000001, username: 'knownalex', preferred_name: 'Sasha' });
    expect(ctx.contactRepo!.findById(10, old.id)).toMatchObject({ telegram_id: 5000000001, username: 'knownalex' });
    expect(ctx.contactRepo!.findById(10, other.id)).toMatchObject({
      telegram_id: 5000000002,
      username: 'reassigned',
      preferred_name: 'Friend',
    });
    expect(ctx.actionLogRepo.query({ action_name: 'get_user_info' })).toHaveLength(1);
    expect(ctx.actionLogRepo.query({ action_name: 'get_user_info' })[0]?.target_user_id).toBe(5000000001);
    ctx.isGroup = true;
    expect((await executeTool(ctx, 'get_user_info', { telegram_id: 5000000001 })).success).toBe(false);
  });

  for (const mode of [
    'ack rejection',
    'missing continuation',
    'continuation rejection',
    'concurrent',
    'failure after consumption',
  ] as const) {
    test(`actual recipient callback: ${mode}`, async () => {
      const event = ctx.eventService.createEvent({
        user_id: 10,
        title: 'Callback',
        start_at: new Date(Date.now() + 86400000).toISOString(),
        timezone: 'UTC',
      });
      const token = issueRecipientApproval(10, event.id, 5000000002);
      const button = {
        data: `ric:${token}`,
        dbUser: ctx.user,
        from: { id: 10 },
        chatId: 10,
        answer: async () => {
          if (mode === 'ack rejection') throw new Error('ack failed');
        },
      };
      let calls = 0;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const continueAi = async (continuation: AgentContext) => {
        expect(continuation.user.telegram_id).toBe(10);
        expect(continuation.chatId).toBe(10);
        expect(continuation.messageText).toContain(`Confirmed recipient Telegram ID 5000000002 for event ${event.id}.`);
        calls++;
        if (mode === 'continuation rejection' && calls === 1) throw new Error('retry before tool');
        if (mode === 'concurrent') await gate;
        for (const input of [
          { event_id: event.id + 1, invitee_id: 5000000002, force: true },
          { event_id: event.id, invitee_id: 5000000003, force: true },
        ])
          expect((await handleSendInvitation(ctx, input)).success).toBe(false);
        expect(
          (await handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000002, force: true })).success,
        ).toBe(true);
        if (mode === 'failure after consumption') throw new Error('failed after send');
        return { responseText: '', toolCalls: [], toolResults: [] };
      };
      const agentContinuation = {
        agent: { run: continueAi },
        buildContext: (user: User, chatId: number, messageText: string): AgentContext => ({
          ...ctx,
          user,
          chatId,
          messageText,
          conversationLogger: new ConversationLogger(new ChatHistoryRepository(db)),
        }),
      };
      const handler = createCallbackHandler(ctx.eventService, {} as never, {} as never, {} as never, {
        agentContinuation,
      });
      await handler({ ...button, from: { id: 11 }, chatId: 11 } as never);
      await handler({ ...button, dbUser: { ...ctx.user, telegram_id: 11 }, from: { id: 11 }, chatId: 11 } as never);
      await handler({ ...button, chatId: -100 } as never);
      expect(calls).toBe(0);
      if (mode === 'missing continuation')
        await createCallbackHandler(ctx.eventService, {} as never, {} as never, {} as never)(button as never);
      const first = handler(button as never);
      if (mode === 'concurrent') {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await handler(button as never);
        expect(calls).toBe(1);
        release();
      }
      await first;
      if (mode === 'continuation rejection') await handler(button as never);
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(1);
      await handler(button as never);
      expect(calls).toBe(mode === 'continuation rejection' ? 2 : 1);
      expect(
        (await handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000002, force: true })).success,
      ).toBe(false);
    });
  }

  test('fresh null username survives the automatic insertion branch and both transport arguments', async () => {
    ctx.contactRepo!.deleteOwned(10, ctx.contactRepo!.list(10)[0]!.id);
    ctx.messageText = 'Invite 5000000001';
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Insert',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    ctx.deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
    ctx.botUsername = 'synthetic_bot';
    const targets: number[] = [];
    const hints: (string | undefined)[] = [];
    ctx.sender = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      sendInvitation: async (id) => {
        targets.push(id);
        return null;
      },
      sendAsConnectedUser: async (_inviterId, id, _text, hint) => {
        targets.push(id);
        hints.push(hint);
        return true;
      },
    };
    expect((await handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000001 })).success).toBe(true);
    expect(ctx.contactRepo!.findByTelegramId(10, 5000000001)).toMatchObject({ username: null });
    expect(targets).toEqual([5000000001, 5000000001]);
    expect(hints).toEqual([undefined]);
  });

  test('accepted invitation cannot be sent again or resent', async () => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Accepted',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const invitation = ctx.sharing!.invitationService.sendInvitation(event.id, 10, 5000000001).invitation!;
    ctx.sharing!.invitationRepo.updateStatus(invitation.id, 'accepted', 'pending');
    const send = mock(async (_id: number) => ({ message_id: 1 }));
    ctx.sender = { sendMessage: send, editMessageText: async () => {}, sendInvitation: send };
    expect((await handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000001 })).success).toBe(false);
    expect((await handleResendInvitation(ctx, { invitation_id: invitation.id })).success).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(1);
  });

  test('an explicit username is re-checked against the users table, not the saved contact', async () => {
    db.run('UPDATE users SET username = NULL WHERE telegram_id = 5000000001');
    new UserRepository(db).create({ telegram_id: 5000000002, timezone: 'UTC', username: 'knownalex' });
    ctx.messageText = 'Invite @knownalex';
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Fresh conflict',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    expect(
      (await handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000001, invitee_username: 'knownalex' }))
        .success,
    ).toBe(false);
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
  });

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

  test('plain name is not silently resolved as an unrelated bot user', async () => {
    new UserRepository(db).create({
      telegram_id: 5000000002,
      timezone: 'UTC',
      username: 'alex',
      first_name: 'Stranger',
    });
    const result = await handleFindUser(makeCtx(db), { username: 'alex' });
    expect(result.success).toBe(false);
    expect(result.agentHint).toContain('find_contact');
  });

  test('an explicit @handle can intentionally identify a different person', async () => {
    new UserRepository(db).create({
      telegram_id: 5000000002,
      timezone: 'UTC',
      username: 'alex',
      first_name: 'Stranger',
    });
    const result = await handleFindUser(makeCtx(db, { messageText: 'Invite @alex' }), { username: 'alex' });
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
    new UserRepository(db).create({
      telegram_id: 5000000002,
      timezone: 'UTC',
      username: 'different',
      first_name: '<b>Different</b>',
    });
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
    expect(result.success).toBe(true);
    expect(result.awaitingInput).toEqual({ kind: 'chat' });
    expect(result.mutationState).toBe('not_applied');
    expect(shown).toContain('5000000001');
    expect(shown).toContain('5000000002');
    expect(shown).toContain('Alex');
    expect(shown).toContain('&lt;b&gt;Different&lt;/b&gt;');
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
  });

  test('a historical group username cannot turn a resend into a personal identity conflict', async () => {
    ctx.group = groupCapability(db, async () => true);
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
    ctx.verifiedRecipientIds = new Set([-100001]); // Trusted group selection, not an invented target.
    ctx.group = groupCapability(db, async () => true);
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
    const send = mock(async (_id: number) => ({ message_id: 1 }));
    ctx.sender = { sendMessage: send, editMessageText: async () => {}, sendInvitation: send };
    ctx.messageText = 'Resend to @different';
    new UserRepository(db).create({ telegram_id: 5000000002, timezone: 'UTC', username: 'different' });
    const result = await handleResendInvitation(ctx, { invitation_id: invitation.id, invitee_username: 'different' });
    expect(result.success).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  test('numeric identity confirmation is a waiting handoff, not a failed mutation', async () => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Synthetic confirmation',
      start_at: '2035-01-01T12:00:00Z',
      timezone: 'UTC',
    });
    ctx.messageText = 'Invite @different_person';
    new UserRepository(db).create({ telegram_id: 5000000002, timezone: 'UTC', username: 'different_person' });
    ctx.sender = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      sendMessageWithKeyboard: async () => ({ message_id: 2 }),
    };
    const result = await executeTool(ctx, 'send_invitation', {
      event_id: event.id,
      invitee_id: 5000000001,
      invitee_username: 'different_person',
    });
    expect(result.disposition).toBe('waiting');
    expect(result.mutationState).toBe('not_applied');
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
  });
  test('an arbitrary negative group ID is not implicit recipient authority', async () => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Group authority',
      start_at: '2035-01-01T12:00:00Z',
      timezone: 'UTC',
    });
    const send = mock(async () => ({ message_id: 1 }));
    ctx.sender = { sendMessage: send, editMessageText: async () => {}, sendInvitation: send };
    const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: -1009999 });
    expect(result.success).toBe(false);
    expect(result.mutationState).toBe('not_applied');
    expect(send).not.toHaveBeenCalled();
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
  });
  test('noncurrent group requires membership capability even with verified intent', async () => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Membership boundary',
      start_at: '2035-01-01T12:00:00Z',
      timezone: 'UTC',
    });
    ctx.verifiedRecipientIds = new Set([-100001]);
    const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: -100001 });
    expect(result.success).toBe(false);
    expect(result.mutationState).toBe('not_applied');
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
  });

  test.each(['revoked', 'outage'])('verified intent never overrides group membership %s', async (mode) => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Membership boundary',
      start_at: '2035-01-01T12:00:00Z',
      timezone: 'UTC',
    });
    ctx.verifiedRecipientIds = new Set([-100001]);
    ctx.group = groupCapability(db, async () => {
      if (mode === 'outage') throw new Error('Synthetic outage');
      return false;
    });
    const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: -100001 });
    expect(result.success).toBe(false);
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
  });

  describe('address-book contact_id is never a Telegram recipient', () => {
    function lookupMatches(result: ToolResult): ContactMatch[] {
      const data = result.data;
      if (!data || Array.isArray(data) || !('matches' in data)) throw new Error('expected find_contact matches');
      return data.matches;
    }

    function inviteContext() {
      const event = ctx.eventService.createEvent({
        user_id: 10,
        title: 'Contact recipient',
        start_at: new Date(Date.now() + 86400000).toISOString(),
        timezone: 'UTC',
      });
      const approvals = mock(async () => ({ message_id: 2 }));
      const sendInvitationCalls = mock(async (_id: number) => ({ message_id: 3 }));
      ctx.sender = {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => {},
        sendMessageWithKeyboard: approvals,
        sendInvitation: sendInvitationCalls,
      };
      return { event, approvals, sendInvitationCalls };
    }

    test('a name-only contact routes to pick_users instead of an approval for its row id', async () => {
      const { event, approvals, sendInvitationCalls } = inviteContext();
      ctx.messageText = 'Invite Bora Example from my contacts';
      expect((await executeTool(ctx, 'add_contact', { name: 'Bora Example' })).success).toBe(true);
      const found = await executeTool(ctx, 'find_contact', { name: 'Bora Example' });
      const [match] = lookupMatches(found);
      expect(match?.telegram_id).toBeNull();
      expect(found.output).toContain('telegram_id: none');
      expect(found.agentHint).toContain('pick_users');
      const listed = await executeTool(ctx, 'get_contacts', {});
      expect(listed.output).toMatch(/Bora Example — contact_id:\d+ — .*telegram_id:none/);
      expect(listed.agentHint).toContain('pick_users');

      const result = await executeTool(ctx, 'send_invitation', { event_id: event.id, invitee_id: match!.id });
      expect(result.success).toBe(false);
      expect(result.mutationState).toBe('not_applied');
      expect(result.error).toContain('Bora Example');
      expect(toolResultContent(result)).toContain('pick_users');
      expect(approvals).not.toHaveBeenCalled();
      const forced = await executeTool(ctx, 'send_invitation', {
        event_id: event.id,
        invitee_id: match!.id,
        force: true,
      });
      expect(forced.success).toBe(false);
      expect(sendInvitationCalls).not.toHaveBeenCalled();
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
    });

    test('a contact with only a saved @username is invited by that username after a row-id attempt', async () => {
      const { event, approvals, sendInvitationCalls } = inviteContext();
      ctx.messageText = 'Invite Bora Example from my contacts';
      new UserRepository(db).create({ telegram_id: 5000000003, timezone: 'UTC', username: 'boraex' });
      const row = ctx.contactRepo!.add(10, 'Bora Example', 'boraex');

      const byRow = await executeTool(ctx, 'send_invitation', { event_id: event.id, invitee_id: row.id });
      expect(byRow.success).toBe(false);
      expect(byRow.mutationState).toBe('not_applied');
      expect(byRow.error).toContain('Bora Example');
      expect(toolResultContent(byRow)).toContain('invitee_username boraex');
      expect(approvals).not.toHaveBeenCalled();

      const invited = await executeTool(ctx, 'send_invitation', { event_id: event.id, invitee_username: 'boraex' });
      expect(invited.success).toBe(true);
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id).map((i) => i.invitee_id)).toEqual([5000000003]);
      expect(sendInvitationCalls.mock.calls.map(([id]) => id)).toEqual([5000000003]);
    });

    test('a "User N" placeholder left by approving the row id does not legitimize it', async () => {
      const { event, approvals } = inviteContext();
      const row = ctx.contactRepo!.add(10, 'Bora Example');
      ctx.contactRepo!.add(10, `User ${row.id}`, undefined, row.id);
      const result = await executeTool(ctx, 'send_invitation', { event_id: event.id, invitee_id: row.id });
      expect(result.success).toBe(false);
      expect(toolResultContent(result)).toContain('pick_users');
      expect(approvals).not.toHaveBeenCalled();
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
    });

    test('a Telegram ID equal to another contact row id fails closed until verified in this conversation', async () => {
      const { event, approvals, sendInvitationCalls } = inviteContext();
      const bora = ctx.contactRepo!.add(10, 'Bora Example');
      ctx.contactRepo!.add(10, 'Cato Sample', undefined, bora.id);
      const ambiguous = await executeTool(ctx, 'send_invitation', { event_id: event.id, invitee_id: bora.id });
      expect(ambiguous.success).toBe(false);
      expect(toolResultContent(ambiguous)).toContain('"Bora Example"');
      expect(toolResultContent(ambiguous)).toContain('pick_users');
      expect(approvals).not.toHaveBeenCalled();
      expect(sendInvitationCalls).not.toHaveBeenCalled();
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);

      ctx.verifiedRecipientIds = new Set([bora.id]);
      expect((await executeTool(ctx, 'send_invitation', { event_id: event.id, invitee_id: bora.id })).success).toBe(
        true,
      );
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id).map((i) => i.invitee_id)).toEqual([bora.id]);
    });

    test('a saved @username resolves even when its Telegram ID equals another contact row id', async () => {
      const { event, approvals, sendInvitationCalls } = inviteContext();
      ctx.messageText = 'Invite Cato Sample from my contacts';
      const bora = ctx.contactRepo!.add(10, 'Bora Example');
      ctx.contactRepo!.add(10, 'Cato Sample', 'catosample', bora.id);
      const invited = await executeTool(ctx, 'send_invitation', { event_id: event.id, invitee_username: 'catosample' });
      expect(invited.success).toBe(true);
      expect(approvals).not.toHaveBeenCalled();
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id).map((i) => i.invitee_id)).toEqual([bora.id]);
      expect(sendInvitationCalls.mock.calls.map(([id]) => id)).toEqual([bora.id]);
    });

    test('resending an established invitation ignores a later contact row with the same number', async () => {
      const { event, sendInvitationCalls } = inviteContext();
      const bora = ctx.contactRepo!.add(10, 'Bora Example');
      const invitation = ctx.sharing!.invitationService.sendInvitation(event.id, 10, bora.id).invitation!;
      expect((await handleResendInvitation(ctx, { invitation_id: invitation.id })).success).toBe(true);
      expect(sendInvitationCalls.mock.calls.map(([id]) => id)).toEqual([bora.id]);
    });

    test('a contact with a Telegram ID invites by that ID, never by its row id', async () => {
      const { event, approvals, sendInvitationCalls } = inviteContext();
      const found = await executeTool(ctx, 'find_contact', { name: 'Alex' });
      const [match] = lookupMatches(found);
      expect(found.output).toContain('telegram_id: 5000000001');

      const byRow = await executeTool(ctx, 'send_invitation', { event_id: event.id, invitee_id: match!.id });
      expect(byRow.success).toBe(false);
      expect(toolResultContent(byRow)).toContain('invitee_id 5000000001');
      expect(approvals).not.toHaveBeenCalled();

      const invited = await executeTool(ctx, 'send_invitation', { event_id: event.id, invitee_id: match!.telegram_id });
      expect(invited.success).toBe(true);
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id).map((i) => i.invitee_id)).toEqual([5000000001]);
      expect(sendInvitationCalls.mock.calls.map(([id]) => id)).toEqual([5000000001]);
    });
  });
});
