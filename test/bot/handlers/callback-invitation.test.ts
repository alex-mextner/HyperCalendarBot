import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import type { InlineKeyboard } from 'gramio';
import { type CallbackHandlerOpts, createCallbackHandler } from '../../../src/bot/handlers/callback.handler';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { DomainEventBus } from '../../../src/services/scheduled/domain-event-bus.ts';
import { InvitationCardRefresher, type InvitationEditOptions } from '../../../src/services/sharing/invitation-cards.ts';
import { invitationRsvpKeyboard } from '../../../src/services/sharing/invitation-rsvp-keyboard.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { png } from '../../fixtures/png.ts';
import { makeCallbackHandler, makeCallbackTap } from '../../helpers/callback-handler.ts';
import { flushPromises } from '../../helpers/mock-context.ts';

function makeCtx(data: string, language: 'en' | 'ru' = 'en') {
  return {
    data,
    dbUser: { telegram_id: 200, language, timezone: 'UTC' },
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
  };
}

const GROUP_CHAT_ID = -100123;

// A group RSVP tap arrives on a message the bot delivered into the group, so the callback chat
// is the group itself. The personal `inv:` callbacks above run in private chats and ignore it.
function makeGroupCtx(data: string, language: 'en' | 'ru' = 'en') {
  return {
    ...makeCtx(data, language),
    chat: { type: 'supergroup', id: GROUP_CHAT_ID },
  };
}

function makeHandler(invitationService: unknown, groupMembership?: CallbackHandlerOpts['groupMembership']) {
  return createCallbackHandler({} as never, {} as never, {} as never, {} as never, {
    invitationService: invitationService as never,
    groupMembership,
  });
}

describe('invitation callbacks', () => {
  test('accept callback calls acceptInvitation', async () => {
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'accepted', event_id: 5 },
      })),
    };

    const ctx = makeCtx('inv:accept:1');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(invitationService.acceptInvitation).toHaveBeenCalledWith(1, 200);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('decline callback calls declineInvitation', async () => {
    const invitationService = {
      declineInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'declined' },
      })),
    };

    const ctx = makeCtx('inv:decline:1');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(invitationService.declineInvitation).toHaveBeenCalledWith(1, 200);
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('maybe callback calls maybeInvitation', async () => {
    const invitationService = {
      maybeInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'maybe' },
      })),
    };

    const ctx = makeCtx('inv:maybe:1');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(invitationService.maybeInvitation).toHaveBeenCalledWith(1, 200);
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('keep callback acknowledges without calling service', async () => {
    const invitationService = {
      acceptInvitation: mock(() => ({ success: true })),
    };

    const ctx = makeCtx('inv:keep:1');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(invitationService.acceptInvitation).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('failed invitation shows error', async () => {
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: false,
        error: 'Invitation not found',
      })),
    };

    const ctx = makeCtx('inv:accept:999');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(invitationService.acceptInvitation).toHaveBeenCalledWith(999, 200);
    expect(ctx.answer).toHaveBeenCalledWith('Invitation not found');
  });

  test('accept callback uses Russian text for ru user', async () => {
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: true,
        invitation: { id: 2, status: 'accepted' },
      })),
    };

    const ctx = makeCtx('inv:accept:2', 'ru');
    const handler = makeHandler(invitationService);

    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    const answerCall = (ctx.answer as ReturnType<typeof mock>).mock.calls[0];
    // Russian text contains specific characters
    expect(answerCall![0]).toContain('принято');
  });
});

