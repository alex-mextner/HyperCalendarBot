import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Scene } from '@gramio/scenes';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { User } from '../../../src/database/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { asCallbackContext } from '../../fixtures/doubles.ts';

const OWNER = 71001;
const RECIPIENT = 72002;

describe('the private Telegram reconnect callback', () => {
  let db: Database;
  let user: User;
  let sessions: TelegramSessionRepository;
  let invitations: InvitationRepository;
  let invitationService: InvitationService;
  let eventService: EventService;
  const connectScene = new Scene('test-connect-telegram');

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    users.create({ telegram_id: OWNER, language: 'en', timezone: 'UTC' });
    users.create({ telegram_id: RECIPIENT, language: 'en', timezone: 'UTC' });
    user = users.findByTelegramId(OWNER)!;
    sessions = new TelegramSessionRepository(db);
    invitations = new InvitationRepository(db);
    const events = new EventRepository(db);
    eventService = new EventService({ eventRepo: events });
    invitationService = new InvitationService(invitations, events, new SharingSettingsRepository(db));
  });

  afterEach(() => {
    mock.restore();
    db.close();
  });

  function makeHandler(wired = true) {
    return createCallbackHandler(
      eventService,
      new Scene('test-edit-value'),
      new HolidayService(new HolidayRepository(db)),
      new NotificationPreferencesService(new NotificationPreferencesRepository(db)),
      {
        userRepo: new UserRepository(db),
        invitationService,
        invitationRepo: invitations,
        ...(wired
          ? {
              connectTelegramScene: connectScene,
              telegramDeps: { sessionRepo: sessions, masterKey: Buffer.alloc(32, 7) },
            }
          : {}),
      },
    );
  }

  function makeContext(chatId = OWNER, withMessage = true) {
    return {
      data: 'stg:tg_connect',
      from: { id: OWNER },
      dbUser: user,
      chatId,
      message: withMessage ? { id: 17 } : undefined,
      answer: mock(async () => {}),
      send: mock(async () => {}),
      editText: mock(async () => {}),
      scene: { enter: mock<(scene: typeof connectScene) => Promise<void>>(async () => {}) },
    };
  }

  test('an owner with no stored session can enter the ordinary wizard in private', async () => {
    const ctx = makeContext();
    expect(sessions.getActive(OWNER)).toBeNull();
    await makeHandler()(asCallbackContext(ctx));
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.scene.enter).toHaveBeenCalledTimes(1);
    expect(ctx.scene.enter.mock.calls[0]).toEqual([connectScene]);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  for (const [name, chatId, withMessage] of [
    ['group chat', -10071001, true],
    ['another private chat', RECIPIENT, true],
    ['callback without its originating message', OWNER, false],
  ] as const) {
    test(`refuses login from ${name}`, async () => {
      const ctx = makeContext(chatId, withMessage);
      await makeHandler()(asCallbackContext(ctx));
      expect(ctx.scene.enter).not.toHaveBeenCalled();
      expect(ctx.answer).toHaveBeenCalledWith(t('en').connectTelegram.privateOnly);
      expect(ctx.send).not.toHaveBeenCalled();
    });
  }

  test('a stale button when Telegram connection is not configured starts no wizard', async () => {
    const ctx = makeContext();
    await makeHandler(false)(asCallbackContext(ctx));
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.scene.enter).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('reconnect carries no pending event and preserves an already accepted invitation', async () => {
    const event = eventService.createEvent({
      user_id: OWNER,
      title: 'Synthetic accepted meeting',
      start_at: new Date(Date.now() + 86_400_000).toISOString(),
      timezone: 'UTC',
    });
    const created = invitationService.sendInvitation(event.id, OWNER, RECIPIENT);
    expect(created.success).toBe(true);
    const invitation = created.invitation!;
    expect(invitationService.acceptInvitation(invitation.id, RECIPIENT).success).toBe(true);
    const accepted = invitations.findById(invitation.id);
    if (!accepted) throw new Error('Synthetic accepted invitation was not persisted');
    expect(accepted.status).toBe('accepted');
    const sendInvitation = spyOn(invitationService, 'sendInvitation');
    const createInvitation = spyOn(invitations, 'create');
    const ctx = makeContext();

    await makeHandler()(asCallbackContext(ctx));

    expect(ctx.scene.enter.mock.calls[0]).toEqual([connectScene]);
    expect(sendInvitation).not.toHaveBeenCalled();
    expect(createInvitation).not.toHaveBeenCalled();
    expect(invitations.getByEvent(event.id)).toEqual([accepted]);
    expect(ctx.send).not.toHaveBeenCalled();
  });
});
