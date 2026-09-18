import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createCallbackHandler } from '../../src/bot/handlers/callback.handler.ts';
import { migrations } from '../../src/database/migrations.ts';
import { ActionLogRepository } from '../../src/database/repositories/action-log.repository.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { DeepLinkRepository } from '../../src/database/repositories/deep-link.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
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
import type { AgentContext } from '../../src/services/ai/types.ts';
import { EventService } from '../../src/services/event/event-service.ts';
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
    ctx.resolveUsername = mock(async () => ({ id: 5000000002, username: 'knownalex' }));
    expect((await handleResendInvitation(ctx, { invitation_id: invitation.id })).success).toBe(true);
    expect(send.mock.calls[0]?.[0]).toBe(5000000001);
    expect(ctx.resolveUsername).not.toHaveBeenCalled();
  });

  test('unresolved optional profile does not block established numeric Bot API delivery', async () => {
    ctx.lookupTelegramUser = mock(() => new Promise<null>(() => {}));
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Latency',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const sent: number[] = [];
    ctx.sender = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      sendInvitation: async (id) => {
        sent.push(id);
        return { message_id: 1 };
      },
    };
    const pending = handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000001 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toEqual([5000000001]);
    expect((await pending).success).toBe(true);
  });

  test('inspection returns structured metadata and caches only the scoped numeric profile', async () => {
    const lookup = mock(async (id: number) => ({ id, firstName: 'Current' }));
    ctx.lookupTelegramUser = lookup;
    const result = await handleGetUserInfo(ctx, { telegram_id: 5000000001 });
    expect(result.data).toMatchObject({ telegram_id: 5000000001, username: null, profile_source: 'telegram' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await handleGetUserInfo(ctx, { telegram_id: 5000000001 })).data).toEqual(result.data);
    expect(lookup).toHaveBeenCalledTimes(1);
    ctx.contactRepo!.deleteOwned(10, ctx.contactRepo!.list(10)[0]!.id);
    expect((await handleGetUserInfo(ctx, { telegram_id: 5000000001 })).success).toBe(false);
    ctx.messageText = 'Inspect 5000000002';
    await handleGetUserInfo(ctx, { telegram_id: 5000000002 });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test('profile mutation is audited, structured, and checks privacy again on repeated execution', async () => {
    ctx.actionLogRepo = new ActionLogRepository(db);
    const old = ctx.contactRepo!.list(10)[0]!;
    ctx.contactRepo!.update(old.id, { preferred_name: 'Sasha' });
    const other = ctx.contactRepo!.add(10, 'Other', 'reassigned', 5000000002, 'Friend');
    ctx.lookupTelegramUser = async (id) => ({ id, username: 'reassigned', firstName: 'Current' });
    const result = await executeTool(ctx, 'get_user_info', { telegram_id: 5000000001 });
    expect(result.data).toMatchObject({ telegram_id: 5000000001, username: 'reassigned' });
    expect(ctx.contactRepo!.findById(10, old.id)).toMatchObject({ telegram_id: 5000000001, preferred_name: 'Sasha' });
    expect(ctx.contactRepo!.findById(10, other.id)).toMatchObject({
      telegram_id: 5000000002,
      username: null,
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
      const continueAi = async (userId: number, chatId: number, text: string) => {
        expect(userId).toBe(10);
        expect(chatId).toBe(10);
        expect(text).toContain(`Confirmed recipient Telegram ID 5000000002 for event ${event.id}.`);
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
      };
      const handler = createCallbackHandler(ctx.eventService, {} as never, {} as never, {} as never, {
        onAiButtonClick: continueAi,
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

  test('inspection metadata is reused for resend without refreshing the same scoped ID', async () => {
    const event = ctx.eventService.createEvent({
      user_id: 10,
      title: 'Cached resend',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    const invitation = ctx.sharing!.invitationService.sendInvitation(event.id, 10, 5000000001, 'knownalex').invitation!;
    const lookup = mock(async (id: number) => ({ id, firstName: 'Current' }));
    ctx.lookupTelegramUser = lookup;
    await handleGetUserInfo(ctx, { telegram_id: 5000000001 });
    ctx.sender = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      sendInvitation: async () => ({ message_id: 1 }),
    };
    expect((await handleResendInvitation(ctx, { invitation_id: invitation.id })).success).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('fresh null username survives the automatic insertion branch and both transport arguments', async () => {
    ctx.contactRepo!.deleteOwned(10, ctx.contactRepo!.list(10)[0]!.id);
    ctx.messageText = 'Invite 5000000001';
    ctx.lookupTelegramUser = async (id) => ({ id, firstName: 'Current' });
    await handleGetUserInfo(ctx, { telegram_id: 5000000001 });
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
      sendAsUser: async (id, _text, hint) => {
        targets.push(id);
        hints.push(hint);
        return true;
      },
    };
    expect((await handleSendInvitation(ctx, { event_id: event.id, invitee_id: 5000000001 })).success).toBe(true);
    expect(ctx.contactRepo!.findByTelegramId(10, 5000000001)).toMatchObject({ username: null, name: 'Current' });
    expect(targets).toEqual([5000000001, 5000000001]);
    expect(hints).toEqual([undefined]);
  });

  test('concurrent inspections coalesce by ID and cannot reuse another ID or caller context', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = mock(async (id: number) => {
      await gate;
      return { id, username: `person_${id}` };
    });
    ctx.lookupTelegramUser = lookup;
    ctx.messageText = 'Inspect 5000000001 and 5000000002';
    const first = handleGetUserInfo(ctx, { telegram_id: 5000000001 });
    const duplicate = handleGetUserInfo(ctx, { telegram_id: 5000000001 });
    const second = handleGetUserInfo(ctx, { telegram_id: 5000000002 });
    await Promise.resolve();
    expect(lookup).toHaveBeenCalledTimes(2);
    release();
    expect((await first).data).toMatchObject({ telegram_id: 5000000001, username: 'person_5000000001' });
    expect((await duplicate).data).toEqual((await first).data);
    expect((await second).data).toMatchObject({ telegram_id: 5000000002, username: 'person_5000000002' });
    await handleGetUserInfo(makeCtx(db, { lookupTelegramUser: lookup }), { telegram_id: 5000000001 });
    expect(lookup).toHaveBeenCalledTimes(3);
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

  test('cached inspection never substitutes for a fresh explicit username conflict check', async () => {
    ctx.lookupTelegramUser = async (id) => ({ id, username: 'knownalex' });
    await handleGetUserInfo(ctx, { telegram_id: 5000000001 });
    ctx.messageText = 'Invite @knownalex';
    ctx.resolveUsername = mock(async () => ({ id: 5000000002, username: 'knownalex' }));
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
    expect(ctx.resolveUsername).toHaveBeenCalledTimes(1);
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
  });

  test('inspection cache expires and bounds distinct optional lookups in a request', async () => {
    const lookup = mock(async (id: number) => ({ id }));
    ctx.lookupTelegramUser = lookup;
    const ids = Array.from({ length: 33 }, (_, i) => 5000000001 + i);
    ctx.messageText = ids.join(' ');
    for (const telegram_id of ids) await handleGetUserInfo(ctx, { telegram_id });
    expect(lookup).toHaveBeenCalledTimes(32);
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(now + 30_001);
    try {
      await handleGetUserInfo(ctx, { telegram_id: 5000000001 });
      expect(lookup).toHaveBeenCalledTimes(33);
    } finally {
      clock.mockRestore();
    }
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
    const send = mock(async (_id: number) => ({ message_id: 1 }));
    ctx.sender = { sendMessage: send, editMessageText: async () => {}, sendInvitation: send };
    ctx.messageText = 'Resend to @different';
    ctx.resolveUsername = async () => ({ id: 5000000002, username: 'different' });
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
    ctx.resolveUsername = async () => ({ id: 5000000002, username: 'different_person' });
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
});