describe('group RSVP callbacks', () => {
  function membershipDb() {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    return new GroupMemberRepository(db);
  }

  test('a member with no cached row is confirmed live and recorded before the RSVP', async () => {
    const repo = membershipDb();
    const isLiveMember = mock(async () => true);
    let activeAtRecord = false;
    const recordGroupAttendance = mock(() => {
      activeAtRecord = repo.isActiveMember(GROUP_CHAT_ID, 200);
      return { success: true };
    });
    const ctx = makeGroupCtx('grsvp:42:going');

    await makeHandler({ recordGroupAttendance }, { repo, isLiveMember })(ctx as never);

    expect(isLiveMember).toHaveBeenCalledWith(GROUP_CHAT_ID, 200);
    expect(activeAtRecord).toBe(true);
    expect(ctx.answer).toHaveBeenCalledWith(t('en').group_rsvp_recorded);
  });

  test('a non-member per Telegram gets no membership row', async () => {
    const repo = membershipDb();
    const isLiveMember = mock(async () => false);
    const recordGroupAttendance = mock(() => ({ success: false, error: 'User is not an active member of this group' }));
    const ctx = makeGroupCtx('grsvp:42:going');

    await makeHandler({ recordGroupAttendance }, { repo, isLiveMember })(ctx as never);

    expect(repo.isActiveMember(GROUP_CHAT_ID, 200)).toBe(false);
    expect(ctx.answer).toHaveBeenCalledWith({ text: t('en').group_rsvp_not_authorized });
  });

  test('a cached active member skips the live check', async () => {
    const repo = membershipDb();
    repo.upsert(GROUP_CHAT_ID, 200);
    const isLiveMember = mock(async () => true);
    const recordGroupAttendance = mock(() => ({ success: true }));

    await makeHandler({ recordGroupAttendance }, { repo, isLiveMember })(makeGroupCtx('grsvp:42:going') as never);

    expect(isLiveMember).not.toHaveBeenCalled();
    expect(recordGroupAttendance).toHaveBeenCalled();
  });

  test('going records accepted attendance for the clicking member and toasts', async () => {
    const recordGroupAttendance = mock(() => ({ success: true }));
    const ctx = makeGroupCtx('grsvp:42:going');
    const handler = makeHandler({ recordGroupAttendance });

    await handler(ctx as never);

    expect(recordGroupAttendance).toHaveBeenCalledWith(42, 200, 'accepted', GROUP_CHAT_ID);
    expect(ctx.answer).toHaveBeenCalledWith(t('en').group_rsvp_recorded);
  });

  test('notgoing records declined attendance for the clicking member and toasts', async () => {
    const recordGroupAttendance = mock(() => ({ success: true }));
    const ctx = makeGroupCtx('grsvp:42:notgoing');
    const handler = makeHandler({ recordGroupAttendance });

    await handler(ctx as never);

    expect(recordGroupAttendance).toHaveBeenCalledWith(42, 200, 'declined', GROUP_CHAT_ID);
    expect(ctx.answer).toHaveBeenCalledWith(t('en').group_rsvp_removed);
  });

  test('uses the clicking member language for the toast', async () => {
    const recordGroupAttendance = mock(() => ({ success: true }));
    const ctx = makeGroupCtx('grsvp:42:going', 'ru');
    const handler = makeHandler({ recordGroupAttendance });

    await handler(ctx as never);

    expect(ctx.answer).toHaveBeenCalledWith(t('ru').group_rsvp_recorded);
  });

  test('rejects the RSVP and records nothing when the service denies authorization', async () => {
    const recordGroupAttendance = mock(() => ({
      success: false,
      error: 'No active group invitation links this event to this chat',
    }));
    const ctx = makeGroupCtx('grsvp:42:going');
    const handler = makeHandler({ recordGroupAttendance });

    await handler(ctx as never);

    expect(recordGroupAttendance).toHaveBeenCalledWith(42, 200, 'accepted', GROUP_CHAT_ID);
    expect(ctx.answer).toHaveBeenCalledWith({ text: t('en').group_rsvp_not_authorized });
  });

  test('fails closed without calling the service when the tap is not in a group chat', async () => {
    const recordGroupAttendance = mock(() => ({ success: true }));
    // Private chat — getGroupId returns null, so the RSVP cannot be bound to a group.
    const ctx = { ...makeCtx('grsvp:42:going'), chat: { type: 'private', id: 200 } };
    const handler = makeHandler({ recordGroupAttendance });

    await handler(ctx as never);

    expect(recordGroupAttendance).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalledWith({ text: t('en').group_rsvp_not_authorized });
  });

  test('fails closed without calling the service when the callback carries no chat', async () => {
    const recordGroupAttendance = mock(() => ({ success: true }));
    const ctx = makeCtx('grsvp:42:going');
    const handler = makeHandler({ recordGroupAttendance });

    await handler(ctx as never);

    expect(recordGroupAttendance).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalledWith({ text: t('en').group_rsvp_not_authorized });
  });

  test('shows a /start hint and records nothing when the clicker has no dbUser', async () => {
    const recordGroupAttendance = mock(() => ({ success: true }));
    const ctx = {
      data: 'grsvp:42:going',
      dbUser: undefined,
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };
    const handler = makeHandler({ recordGroupAttendance });

    await handler(ctx as never);

    expect(recordGroupAttendance).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalledWith({ text: t('en').group_rsvp_start_hint, show_alert: true });
  });

  test('rejects a non-numeric event id without calling the service (grsvp:abc:going)', async () => {
    const recordGroupAttendance = mock(() => ({ success: true }));
    const ctx = makeGroupCtx('grsvp:abc:going');
    const handler = makeHandler({ recordGroupAttendance });

    await handler(ctx as never);

    // Number('abc') is NaN → the guard rejects before any write.
    expect(recordGroupAttendance).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('rejects an unknown action without calling the service (grsvp:42:bogus)', async () => {
    const recordGroupAttendance = mock(() => ({ success: true }));
    const ctx = makeGroupCtx('grsvp:42:bogus');
    const handler = makeHandler({ recordGroupAttendance });

    await handler(ctx as never);

    // Only 'going'/'notgoing' are valid actions → anything else writes nothing.
    expect(recordGroupAttendance).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('localizes the /start hint to the tapper language_code when there is no dbUser', async () => {
    const recordGroupAttendance = mock(() => ({ success: true }));
    const ctx = {
      data: 'grsvp:42:going',
      dbUser: undefined,
      from: { languageCode: 'ru' },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };
    const handler = makeHandler({ recordGroupAttendance });

    await handler(ctx as never);

    expect(recordGroupAttendance).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalledWith({ text: t('ru').group_rsvp_start_hint, show_alert: true });
  });
});

describe('inviter notification on response', () => {
  function makeHandlerWithNotify(
    invitationService: unknown,
    notifyDeps: { userRepo: { findByTelegramId: ReturnType<typeof mock> }; sendMessage: ReturnType<typeof mock> },
    eventRepo?: { findById: ReturnType<typeof mock> },
  ) {
    return createCallbackHandler({} as never, {} as never, {} as never, {} as never, {
      invitationService: invitationService as never,
      eventRepo: eventRepo as never,
      invitationNotifyDeps: notifyDeps as never,
    });
  }

  test('notifies inviter when invitation is accepted', async () => {
    const sendMessage = mock(() => Promise.resolve());
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'accepted', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, first_name: 'Sender', language: 'en' })),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Party', start_at: '2026-03-15T18:00:00Z' })),
    };

    const ctx = makeCtx('inv:accept:1');
    const handler = makeHandlerWithNotify(invitationService, { userRepo, sendMessage }, eventRepo);

    await handler(ctx as never);

    // Wait for async notification
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call0 = sendMessage.mock.calls[0] as unknown[];
    expect(call0[0]).toBe(100);
    expect(call0[1] as string).toContain('Party');
    expect(call0[1] as string).toContain('accepted');
    expect(call0[1] as string).toContain('✅');
  });

  test('notifies inviter when invitation is declined', async () => {
    const sendMessage = mock(() => Promise.resolve());
    const invitationService = {
      declineInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'declined', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, first_name: 'Sender', language: 'en' })),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Meeting', start_at: '2026-03-15T10:00:00Z' })),
    };

    const ctx = makeCtx('inv:decline:1');
    const handler = makeHandlerWithNotify(invitationService, { userRepo, sendMessage }, eventRepo);

    await handler(ctx as never);
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call0 = sendMessage.mock.calls[0] as unknown[];
    expect(call0[0]).toBe(100);
    expect(call0[1] as string).toContain('declined');
    expect(call0[1] as string).toContain('❌');
  });

  test('notifies inviter in their language', async () => {
    const sendMessage = mock(() => Promise.resolve());
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'accepted', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, first_name: 'Отправитель', language: 'ru' })),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Встреча', start_at: '2026-03-15T10:00:00Z' })),
    };

    const ctx = makeCtx('inv:accept:1');
    const handler = makeHandlerWithNotify(invitationService, { userRepo, sendMessage }, eventRepo);

    await handler(ctx as never);
    await flushPromises();

    const call0 = sendMessage.mock.calls[0] as unknown[];
    expect(call0[1] as string).toContain('принял');
    expect(call0[1] as string).toContain('Встреча');
  });

  test('does not notify when response fails', async () => {
    const sendMessage = mock(() => Promise.resolve());
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: false,
        error: 'Already responded',
      })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, first_name: 'Sender', language: 'en' })),
    };

    const ctx = makeCtx('inv:accept:1');
    const handler = makeHandlerWithNotify(invitationService, { userRepo, sendMessage });

    await handler(ctx as never);
    await flushPromises();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('does not crash when sendMessage fails', async () => {
    const sendMessage = mock(() => Promise.reject(new Error('Forbidden')));
    const invitationService = {
      acceptInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'accepted', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, first_name: 'Sender', language: 'en' })),
    };

    const ctx = makeCtx('inv:accept:1');
    const handler = makeHandlerWithNotify(invitationService, { userRepo, sendMessage });

    // Should not throw
    await handler(ctx as never);
    await flushPromises();
    expect(ctx.answer).toHaveBeenCalled();
  });
});

