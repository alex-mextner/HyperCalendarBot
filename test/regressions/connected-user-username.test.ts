import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { DeepLinkRepository } from '../../src/database/repositories/deep-link.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../src/database/repositories/sharing-settings.repository.ts';
import { TelegramSessionRepository } from '../../src/database/repositories/telegram-session.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { lookUpUsername } from '../../src/services/ai/recipient-identity.ts';
import { handleGetUserInfo } from '../../src/services/ai/tool-handlers/contacts.ts';
import { handleFindUser } from '../../src/services/ai/tool-handlers/meta.ts';
import { handleSendInvitation } from '../../src/services/ai/tool-handlers/sharing.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import { encryptBlob } from '../../src/services/crypto/session-crypto.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { DeepLinkService } from '../../src/services/sharing/deep-link-service.ts';
import { InvitationService } from '../../src/services/sharing/invitation-service.ts';
import { createConnectedUserSender } from '../../src/services/telegram-session/connected-user-sender.ts';
import { SessionBridge } from '../../src/services/telegram-session/session-bridge.ts';
import { processSessionKeepalive } from '../../src/worker/session-keepalive.ts';

const MASTER_KEY = Buffer.alloc(32, 0x42);
const OWNER = 10101;
const RECIPIENT = 20202;

function makeContext(db: Database, overrides: Partial<AgentContext> = {}): AgentContext {
  const users = new UserRepository(db);
  const events = new EventRepository(db);
  const invitations = new InvitationRepository(db);
  return {
    user: users.findByTelegramId(OWNER)!,
    chatId: OWNER,
    messageText: 'Invite @requested_person',
    isGroup: false,
    userRepo: users,
    contactRepo: new ContactRepository(db),
    telegramSessionRepo: new TelegramSessionRepository(db),
    telegramMasterKey: MASTER_KEY,
    eventService: new EventService({ eventRepo: events }),
    sharing: {
      invitationRepo: invitations,
      invitationService: new InvitationService(invitations, events, new SharingSettingsRepository(db)),
    },
    ...overrides,
  } as unknown as AgentContext;
}

function makeSender(overrides: Partial<NonNullable<AgentContext['sender']>>): NonNullable<AgentContext['sender']> {
  return overrides as unknown as NonNullable<AgentContext['sender']>;
}

