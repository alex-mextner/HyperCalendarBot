import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { handleSettingsCallback } from '../../src/bot/commands/settings.ts';
import type { BotCallbackContext } from '../../src/bot/types.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { DeepLinkRepository } from '../../src/database/repositories/deep-link.repository.ts';
import { NotificationPreferencesRepository } from '../../src/database/repositories/notification-preferences.repository.ts';
import { TelegramSessionRepository } from '../../src/database/repositories/telegram-session.repository.ts';
import { CalendarBotAgent } from '../../src/services/ai/agent.ts';
import type { aiStreamRound } from '../../src/services/ai/streaming.ts';
import { deliverInvitationFromContext } from '../../src/services/ai/tool-handlers/sharing-invitation-delivery.ts';
import { encryptBlob } from '../../src/services/crypto/session-crypto.ts';
import { NotificationPreferencesService } from '../../src/services/notification/preferences.ts';
import { DeepLinkService } from '../../src/services/sharing/deep-link-service.ts';
import { resolveWithConnectedUser } from '../../src/services/telegram-session/connected-user-resolver.ts';
import { createConnectedUserSender } from '../../src/services/telegram-session/connected-user-sender.ts';
import { SessionBridge } from '../../src/services/telegram-session/session-bridge.ts';
import { withTelegramSessionLock } from '../../src/services/telegram-session/session-lock.ts';
import { stub } from '../bot/partial-stub.ts';
import { sentMessage } from '../bot/telegram-fixtures.ts';
import { createAgentRunFixture, makeStreamImpl, setupInvitations, USER_ID } from '../services/ai/agent-run-helpers.ts';

const MASTER_KEY = Buffer.alloc(32, 0x46);
const RECIPIENT = 881100;
const PROFILE = { id: RECIPIENT, firstName: 'Synthetic Recipient', username: 'queued_person' };

function outcome(operation: Promise<unknown>): Promise<string> {
  return operation.then(
    () => 'resolved',
    (error: unknown) => (error instanceof Error ? error.name : 'NonError'),
  );
}