describe('propose-time callbacks', () => {
  function makeHandlerWithPropose(
    invitationService: unknown,
    proposeTimeSessions?: Map<number, { invitationId: number }>,
    invitationRepo?: { findById: ReturnType<typeof mock> },
    eventRepoArg?: { findById: ReturnType<typeof mock> },
    notifyDeps?: {
      userRepo: { findByTelegramId: ReturnType<typeof mock> };
      sendMessage: ReturnType<typeof mock>;
      editMessage?: ReturnType<typeof mock>;
    },
  ) {
    return createCallbackHandler({} as never, {} as never, {} as never, {} as never, {
      invitationService: invitationService as never,
      eventRepo: eventRepoArg as never,
      invitationNotifyDeps: notifyDeps as never,
      proposeTimeSessions,
      invitationRepo: invitationRepo as never,
    });
  }

  test('propose callback sets session and sends prompt', async () => {
    const proposeTimeSessions = new Map<number, { invitationId: number }>();
    const inv = { id: 5, invitee_id: 200, inviter_id: 100, event_id: 3, status: 'pending', proposed_time: null };
    const event = { id: 3, start_at: '2026-04-01T10:00:00Z' };
    const invitationRepo = { findById: mock(() => inv) };
    const eventRepoMock = { findById: mock(() => event) };
    const invitationService = { proposeTime: mock(() => ({ success: true, invitation: inv })) };

    const ctx = {
      data: 'inv:propose:5',
      dbUser: { telegram_id: 200, language: 'en', timezone: 'UTC' },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
      message: { send: mock(() => Promise.resolve()) },
    };

    const handler = makeHandlerWithPropose(invitationService, proposeTimeSessions, invitationRepo, eventRepoMock);
    await handler(ctx as never);

    expect(proposeTimeSessions.has(200)).toBe(true);
    expect(ctx.message.send).toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('propose:+30 calls proposeTime with +30min offset', async () => {
    const inv = {
      id: 5,
      invitee_id: 200,
      inviter_id: 100,
      event_id: 3,
      status: 'pending',
      proposed_time: null,
      message_id: 42,
      chat_id: 200,
    };
    const event = { id: 3, start_at: '2026-04-01T10:00:00Z', title: 'Party' };
    const invitationRepo = { findById: mock(() => inv) };
    const eventRepoMock = { findById: mock(() => event) };
    const invitationService = {
      proposeTime: mock(() => ({ success: true, invitation: { ...inv, proposed_time: '2026-04-01T10:30:00Z' } })),
    };
    const notifyDeps = {
      userRepo: { findByTelegramId: mock(() => ({ language: 'en', first_name: 'Alice' })) },
      sendMessage: mock(() => Promise.resolve()),
    };

    const ctx = {
      data: 'inv:propose:5:+30',
      dbUser: { telegram_id: 200, language: 'en', timezone: 'UTC' },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };

    const handler = makeHandlerWithPropose(invitationService, undefined, invitationRepo, eventRepoMock, notifyDeps);
    await handler(ctx as never);

    expect(invitationService.proposeTime).toHaveBeenCalledWith(5, 200, '2026-04-01T10:30:00Z');
    expect(ctx.editText).toHaveBeenCalled();
    await flushPromises();
    expect(notifyDeps.sendMessage).toHaveBeenCalled();
  });

  test('reschedule callback accepts the proposal, moving the event with its duration, and notifies the invitee', async () => {
    const proposedTime = '2026-04-01T14:00:00Z';
    const inv = {
      id: 5,
      invitee_id: 200,
      inviter_id: 100,
      event_id: 3,
      status: 'pending',
      proposed_time: proposedTime,
      message_id: 42,
      chat_id: 200,
    };
    const event = { id: 3, start_at: '2026-04-01T10:00:00Z', end_at: '2026-04-01T11:00:00Z', title: 'Party' };
    const invitationRepo = { findById: mock(() => inv) };
    const eventRepoMock = { findById: mock(() => event) };
    const eventServiceMock = { updateEvent: mock(() => event) };
    const invitationService = {
      rescheduleFromProposal: mock(
        (_invId: number, _userId: number, moveEvent: (eventId: number, proposedTime: string) => void) => {
          moveEvent(inv.event_id, proposedTime);
          return { success: true, invitation: inv, proposedTime };
        },
      ),
    };
    const notifyDeps = {
      userRepo: { findByTelegramId: mock(() => ({ language: 'en', first_name: 'Alice' })) },
      sendMessage: mock(() => Promise.resolve()),
    };

    const ctx = {
      data: 'inv:reschedule:5',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };

    const handler = createCallbackHandler(eventServiceMock as never, {} as never, {} as never, {} as never, {
      invitationService: invitationService as never,
      eventRepo: eventRepoMock as never,
      invitationNotifyDeps: notifyDeps as never,
      invitationRepo: invitationRepo as never,
    });
    await handler(ctx as never);

    expect(invitationService.rescheduleFromProposal).toHaveBeenCalledWith(5, 100, expect.any(Function));
    expect(eventServiceMock.updateEvent).toHaveBeenCalledWith(3, 100, {
      start_at: proposedTime,
      end_at: '2026-04-01T15:00:00.000Z',
    });
    expect(ctx.editText).toHaveBeenCalled();
    await flushPromises();
    expect(notifyDeps.sendMessage).toHaveBeenCalled();
  });

  test('dismiss callback calls keepOriginalTime and notifies invitee', async () => {
    const inv = {
      id: 5,
      invitee_id: 200,
      inviter_id: 100,
      event_id: 3,
      status: 'pending',
      proposed_time: '2026-04-01T14:00:00Z',
      message_id: 42,
      chat_id: 200,
    };
    const event = { id: 3, start_at: '2026-04-01T10:00:00Z', title: 'Party' };
    const invitationRepo = { findById: mock(() => inv) };
    const eventRepoMock = { findById: mock(() => event) };
    const invitationService = {
      keepOriginalTime: mock(() => ({ success: true, invitation: { ...inv, proposed_time: null } })),
    };
    const notifyDeps = {
      userRepo: { findByTelegramId: mock(() => ({ language: 'en', first_name: 'Alice' })) },
      sendMessage: mock(() => Promise.resolve()),
      editMessage: mock(() => Promise.resolve()),
    };

    const ctx = {
      data: 'inv:dismiss:5',
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };

    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never, {
      invitationService: invitationService as never,
      eventRepo: eventRepoMock as never,
      invitationNotifyDeps: notifyDeps as never,
      invitationRepo: invitationRepo as never,
    });
    await handler(ctx as never);

    expect(invitationService.keepOriginalTime).toHaveBeenCalledWith(5, 100);
    expect(ctx.editText).toHaveBeenCalled();
    await flushPromises();
    expect(notifyDeps.sendMessage).toHaveBeenCalled();
    expect(notifyDeps.editMessage).toHaveBeenCalled();
    // The restored invitation card gets the canonical RSVP keyboard back
    const [, , , markup] = notifyDeps.editMessage.mock.calls[0] as unknown as [number, number, string, InlineKeyboard];
    expect(markup.toJSON()).toEqual(invitationRsvpKeyboard(5, 'en', null).toJSON());
  });
});

describe('conflict image on accept', () => {
  function makeHandlerWithRender(
    invSvc: unknown,
    notifyDeps: {
      userRepo: { findByTelegramId: ReturnType<typeof mock> };
      sendMessage: ReturnType<typeof mock>;
      sendPhoto?: ReturnType<typeof mock>;
    },
    eventRepo: {
      findById: ReturnType<typeof mock>;
      findVisibleOverlapping?: ReturnType<typeof mock>;
      isParticipant?: ReturnType<typeof mock>;
    },
    renderService: { renderDirect: ReturnType<typeof mock> },
  ) {
    return createCallbackHandler({} as never, {} as never, {} as never, {} as never, {
      renderService: renderService as never,
      invitationService: invSvc as never,
      eventRepo: eventRepo as never,
      invitationNotifyDeps: notifyDeps as never,
    });
  }

  test('sends conflict image to inviter on accept when renderService provided', async () => {
    const sendPhoto = mock(() => Promise.resolve());
    const renderDirect = mock(() => Promise.resolve(png()));
    const sendMessage = mock(() => Promise.resolve());
    const inv = { id: 1, status: 'accepted', event_id: 5, inviter_id: 100, invitee_id: 200 };
    const event = { id: 5, title: 'Party', start_at: '2026-03-20T10:00:00Z', end_at: '2026-03-20T11:00:00Z' };
    const invSvc = { acceptInvitation: mock(() => ({ success: true, invitation: inv })) };
    const userRepo = {
      findByTelegramId: mock(() => ({
        telegram_id: 100,
        first_name: 'Alice',
        language: 'en',
        username: null,
        timezone: 'UTC',
      })),
    };
    const eventRepo = {
      findById: mock(() => event),
      findVisibleOverlapping: mock(() => []),
      isParticipant: mock(() => false),
    };
    const renderService = { renderDirect };
    const notifyDeps = { userRepo, sendMessage, sendPhoto };
    const ctx = {
      data: 'inv:accept:1',
      dbUser: { telegram_id: 200, language: 'en', timezone: 'UTC', first_name: 'Bob', username: null },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };
    const handler = makeHandlerWithRender(invSvc, notifyDeps, eventRepo, renderService);
    await handler(ctx as never);
    await flushPromises();
    expect(renderDirect).toHaveBeenCalledTimes(1);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    const photoCall = sendPhoto.mock.calls[0] as unknown[];
    expect(photoCall[0]).toBe(100);
  });

  test('invitee event titles are null for non-shared events in conflict image', async () => {
    const sendPhoto = mock(() => Promise.resolve());
    const renderDirect = mock(() => Promise.resolve(png()));
    const sendMessage = mock(() => Promise.resolve());
    const inv = { id: 1, status: 'accepted', event_id: 5, inviter_id: 100, invitee_id: 200 };
    const event = { id: 5, title: 'Party', start_at: '2026-03-20T10:00:00Z', end_at: '2026-03-20T11:00:00Z' };
    const inviteeEvent = { id: 99, title: 'Secret', start_at: '2026-03-20T09:00:00Z', end_at: '2026-03-20T10:30:00Z' };
    const invSvc = { acceptInvitation: mock(() => ({ success: true, invitation: inv })) };
    const userRepo = {
      findByTelegramId: mock((id: number) =>
        id === 100
          ? { telegram_id: 100, first_name: 'Alice', language: 'en', username: null, timezone: 'UTC' }
          : { telegram_id: 200, first_name: 'Bob', language: 'en', username: 'bob', timezone: 'UTC' },
      ),
    };
    // isParticipant returns false → organizer is NOT participant of invitee's event → title must be null
    const eventRepo = {
      findById: mock(() => event),
      // organizer call returns [] (no own overlapping), invitee call returns [inviteeEvent]
      findVisibleOverlapping: mock((userId: number) => (userId === 200 ? [inviteeEvent] : [])),
      isParticipant: mock(() => false),
    };
    const renderService = { renderDirect };
    const notifyDeps = { userRepo, sendMessage, sendPhoto };
    const ctx = {
      data: 'inv:accept:1',
      dbUser: { telegram_id: 200, language: 'en', timezone: 'UTC', first_name: 'Bob', username: 'bob' },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };
    const handler = makeHandlerWithRender(invSvc, notifyDeps, eventRepo, renderService);
    await handler(ctx as never);
    await flushPromises();

    expect(renderDirect).toHaveBeenCalledTimes(1);
    const renderCall = renderDirect.mock.calls[0] as unknown[];
    const renderArg = renderCall[0] as { data: { rows: { slots: { label: string | null }[] }[] } };
    const inviteeRow = renderArg.data.rows[1]; // rows[0] = organizer, rows[1] = invitee
    if (!inviteeRow) throw new Error('invitee row missing from renderDirect args');
    // All slots for non-shared invitee events must have null label
    for (const slot of inviteeRow.slots) {
      expect(slot.label).toBeNull();
    }
  });

  test('does not render when renderService missing', async () => {
    const sendPhoto = mock(() => Promise.resolve());
    const sendMessage = mock(() => Promise.resolve());
    const inv = { id: 1, status: 'accepted', event_id: 5, inviter_id: 100, invitee_id: 200 };
    const event = { id: 5, title: 'Party', start_at: '2026-03-20T10:00:00Z', end_at: '2026-03-20T11:00:00Z' };
    const invSvc = { acceptInvitation: mock(() => ({ success: true, invitation: inv })) };
    const userRepo = {
      findByTelegramId: mock(() => ({
        telegram_id: 100,
        first_name: 'Alice',
        language: 'en',
        username: null,
        timezone: 'UTC',
      })),
    };
    const eventRepo = {
      findById: mock(() => event),
      findVisibleOverlapping: mock(() => []),
      isParticipant: mock(() => false),
    };
    const notifyDeps = { userRepo, sendMessage, sendPhoto };
    const ctx = {
      data: 'inv:accept:1',
      dbUser: { telegram_id: 200, language: 'en', timezone: 'UTC', first_name: 'Bob', username: null },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never, {
      invitationService: invSvc as never,
      eventRepo: eventRepo as never,
      invitationNotifyDeps: notifyDeps as never,
    });
    await handler(ctx as never);
    await flushPromises();
    expect(sendPhoto).not.toHaveBeenCalled();
  });
});

describe('inviter acting on a time proposal that is already closed', () => {
  const INVITER = 100;
  const INVITEE = 200;

  function setupRealInvitation() {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: INVITER, timezone: 'UTC', language: 'en' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC', language: 'en' });
    const eventRepo = new EventRepository(db);
    const eventService = new EventService({ eventRepo });
    const invRepo = new InvitationRepository(db);
    const participantRepo = new ParticipantRepository(db);
    const invitationService = new InvitationService(
      invRepo,
      eventRepo,
      new SharingSettingsRepository(db),
      participantRepo,
    );
    const event = eventService.createEvent({
      user_id: INVITER,
      title: 'Fixture meetup',
      start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
    });
    const invitation = invitationService.sendInvitation(event.id, INVITER, INVITEE).invitation!;
    const notifyDeps = { userRepo, sendMessage: mock(() => Promise.resolve()) };
    const handler = makeCallbackHandler(
      { invitationService, eventRepo, invitationRepo: invRepo, invitationNotifyDeps: notifyDeps },
      eventService,
    );
    return { handler, invitationService, invRepo, eventRepo, participantRepo, event, invitation, notifyDeps };
  }

  test('a decline after proposing survives the inviter tapping Reschedule', async () => {
    const { handler, invitationService, invRepo, eventRepo, participantRepo, event, invitation, notifyDeps } =
      setupRealInvitation();
    const proposedTime = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    invitationService.proposeTime(invitation.id, INVITEE, proposedTime);
    invitationService.declineInvitation(invitation.id, INVITEE);

    const tap = makeCallbackTap(`inv:reschedule:${invitation.id}`, { telegram_id: INVITER, language: 'en' });
    await handler(tap.ctx);
    await flushPromises();

    expect(invRepo.findById(invitation.id)!.status).toBe('declined');
    expect(participantRepo.findByEventAndUser(event.id, INVITEE)).toBeNull();
    expect(eventRepo.findById(event.id, INVITER)!.start_at).toBe(event.start_at);
    expect(tap.answer).toHaveBeenCalledWith({ text: t('en').invite_proposal_closed });
    expect(tap.editText).toHaveBeenCalledWith(t('en').invite_proposal_closed, { parse_mode: 'HTML' });
    expect(notifyDeps.sendMessage).not.toHaveBeenCalled();
  });

  test('a second tap on an already settled proposal keeps the invitation pending and the event in place', async () => {
    const { handler, invitationService, invRepo, eventRepo, participantRepo, event, invitation, notifyDeps } =
      setupRealInvitation();
    // Two notices reach the inviter: the invitee first suggests one time, then another.
    const firstProposal = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const secondProposal = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    invitationService.proposeTime(invitation.id, INVITEE, firstProposal);
    invitationService.proposeTime(invitation.id, INVITEE, secondProposal);

    const keep = makeCallbackTap(`inv:dismiss:${invitation.id}`, { telegram_id: INVITER, language: 'en' });
    await handler(keep.ctx);
    await flushPromises();
    expect(keep.editText).toHaveBeenCalledWith(t('en').invite_kept_inviter, { parse_mode: 'HTML' });
    const sentAfterKeep = notifyDeps.sendMessage.mock.calls.length;

    // A double tap on the settled notice, then Reschedule on the second notice.
    for (const data of [`inv:dismiss:${invitation.id}`, `inv:reschedule:${invitation.id}`]) {
      const tap = makeCallbackTap(data, { telegram_id: INVITER, language: 'en' });
      await handler(tap.ctx);
      await flushPromises();
      expect(tap.answer).toHaveBeenCalledWith({ text: t('en').invite_proposal_closed });
      expect(tap.editText).toHaveBeenCalledWith(t('en').invite_proposal_closed, { parse_mode: 'HTML' });
    }

    const stored = invRepo.findById(invitation.id)!;
    expect(stored.status).toBe('pending');
    expect(stored.proposed_time).toBeNull();
    expect(participantRepo.findByEventAndUser(event.id, INVITEE)).toBeNull();
    expect(eventRepo.findById(event.id, INVITER)!.start_at).toBe(event.start_at);
    expect(notifyDeps.sendMessage).toHaveBeenCalledTimes(sentAfterKeep);
  });
});

describe('RSVP taps on a revoked invitation', () => {
  const INVITER = 100;
  const INVITEE = 200;

  // An invitation outlives its event's delete (#505) — only open ones become cancelled — and its card
  // can still carry RSVP buttons: a second copy of the card (deep link, re-send) or a failed rewrite
  // after an answer. Once the event is gone, even a declined one is refused like a cancelled one.
  const REVOKED = [
    ['cancelled', false, 'invitation_cancelled'],
    ['expired', false, 'invitation_expired'],
    ['declined', true, 'invitation_cancelled'],
    ['expired', true, 'invitation_expired'],
  ] as const;

  function setupRevokedInvitation(status: 'cancelled' | 'expired' | 'declined', eventDeleted: boolean) {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: INVITER, timezone: 'UTC', language: 'en' });
    userRepo.create({ telegram_id: INVITEE, timezone: 'UTC', language: 'en' });
    const eventRepo = new EventRepository(db);
    const invRepo = new InvitationRepository(db);
    const participantRepo = new ParticipantRepository(db);
    const invitationService = new InvitationService(
      invRepo,
      eventRepo,
      new SharingSettingsRepository(db),
      participantRepo,
    );
    const event = eventRepo.create({
      user_id: INVITER,
      title: 'Fixture meetup',
      start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
    });
    const invitation = invitationService.sendInvitation(event.id, INVITER, INVITEE).invitation!;
    if (status === 'cancelled') {
      invitationService.cancelInvitation(invitation.id, INVITER);
    } else if (status === 'expired') {
      db.prepare("UPDATE events SET start_at = datetime('now', '-1 hour') WHERE id = ?").run(event.id);
      invRepo.expirePastInvitations();
    } else {
      invitationService.declineInvitation(invitation.id, INVITEE);
    }
    if (eventDeleted) {
      expect(eventRepo.remove(event.id, INVITER)).toBe(true);
    }
    expect(invRepo.findById(invitation.id)!.status).toBe(status);
    const handler = makeCallbackHandler({ invitationService, eventRepo, invitationRepo: invRepo });
    return { handler, invRepo, participantRepo, event, invitation };
  }

  test.each(
    REVOKED.flatMap(([status, eventDeleted, reason]) =>
      (['accept', 'maybe', 'decline'] as const).map((action) => [status, eventDeleted, reason, action] as const),
    ),
  )('%s invitation (event deleted: %p) is refused with %s on %s, keeps the status and adds no participant', async (status, eventDeleted, reason, action) => {
    const { handler, invRepo, participantRepo, event, invitation } = setupRevokedInvitation(status, eventDeleted);

    const tap = makeCallbackTap(`inv:${action}:${invitation.id}`, { telegram_id: INVITEE, language: 'en' });
    await handler(tap.ctx);

    expect(invRepo.findById(invitation.id)!.status).toBe(status);
    expect(participantRepo.findByEventAndUser(event.id, INVITEE)).toBeNull();
    expect(tap.answer).toHaveBeenCalledWith(t('en')[reason]);
    expect(tap.editText).not.toHaveBeenCalled();
  });

  test.each(
    REVOKED,
  )('%s invitation (event deleted: %p): a +30 proposal is refused with %s', async (status, eventDeleted, reason) => {
    const { handler, invRepo, invitation } = setupRevokedInvitation(status, eventDeleted);

    const tap = makeCallbackTap(`inv:propose:${invitation.id}:+30`, { telegram_id: INVITEE, language: 'en' });
    await handler(tap.ctx);

    expect(invRepo.findById(invitation.id)!.proposed_time).toBeNull();
    expect(tap.answer).toHaveBeenCalledWith({ text: t('en')[reason] });
  });
});