function bridgeProcess(stdout: string, exitCode = 0): ReturnType<typeof Bun.spawn> {
  return {
    stdout: new Response(stdout).body,
    stderr: new Response('').body,
    exited: Promise.resolve(exitCode),
    kill: () => true,
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe('username lookup through the requesting user session', () => {
  let db: Database;
  let ctx: AgentContext;
  let spawn: ReturnType<typeof spyOn<typeof Bun, 'spawn'>>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    new UserRepository(db).create({ telegram_id: OWNER, timezone: 'UTC', language: 'en' });
    ctx = makeContext(db);
    ctx.telegramSessionRepo!.upsert(
      OWNER,
      encryptBlob(Buffer.from('synthetic session'), MASTER_KEY),
      '+***00',
      'owner',
    );
    spyOn(SessionBridge, 'createTempSessionFile').mockResolvedValue('/tmp/synthetic-owner.session');
    spyOn(SessionBridge, 'cleanupTempFile').mockResolvedValue();
    spawn = spyOn(Bun, 'spawn').mockImplementation(() =>
      bridgeProcess(
        JSON.stringify({ profile: { id: RECIPIENT, firstName: 'Requested Person', username: 'requested_person' } }),
      ),
    );
  });

  afterEach(() => {
    mock.restore();
    db.close();
  });

  test('resolves the explicit username with the own session while the service tier is absent', async () => {
    expect(ctx.userRepo.findByTelegramId(RECIPIENT)).toBeNull();
    const result = await handleFindUser(ctx, { username: '@requested_person' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ telegram_id: RECIPIENT, name: 'Requested Person' });
    expect(ctx.verifiedRecipientIds?.has(RECIPIENT)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toContain(String(OWNER));
  });

  test('find_user retains the verified username for a later invitation addressed only by ID', async () => {
    await handleFindUser(ctx, { username: '@requested_person' });
    const send = mock<NonNullable<NonNullable<AgentContext['sender']>['sendAsConnectedUser']>>(async () => true);
    ctx.sender = makeSender({ sendInvitation: mock(async () => null), sendAsConnectedUser: send });
    ctx.deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
    ctx.botUsername = 'SyntheticTestBot';
    const event = ctx.eventService.createEvent({
      user_id: OWNER,
      title: 'Synthetic ID-only meeting',
      start_at: new Date(Date.now() + 86_400_000).toISOString(),
      timezone: 'UTC',
    });
    const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: RECIPIENT });
    expect(result.effect).toEqual({ kind: 'invitation', delivery: 'delivered' });
    expect(send.mock.calls[0]?.[1]).toBe(RECIPIENT);
    expect(send.mock.calls[0]?.[3]).toBe('requested_person');
    expect(ctx.contactRepo!.findByTelegramId(OWNER, RECIPIENT)?.username).toBe('requested_person');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('a newer deleted-account inspection prevents invitation creation and delivery', async () => {
    ctx.contactRepo!.upsert(OWNER, 'Requested Person', 'requested_person', RECIPIENT);
    await handleFindUser(ctx, { username: '@requested_person' });
    ctx.lookupTelegramUser = mock(async () => ({ id: RECIPIENT, deleted: true }));
    const inspected = await handleGetUserInfo(ctx, { telegram_id: RECIPIENT });
    expect(inspected.data).toMatchObject({ telegram_id: RECIPIENT, deleted: true });
    const botSend = mock<NonNullable<NonNullable<AgentContext['sender']>['sendInvitation']>>(async () => ({
      message_id: 9002,
    }));
    const personalSend = mock<NonNullable<NonNullable<AgentContext['sender']>['sendAsConnectedUser']>>(
      async () => true,
    );
    ctx.sender = makeSender({ sendInvitation: botSend, sendAsConnectedUser: personalSend });
    const event = ctx.eventService.createEvent({
      user_id: OWNER,
      title: 'Synthetic deleted-account refusal',
      start_at: new Date(Date.now() + 86_400_000).toISOString(),
      timezone: 'UTC',
    });

    const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: RECIPIENT });
    expect(result.success).toBe(false);
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
    expect(botSend).not.toHaveBeenCalled();
    expect(personalSend).not.toHaveBeenCalled();
  });

  test('a fresh username resolution supersedes an older profile inspection', async () => {
    ctx.contactRepo!.upsert(OWNER, 'Requested Person', 'requested_person', RECIPIENT);
    ctx.lookupTelegramUser = mock(async () => ({ id: RECIPIENT, deleted: true }));
    await handleGetUserInfo(ctx, { telegram_id: RECIPIENT });
    await handleFindUser(ctx, { username: '@requested_person' });
    const botSend = mock<NonNullable<NonNullable<AgentContext['sender']>['sendInvitation']>>(async () => ({
      message_id: 9003,
    }));
    ctx.sender = makeSender({ sendInvitation: botSend });
    const event = ctx.eventService.createEvent({
      user_id: OWNER,
      title: 'Synthetic refreshed-profile invitation',
      start_at: new Date(Date.now() + 86_400_000).toISOString(),
      timezone: 'UTC',
    });

    const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: RECIPIENT });
    expect(result.effect).toEqual({ kind: 'invitation', delivery: 'delivered' });
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(1);
    expect(botSend).toHaveBeenCalledTimes(1);
  });

  test('the existing invitation path saves the resolved person to the owner contact book', async () => {
    const event = ctx.eventService.createEvent({
      user_id: OWNER,
      title: 'Synthetic meeting',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    await handleSendInvitation(ctx, { event_id: event.id, invitee_username: '@requested_person' });
    const saved = ctx.contactRepo!.findByTelegramId(OWNER, RECIPIENT);
    expect(saved?.name).toBe('Requested Person');
    expect(saved?.username).toBe('requested_person');
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(1);
    expect(ctx.userRepo.findByTelegramId(RECIPIENT)).toBeNull();
  });

  test('known bot users remain available when no personal session is connected', async () => {
    ctx.telegramSessionRepo!.deleteByUserId(OWNER);
    ctx.userRepo.create({
      telegram_id: RECIPIENT,
      username: 'requested_person',
      first_name: 'Known Person',
      timezone: 'UTC',
    });
    expect(await lookUpUsername(ctx, 'requested_person')).toEqual({
      status: 'found',
      user: { id: RECIPIENT, firstName: 'Known Person', username: 'requested_person' },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('a known user who cannot receive bot messages still gets a private reconnect button', async () => {
    ctx.telegramSessionRepo!.deleteByUserId(OWNER);
    ctx.userRepo.create({ telegram_id: RECIPIENT, username: 'requested_person', timezone: 'UTC' });
    const send = mock<NonNullable<NonNullable<AgentContext['sender']>['sendMessageWithKeyboard']>>(async () => ({
      message_id: 9000,
    }));
    ctx.sender = makeSender({
      sendInvitation: mock(async () => null),
      sendMessage: mock(async () => ({ message_id: 9001 })),
      sendMessageWithKeyboard: send,
    });
    const event = ctx.eventService.createEvent({
      user_id: OWNER,
      title: 'Synthetic unreachable-recipient meeting',
      start_at: new Date(Date.now() + 86_400_000).toISOString(),
      timezone: 'UTC',
    });
    const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_username: '@requested_person' });
    expect(result.effect).toEqual({ kind: 'invitation', delivery: 'failed' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(OWNER);
    expect(JSON.stringify(send.mock.calls)).toContain('stg:tg_connect');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('a pending optional reconnect notification cannot hide a completed invitation result', async () => {
    ctx.telegramSessionRepo!.deleteByUserId(OWNER);
    ctx.userRepo.create({ telegram_id: RECIPIENT, username: 'requested_person', timezone: 'UTC' });
    const pending = Promise.withResolvers<{ message_id: number }>();
    ctx.sender = makeSender({
      sendInvitation: mock(async () => null),
      sendMessage: mock(async () => ({ message_id: 9001 })),
      sendMessageWithKeyboard: mock(() => pending.promise),
    });
    const event = ctx.eventService.createEvent({
      user_id: OWNER,
      title: 'Synthetic stalled-notice meeting',
      start_at: new Date(Date.now() + 86_400_000).toISOString(),
      timezone: 'UTC',
    });
    const completion = handleSendInvitation(ctx, { event_id: event.id, invitee_username: '@requested_person' });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let result: Awaited<typeof completion> | 'blocked';
    try {
      result = await Promise.race([
        completion,
        new Promise<'blocked'>((resolve) => {
          timeout = setTimeout(() => resolve('blocked'), 250);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      pending.resolve({ message_id: 9000 });
      await completion;
    }
    expect(result).not.toBe('blocked');
    if (result === 'blocked') throw new Error('Optional notification blocked the confirmed mutation');
    expect(result.mutationState).toBe('confirmed');
    expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(1);
  });

  test('a missing own session offers the existing private reconnect button', async () => {
    ctx.telegramSessionRepo!.deleteByUserId(OWNER);
    const send = mock<NonNullable<NonNullable<AgentContext['sender']>['sendMessageWithKeyboard']>>(async () => ({
      message_id: 9000,
    }));
    ctx.sender = makeSender({ sendMessageWithKeyboard: send });
    const result = await handleFindUser(ctx, { username: '@requested_person' });
    expect(result.awaitingInput).toEqual({ kind: 'chat' });
    expect(result.mutationState).toBe('not_applied');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(OWNER);
    expect(JSON.stringify(send.mock.calls)).toContain('stg:tg_connect');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('a transient lookup failure does not expire an active session or trust cached usernames', async () => {
    ctx.userRepo.create({ telegram_id: RECIPIENT, username: 'requested_person', timezone: 'UTC' });
    spawn.mockImplementation(() => bridgeProcess('{"error":"FLOOD_WAIT","retry_after":20}', 1));
    const send = mock<NonNullable<NonNullable<AgentContext['sender']>['sendMessageWithKeyboard']>>(async () => ({
      message_id: 9000,
    }));
    ctx.sender = makeSender({ sendMessageWithKeyboard: send });
    const result = await handleFindUser(ctx, { username: '@requested_person' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('unavailable');
    expect(ctx.telegramSessionRepo!.getActive(OWNER)).not.toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  test('confirmed revocation expires exactly the checked credential and offers reconnect', async () => {
    spawn.mockImplementation(() => bridgeProcess('{"error":"SESSION_EXPIRED","reason":"revoked"}', 1));
    const send = mock<NonNullable<NonNullable<AgentContext['sender']>['sendMessageWithKeyboard']>>(async () => ({
      message_id: 9000,
    }));
    ctx.sender = makeSender({ sendMessageWithKeyboard: send });
    const result = await handleFindUser(ctx, { username: '@requested_person' });
    expect(result.awaitingInput).toEqual({ kind: 'chat' });
    expect(ctx.telegramSessionRepo!.getActive(OWNER)).toBeNull();
    expect(JSON.stringify(send.mock.calls)).toContain('stg:tg_connect');
  });

  test('lookup, sending and keepalive for one owner share the session queue', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(SessionBridge, 'resolveUsernameAsUser').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { success: true, data: { profile: { id: RECIPIENT, username: 'requested_person' } } };
    });
    const send = spyOn(SessionBridge, 'sendAsUser').mockResolvedValue({ success: true, data: { status: 'ok' } });
    const auth = spyOn(SessionBridge, 'getAuthorizations').mockResolvedValue({
      success: true,
      data: { authorizations: [] },
    });
    const lookup = lookUpUsername(ctx, 'requested_person');
    const pending: Promise<unknown>[] = [lookup];
    try {
      await entered.promise;
      const sender = createConnectedUserSender({ sessionRepo: ctx.telegramSessionRepo!, masterKey: MASTER_KEY });
      const sent = sender(OWNER, RECIPIENT, 'synthetic text');
      pending.push(sent);
      const keepalive = processSessionKeepalive({
        sessionRepo: ctx.telegramSessionRepo!,
        masterKey: MASTER_KEY,
        rateLimitMs: 0,
      });
      pending.push(keepalive);
      await Promise.resolve();
      expect(send).not.toHaveBeenCalled();
      expect(auth).not.toHaveBeenCalled();
      release.resolve();
      const [found, delivered, checked] = await Promise.all([lookup, sent, keepalive]);
      expect(found.status).toBe('found');
      expect(delivered).toBe(true);
      expect(checked).toEqual({ checked: 1, expired: 0 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(auth).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  });

  test('queued keepalive never reconnects a replaced credential', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    spyOn(SessionBridge, 'resolveUsernameAsUser').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { success: true, data: { profile: null } };
    });
    const auth = spyOn(SessionBridge, 'getAuthorizations').mockResolvedValue({
      success: true,
      data: { authorizations: [] },
    });
    const lookup = lookUpUsername(ctx, 'requested_person');
    const pending: Promise<unknown>[] = [lookup];
    try {
      await entered.promise;
      const keepalive = processSessionKeepalive({
        sessionRepo: ctx.telegramSessionRepo!,
        masterKey: MASTER_KEY,
        rateLimitMs: 0,
      });
      pending.push(keepalive);
      ctx.telegramSessionRepo!.upsert(OWNER, encryptBlob(Buffer.from('replacement'), MASTER_KEY), '+***00', 'owner');
      release.resolve();
      expect((await lookup).status).toBe('unavailable');
      await keepalive;
      expect(auth).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  });

  test('a cleanup error releases the queue for a subsequent lookup', async () => {
    spyOn(SessionBridge, 'cleanupTempFile').mockRejectedValueOnce(new Error('synthetic cleanup error'));
    expect((await lookUpUsername(ctx, 'requested_person')).status).toBe('unavailable');
    expect((await lookUpUsername(ctx, 'requested_person')).status).toBe('found');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test('cleanup failure after a successful send cannot trigger a duplicate fallback', async () => {
    spyOn(SessionBridge, 'sendAsUser').mockResolvedValue({ success: true, data: { status: 'ok' } });
    spyOn(SessionBridge, 'cleanupTempFile').mockRejectedValueOnce(new Error('synthetic cleanup error'));
    const sender = createConnectedUserSender({ sessionRepo: ctx.telegramSessionRepo!, masterKey: MASTER_KEY });
    expect(await sender(OWNER, RECIPIENT, 'synthetic text')).toBe(true);
    expect((await lookUpUsername(ctx, 'requested_person')).status).toBe('found');
  });

  test('an old logout response cannot revoke a replacement login', () => {
    const previous = ctx.telegramSessionRepo!.getActive(OWNER)!;
    const fresh = encryptBlob(Buffer.from('fresh synthetic session'), MASTER_KEY);
    ctx.telegramSessionRepo!.upsert(OWNER, fresh, '+***00', 'owner');
    expect(ctx.telegramSessionRepo!.revokeIfCurrent(OWNER, previous.encrypted_session)).toBe(false);
    expect(Buffer.from(ctx.telegramSessionRepo!.getActive(OWNER)!.encrypted_session).equals(fresh)).toBe(true);
    expect(ctx.telegramSessionRepo!.revokeIfCurrent(OWNER, fresh)).toBe(true);
    expect(ctx.telegramSessionRepo!.getActive(OWNER)).toBeNull();
  });

  test('an old revocation response cannot expire a freshly connected session', async () => {
    const fresh = encryptBlob(Buffer.from('fresh synthetic session'), MASTER_KEY);
    spawn.mockImplementation(() => {
      ctx.telegramSessionRepo!.upsert(OWNER, fresh, '+***00', 'owner');
      return bridgeProcess('{"error":"SESSION_EXPIRED","reason":"revoked"}', 1);
    });
    const result = await lookUpUsername(ctx, 'requested_person');
    expect(result.status).toBe('unavailable');
    expect(Buffer.from(ctx.telegramSessionRepo!.getActive(OWNER)!.encrypted_session).equals(fresh)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