describe('queued personal Telegram operations', () => {
  let fixture: ReturnType<typeof createAgentRunFixture>;
  let sessions: TelegramSessionRepository;
  let event: ReturnType<typeof setupInvitations>;
  let pending: Promise<unknown>[];
  let releases: (() => void)[];

  function track<T>(operation: Promise<T>): Promise<T> {
    pending.push(operation);
    return operation;
  }

  async function holdOwner() {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releases.push(() => release.resolve());
    track(
      withTelegramSessionLock(USER_ID, async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    return () => release.resolve();
  }

  beforeEach(() => {
    fixture = createAgentRunFixture();
    pending = [];
    releases = [];
    sessions = new TelegramSessionRepository(fixture.db);
    sessions.upsert(USER_ID, encryptBlob(Buffer.from('synthetic first credential'), MASTER_KEY), '+***00', 'owner');
    fixture.ctx.telegramSessionRepo = sessions;
    fixture.ctx.telegramMasterKey = MASTER_KEY;
    fixture.ctx.contactRepo = new ContactRepository(fixture.db);
    fixture.ctx.deepLinkService = new DeepLinkService(new DeepLinkRepository(fixture.db));
    fixture.ctx.botUsername = 'SyntheticTestBot';
    fixture.ctx.messageText = 'Invite @queued_person';
    fixture.ctx.sender = fixture.sender;
    event = setupInvitations(fixture.db, fixture.ctx);
    fixture.sender.sendInvitation = mock(async () => ({ message_id: 900 }));
    fixture.sender.sendUserPicker = mock(async () => ({ message_id: 901 }));
    spyOn(SessionBridge, 'createTempSessionFile').mockResolvedValue('/tmp/synthetic-queued-session');
    spyOn(SessionBridge, 'cleanupTempFile').mockResolvedValue();
    spyOn(SessionBridge, 'resolveUsernameAsUser').mockResolvedValue({ success: true, data: { profile: PROFILE } });
    spyOn(SessionBridge, 'sendAsUser').mockResolvedValue({ success: true, data: { status: 'ok' } });
    spyOn(SessionBridge, 'logOut').mockResolvedValue({ success: true, data: { status: 'ok' } });
  });

  afterEach(async () => {
    for (const release of releases) release();
    await Promise.allSettled(pending);
    mock.restore();
    fixture.db.close();
  });

  test.each([
    'unchanged',
    'while_queued',
    'during_answer',
  ] as const)('a queued disconnect answers before waiting and preserves the selected credential: %s', async (replacementTiming) => {
    const release = await holdOwner();
    const replacement = encryptBlob(Buffer.from('synthetic replacement credential'), MASTER_KEY);
    const edits: string[] = [];
    const answer = mock(async () => {
      if (replacementTiming === 'during_answer') {
        sessions.upsert(USER_ID, replacement, '+***11', 'owner');
      }
      return true as const;
    });
    const callback = stub<BotCallbackContext>({
      answer,
      editText: async (...args) => {
        edits.push(JSON.stringify(args[1]));
        return sentMessage();
      },
    });
    const disconnect = track(
      handleSettingsCallback(
        callback,
        fixture.ctx.user,
        'tg_disconnect_confirm',
        new NotificationPreferencesService(new NotificationPreferencesRepository(fixture.db)),
        undefined,
        undefined,
        fixture.ctx.userRepo,
        { sessionRepo: sessions, masterKey: MASTER_KEY, enterScene: async () => {} },
      ),
    );
    await Bun.sleep(0);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(SessionBridge.logOut).not.toHaveBeenCalled();
    expect(edits).toEqual([]);
    if (replacementTiming === 'while_queued') {
      sessions.upsert(USER_ID, replacement, '+***11', 'owner');
    }
    release();
    await disconnect;

    expect(answer).toHaveBeenCalledTimes(1);
    if (replacementTiming === 'unchanged') {
      expect(sessions.getActive(USER_ID)).toBeNull();
      expect(SessionBridge.logOut).toHaveBeenCalledTimes(1);
      expect(edits.join('\n')).toContain('stg:tg_connect');
      expect(edits.join('\n')).not.toContain('stg:tg_disconnect_confirm');
    } else {
      expect(sessions.getActive(USER_ID)?.encrypted_session).toEqual(replacement);
      expect(SessionBridge.logOut).not.toHaveBeenCalled();
      expect(edits.join('\n')).toContain('stg:tg_disconnect_confirm');
      expect(edits.join('\n')).not.toContain('stg:tg_connect');
    }
  });

  test('callback acknowledgement failure does not prevent the requested queued logout', async () => {
    const release = await holdOwner();
    const edits: string[] = [];
    const answer = mock(async () => {
      throw new Error('Synthetic expired callback query');
    });
    const callback = stub<BotCallbackContext>({
      answer,
      editText: async (...args) => {
        edits.push(JSON.stringify(args[1]));
        return sentMessage();
      },
    });
    const disconnect = outcome(
      track(
        handleSettingsCallback(
          callback,
          fixture.ctx.user,
          'tg_disconnect_confirm',
          new NotificationPreferencesService(new NotificationPreferencesRepository(fixture.db)),
          undefined,
          undefined,
          fixture.ctx.userRepo,
          { sessionRepo: sessions, masterKey: MASTER_KEY, enterScene: async () => {} },
        ),
      ),
    );
    await Bun.sleep(0);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(SessionBridge.logOut).not.toHaveBeenCalled();
    expect(edits).toEqual([]);
    expect(sessions.getActive(USER_ID)).not.toBeNull();
    release();

    expect(await disconnect).toBe('resolved');
    expect(answer).toHaveBeenCalledTimes(1);
    expect(SessionBridge.logOut).toHaveBeenCalledTimes(1);
    expect(sessions.getActive(USER_ID)).toBeNull();
    expect(edits.join('\n')).toContain('stg:tg_connect');
    expect(edits.join('\n')).not.toContain('stg:tg_disconnect_confirm');
  });

  test('an aborted waiter never starts work or releases the lock before its predecessor', async () => {
    const release = await holdOwner();
    const controller = new AbortController();
    const visited: string[] = [];
    const cancelled = outcome(
      track(
        withTelegramSessionLock(
          USER_ID,
          async () => {
            visited.push('cancelled');
          },
          controller.signal,
        ),
      ),
    );
    controller.abort();
    const following = track(
      withTelegramSessionLock(USER_ID, async () => {
        visited.push('following');
      }),
    );
    await Bun.sleep(0);
    expect(visited).toEqual([]);
    release();
    expect(await cancelled).toBe('AbortError');
    await following;
    expect(visited).toEqual(['following']);
  });

  test('the real agent request signal stops a queued lookup before invitation or contact creation', async () => {
    const release = await holdOwner();
    const controller = new AbortController();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    spyOn(AbortSignal, 'timeout').mockImplementation((ms) => (ms === 10_000 ? controller.signal : originalTimeout(ms)));
    const modelReturned = Promise.withResolvers<void>();
    const scripted = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'invite',
        name: 'send_invitation',
        input: { event_id: event.id, invitee_username: 'queued_person' },
      },
      { kind: 'text', text: 'Invitation sent.' },
    ]);
    const streamImpl: typeof aiStreamRound = async (options, callbacks) => {
      const result = await scripted.impl(options, callbacks);
      modelReturned.resolve();
      return result;
    };
    fixture.ctx.chatHistory.save(USER_ID, 'user', fixture.ctx.messageText);
    const run = track(
      new CalendarBotAgent(fixture.config, fixture.sender, { streamImpl, requestTimeoutMs: 10_000 }).run(fixture.ctx),
    );
    await modelReturned.promise;
    await Bun.sleep(0);
    controller.abort();
    release();
    await run;

    expect(fixture.ctx.sharing!.invitationRepo.getByEvent(event.id)).toEqual([]);
    expect(fixture.ctx.contactRepo!.findByTelegramId(USER_ID, RECIPIENT)).toBeNull();
    expect(SessionBridge.resolveUsernameAsUser).not.toHaveBeenCalled();
    expect(fixture.sender.sendInvitation).not.toHaveBeenCalled();
    expect(fixture.sender.sendUserPicker).not.toHaveBeenCalled();
  });

  test('a queued personal send aborted before its turn never opens the session', async () => {
    const release = await holdOwner();
    const controller = new AbortController();
    const sender = createConnectedUserSender({ sessionRepo: sessions, masterKey: MASTER_KEY });
    const cancelled = outcome(
      track(sender(USER_ID, RECIPIENT, 'synthetic invitation', 'queued_person', { signal: controller.signal })),
    );
    controller.abort();
    release();
    expect(await cancelled).toBe('AbortError');
    expect(SessionBridge.createTempSessionFile).not.toHaveBeenCalled();
    expect(SessionBridge.sendAsUser).not.toHaveBeenCalled();
    expect(await withTelegramSessionLock(USER_ID, async () => 'available')).toBe('available');
  });

  test.each([
    'lookup',
    'send',
  ] as const)('cancellation during %s temporary-file preparation prevents bridge dispatch', async (operation) => {
    const controller = new AbortController();
    spyOn(SessionBridge, 'createTempSessionFile').mockImplementation(async () => {
      controller.abort();
      return '/tmp/synthetic-queued-session';
    });
    const sender = createConnectedUserSender({ sessionRepo: sessions, masterKey: MASTER_KEY });
    const result =
      operation === 'lookup'
        ? resolveWithConnectedUser(sessions, MASTER_KEY, USER_ID, 'queued_person', controller.signal)
        : sender(USER_ID, RECIPIENT, 'synthetic invitation', 'queued_person', { signal: controller.signal });

    expect(await outcome(track<unknown>(result))).toBe('AbortError');
    expect(SessionBridge.resolveUsernameAsUser).not.toHaveBeenCalled();
    expect(SessionBridge.sendAsUser).not.toHaveBeenCalled();
    expect(SessionBridge.cleanupTempFile).toHaveBeenCalledWith('/tmp/synthetic-queued-session');
  });

  test('the invitation delivery chain suppresses late personal sends and fallback after request abort', async () => {
    const release = await holdOwner();
    const controller = new AbortController();
    fixture.ctx.requestSignal = controller.signal;
    fixture.sender.sendInvitation = mock(async () => null);
    fixture.sender.sendAsConnectedUser = createConnectedUserSender({ sessionRepo: sessions, masterKey: MASTER_KEY });
    const created = fixture.ctx.sharing!.invitationService.sendInvitation(
      event.id,
      USER_ID,
      RECIPIENT,
      'queued_person',
    );
    if (!created.invitation) throw new Error('Synthetic invitation was not created');
    const delivery = outcome(
      track(
        deliverInvitationFromContext(fixture.ctx, fixture.ctx.sharing!, fixture.sender, {
          invitationId: created.invitation.id,
          eventId: event.id,
          inviteeId: RECIPIENT,
          inviteeUsername: 'queued_person',
          event,
          isGroupTarget: false,
          organizerId: USER_ID,
        }),
      ),
    );
    await Bun.sleep(0);
    controller.abort();
    release();
    expect(await delivery).toBe('AbortError');
    expect(SessionBridge.sendAsUser).not.toHaveBeenCalled();
    expect(fixture.sender.sendMessage).not.toHaveBeenCalled();
  });

  test('an acknowledged forwarding link stays reported when cancellation races its result', async () => {
    const controller = new AbortController();
    fixture.ctx.requestSignal = controller.signal;
    fixture.sender.sendInvitation = mock(async () => null);
    fixture.sender.sendAsConnectedUser = mock(async () => false);
    fixture.sender.sendMessage = mock(async () => {
      controller.abort();
      return { message_id: 902 };
    });
    const created = fixture.ctx.sharing!.invitationService.sendInvitation(
      event.id,
      USER_ID,
      RECIPIENT,
      'queued_person',
    );
    if (!created.invitation) throw new Error('Synthetic invitation was not created');
    const delivery = await track(
      deliverInvitationFromContext(fixture.ctx, fixture.ctx.sharing!, fixture.sender, {
        invitationId: created.invitation.id,
        eventId: event.id,
        inviteeId: RECIPIENT,
        inviteeUsername: 'queued_person',
        event,
        isGroupTarget: false,
        organizerId: USER_ID,
      }),
    );

    expect(controller.signal.aborted).toBe(true);
    expect(delivery).toEqual({ delivered: false, viaDeepLink: true, viaBotApi: false });
    expect(fixture.sender.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('an acknowledged personal send stays successful when cancellation races its result', async () => {
    const controller = new AbortController();
    spyOn(SessionBridge, 'sendAsUser').mockImplementation(async () => {
      controller.abort();
      return { success: true, data: { status: 'ok' } };
    });
    const sender = createConnectedUserSender({ sessionRepo: sessions, masterKey: MASTER_KEY });
    expect(
      await sender(USER_ID, RECIPIENT, 'synthetic invitation', 'queued_person', { signal: controller.signal }),
    ).toBe(true);
    expect(SessionBridge.cleanupTempFile).toHaveBeenCalled();
  });
});