describe('delivered cards after the inviter accepts a proposed time', () => {
  const INVITER = 100;
  const INVITEE = 200;
  const OTHER_INVITEE = 201;

  test("the proposer's card shows the answer, the roster and the moved time; other cards move too", async () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: INVITER, first_name: 'Anna', timezone: 'UTC', language: 'en' });
    userRepo.create({ telegram_id: INVITEE, first_name: 'Boris', timezone: 'UTC', language: 'en' });
    userRepo.create({ telegram_id: OTHER_INVITEE, first_name: 'Vera', timezone: 'UTC', language: 'en' });
    const eventRepo = new EventRepository(db);
    const invRepo = new InvitationRepository(db);
    const bus = new DomainEventBus();
    const edits: { chatId: number; messageId: number; text: string; options: InvitationEditOptions }[] = [];
    const refresher = new InvitationCardRefresher({
      eventRepo,
      invitationRepo: invRepo,
      userRepo,
      editMessage: async (chatId, messageId, text, options) => {
        edits.push({ chatId, messageId, text, options });
      },
    });
    const passes: Promise<void>[] = [];
    bus.on('invitationRoster.changed', (change) => {
      passes.push(refresher.refresh(change));
    });
    const settled = async () => {
      while (passes.length) await passes.shift();
    };
    const invitationService = new InvitationService(
      invRepo,
      eventRepo,
      new SharingSettingsRepository(db),
      new ParticipantRepository(db),
      bus,
    );
    const eventService = new EventService({ eventRepo });
    const day = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const event = eventService.createEvent({
      user_id: INVITER,
      title: 'Dinner',
      start_at: `${day}T10:00:00Z`,
      end_at: `${day}T11:00:00Z`,
      timezone: 'UTC',
    });
    const invitation = invitationService.sendInvitation(event.id, INVITER, INVITEE).invitation!;
    invRepo.setMessageInfo(invitation.id, 77, INVITEE);
    const other = invitationService.sendInvitation(event.id, INVITER, OTHER_INVITEE).invitation!;
    invRepo.setMessageInfo(other.id, 78, OTHER_INVITEE);
    invitationService.proposeTime(invitation.id, INVITEE, `${day}T15:00:00Z`);
    await settled();
    edits.length = 0;

    const handler = makeCallbackHandler(
      {
        invitationService,
        eventRepo,
        invitationRepo: invRepo,
        invitationNotifyDeps: { userRepo, sendMessage: mock(() => Promise.resolve()) },
      },
      eventService,
    );
    await handler(makeCallbackTap(`inv:reschedule:${invitation.id}`, { telegram_id: INVITER, language: 'en' }).ctx);
    await settled();

    const lastEdit = (messageId: number) => {
      const edit = edits.filter((e) => e.messageId === messageId).at(-1);
      if (!edit) throw new Error(`card ${messageId} was not re-rendered`);
      return edit;
    };
    const card = lastEdit(77);
    expect(card.chatId).toBe(INVITEE);
    expect(card.text).toContain('✅ Boris (you) — going');
    expect(card.text).toContain('15:00–16:00');
    expect(card.text).not.toContain('10:00');
    expect(card.options.reply_markup).toBeUndefined();
    const otherCard = lastEdit(78);
    expect(otherCard.text).toContain('✅ Boris — going');
    expect(otherCard.text).toContain('15:00–16:00');
    expect(otherCard.text).not.toContain('10:00');
  });
});
