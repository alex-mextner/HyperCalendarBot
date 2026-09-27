import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import { createMessageHandler, type MessageHandlerDeps } from '../../src/bot/handlers/message.handler.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';
import { t } from '../../src/config/constants.ts';
import { migrations } from '../../src/database/migrations.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { InvitationService } from '../../src/services/sharing/invitation-service.ts';
import { makeCallbackHandler, makeCallbackTap } from '../helpers/callback-handler.ts';
import { flushPromises } from '../helpers/mock-context.ts';

const INVITER = 100;
const INVITEE = 200;
const ANSWERS = [
  ['acceptInvitation', 'accepted'],
  ['declineInvitation', 'declined'],
  ['maybeInvitation', 'maybe'],
] as const;

/** An invitation the invitee has already answered with `answer`; its card sits in the invitee's chat. */
function setupAnsweredInvitation(answer: (typeof ANSWERS)[number][0]) {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  userRepo.create({ telegram_id: INVITER, timezone: 'UTC', language: 'en' });
  userRepo.create({ telegram_id: INVITEE, timezone: 'UTC', language: 'en' });
  const eventRepo = new EventRepository(db);
  const invitationRepo = new InvitationRepository(db);
  const invitationService = new InvitationService(invitationRepo, eventRepo, new SharingSettingsRepository(db));
  const event = eventRepo.create({
    user_id: INVITER,
    title: 'Fixture meetup',
    start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    timezone: 'UTC',
  });
  const invitation = invitationService.sendInvitation(event.id, INVITER, INVITEE).invitation!;
  invitationRepo.setMessageInfo(invitation.id, 111, INVITEE);
  expect(invitationService[answer](invitation.id, INVITEE).success).toBe(true);
  return { userRepo, eventRepo, invitationRepo, invitationService, invitation };
}

describe('time proposal on an invitation the invitee already answered', () => {
  test.each(
    ANSWERS,
  )('after %s, a stale +30 stores nothing, tells the inviter nothing and says it was answered', async (answer, status) => {
    const { userRepo, eventRepo, invitationRepo, invitationService, invitation } = setupAnsweredInvitation(answer);
    const sendMessage = mock((_chatId: number, _text: string, _params?: unknown) => Promise.resolve());
    const editMessage = mock((_chatId: number, _messageId: number, _text: string) => Promise.resolve());
    const handler = makeCallbackHandler({
      invitationService,
      eventRepo,
      invitationRepo,
      invitationNotifyDeps: { userRepo, sendMessage, editMessage },
    });

    // The +30/+60 prompt is a separate message, so its buttons survive the answer on the card.
    const tap = makeCallbackTap(`inv:propose:${invitation.id}:+30`, {
      telegram_id: INVITEE,
      language: 'en',
      timezone: 'UTC',
    });
    await handler(tap.ctx);
    await flushPromises();

    const stored = invitationRepo.findById(invitation.id)!;
    expect(stored.status).toBe(status);
    expect(stored.proposed_time).toBeNull();
    expect(tap.answer).toHaveBeenCalledWith({ text: t('en').invitation_already_answered });
    expect(tap.editText).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test.each(
    ANSWERS,
  )('after %s, a typed time from a leftover session is refused the same way', async (answer, status) => {
    const { userRepo, eventRepo, invitationRepo, invitationService, invitation } = setupAnsweredInvitation(answer);
    const proposeTimeSessions = new Map<number, { invitationId: number }>([[INVITEE, { invitationId: invitation.id }]]);
    const notifyInviterProposal = mock(() => Promise.resolve());
    const editMessage = mock(() => Promise.resolve());
    // The AI, history and reminder collaborators are never reached on this path; one cast keeps them inert.
    const handler = createMessageHandler({
      agent: { run: mock(() => Promise.resolve({ responseText: '' })) },
      eventService: { getEventsInRange: mock(() => []), getEvent: (id: number) => eventRepo.findById(id, INVITER) },
      holidayService: {},
      chatHistory: { save: mock(() => {}), getLast: mock(() => []) },
      eventReminderRepo: {},
      sceneStorage: { get: mock(() => Promise.resolve(null)), delete: mock(() => {}) },
      conversationLogger: null,
      userRepo,
      proposeTimeSessions,
      invitationService,
      invitationRepo,
      notifyInviterProposal,
      editMessage,
    } as unknown as MessageHandlerDeps);

    const send = mock((_text: string, _params?: unknown) => Promise.resolve());
    const message = {
      text: 'tomorrow 15:00',
      dbUser: { telegram_id: INVITEE, language: 'en', timezone: 'UTC' },
      chatId: INVITEE,
      send,
      chat: { type: 'private' },
    };
    await handler(message as unknown as BotCommandContext);

    const stored = invitationRepo.findById(invitation.id)!;
    expect(stored.status).toBe(status);
    expect(stored.proposed_time).toBeNull();
    expect(send).toHaveBeenCalledWith(t('en').invitation_already_answered);
    expect(editMessage).not.toHaveBeenCalled();
    expect(notifyInviterProposal).not.toHaveBeenCalled();
  });
});
