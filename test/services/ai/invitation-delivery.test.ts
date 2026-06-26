import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CalendarEvent } from '../../../src/database/types.ts';
import {
  type DeliverInvitationParams,
  deliverInvitation,
  type InvitationDeliveryDeps,
  lookupInviteeUsername,
} from '../../../src/services/ai/invitation-delivery.ts';
import type { TelegramSender } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { DeepLinkService } from '../../../src/services/sharing/deep-link-service.ts';

const INVITER_ID = 100;
const INVITEE_ID = 200;

const SENDER_BASE: TelegramSender = {
  sendMessage: async () => ({ message_id: 1 }),
  editMessageText: async () => {},
};

function makeSender(overrides: Partial<TelegramSender>): TelegramSender {
  return { ...SENDER_BASE, ...overrides };
}

describe('deliverInvitation', () => {
  let db: Database;
  let userRepo: UserRepository;
  let contactRepo: ContactRepository;
  let invitationRepo: InvitationRepository;
  let eventRepo: EventRepository;
  let eventService: EventService;
  let deepLinkService: DeepLinkService;
  let seedEvent: CalendarEvent;

  function makeDeps(sender: TelegramSender, extra: Partial<InvitationDeliveryDeps> = {}): InvitationDeliveryDeps {
    return {
      sender,
      invitationRepo,
      userRepo,
      deepLinkService,
      botUsername: 'TestBot',
      contactRepo,
      ...extra,
    };
  }

  function baseParams(opts: {
    invitationId: number;
    deps: InvitationDeliveryDeps;
    event?: CalendarEvent | null;
    allowMtproto?: boolean;
  }): DeliverInvitationParams {
    return {
      invitationId: opts.invitationId,
      eventId: seedEvent.id,
      inviteeId: INVITEE_ID,
      inviterId: INVITER_ID,
      inviterName: 'Alex',
      inviterUsername: 'alex',
      inviterTimezone: 'UTC',
      event: opts.event ?? null,
      lang: 'en',
      fallbackChatId: INVITER_ID,
      allowMtproto: opts.allowMtproto,
      deps: opts.deps,
    };
  }

  function createInvitation(): number {
    return invitationRepo.create({ event_id: seedEvent.id, inviter_id: INVITER_ID, invitee_id: INVITEE_ID }).id;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    userRepo = new UserRepository(db);
    contactRepo = new ContactRepository(db);
    invitationRepo = new InvitationRepository(db);
    eventRepo = new EventRepository(db);
    eventService = new EventService({ eventRepo });
    deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
    userRepo.create({ telegram_id: INVITER_ID, timezone: 'UTC' });
    userRepo.create({ telegram_id: INVITEE_ID, timezone: 'UTC' });
    seedEvent = eventService.createEvent({
      user_id: INVITER_ID,
      title: 'Launch Party',
      start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
    });
  });

  test('bot API success → delivered, message info persisted', async () => {
    const invId = createInvitation();
    let sentInvId: number | undefined;
    const sender = makeSender({
      sendInvitation: async (_inviteeId, _text, invitationId) => {
        sentInvId = invitationId;
        return { message_id: 42 };
      },
    });

    const result = await deliverInvitation(baseParams({ invitationId: invId, deps: makeDeps(sender) }));

    expect(result).toEqual({ delivered: true, viaDeepLink: false });
    expect(sentInvId).toBe(invId);
    const stored = invitationRepo.findById(invId);
    expect(stored?.message_id).toBe(42);
    expect(stored?.chat_id).toBe(INVITEE_ID);
  });

  test('bot API fails, connected-user MTProto succeeds → delivered, no deep link', async () => {
    const invId = createInvitation();
    const event = seedEvent;
    let connectedCalled = false;
    let adminCalled = false;
    const sender = makeSender({
      sendInvitation: async () => null,
      sendAsConnectedUser: async () => {
        connectedCalled = true;
        return true;
      },
      sendAsUser: async () => {
        adminCalled = true;
        return false;
      },
    });

    const result = await deliverInvitation(baseParams({ invitationId: invId, deps: makeDeps(sender), event }));

    expect(result).toEqual({ delivered: true, viaDeepLink: false });
    expect(connectedCalled).toBe(true);
    expect(adminCalled).toBe(false);
  });

  test('bot API fails, MTProto returns false → deep-link fallback sent to inviter', async () => {
    const invId = createInvitation();
    let mtprotoCalled = false;
    const sentMessages: { chatId: number; text: string }[] = [];
    const sender = makeSender({
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
      sendInvitation: async () => null,
      sendAsUser: async () => {
        mtprotoCalled = true;
        return false;
      },
    });

    const result = await deliverInvitation(baseParams({ invitationId: invId, deps: makeDeps(sender) }));

    expect(result).toEqual({ delivered: false, viaDeepLink: true });
    expect(mtprotoCalled).toBe(true);
    const fallback = sentMessages.find((m) => m.chatId === INVITER_ID);
    expect(fallback).toBeDefined();
    expect(fallback!.text).toContain('t.me/TestBot');
  });

  test('allowMtproto:false + bot API fails → MTProto skipped, deep-link fallback', async () => {
    const invId = createInvitation();
    let mtprotoCalled = false;
    const sentMessages: { chatId: number; text: string }[] = [];
    const sender = makeSender({
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
      sendInvitation: async () => null,
      sendAsUser: async () => {
        mtprotoCalled = true;
        return true;
      },
    });

    const result = await deliverInvitation(
      baseParams({ invitationId: invId, deps: makeDeps(sender), allowMtproto: false }),
    );

    expect(result).toEqual({ delivered: false, viaDeepLink: true });
    expect(mtprotoCalled).toBe(false);
    const fallback = sentMessages.find((m) => m.chatId === INVITER_ID);
    expect(fallback!.text).toContain('t.me/TestBot');
  });

  test('no deepLinkService → fallback without link, viaDeepLink still true', async () => {
    const invId = createInvitation();
    const sentMessages: { chatId: number; text: string }[] = [];
    const sender = makeSender({
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
      sendInvitation: async () => null,
    });

    const result = await deliverInvitation(
      baseParams({
        invitationId: invId,
        deps: makeDeps(sender, { deepLinkService: undefined, botUsername: undefined }),
      }),
    );

    expect(result).toEqual({ delivered: false, viaDeepLink: true });
    const fallback = sentMessages.find((m) => m.chatId === INVITER_ID);
    expect(fallback).toBeDefined();
    expect(fallback!.text).not.toContain('t.me');
  });

  test('sendInvitation capability missing → not delivered, no deep link', async () => {
    const invId = createInvitation();
    const result = await deliverInvitation(baseParams({ invitationId: invId, deps: makeDeps(SENDER_BASE) }));
    expect(result).toEqual({ delivered: false, viaDeepLink: false });
  });
});

describe('lookupInviteeUsername', () => {
  let db: Database;
  let userRepo: UserRepository;
  let contactRepo: ContactRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    userRepo = new UserRepository(db);
    contactRepo = new ContactRepository(db);
    userRepo.create({ telegram_id: INVITER_ID, timezone: 'UTC' });
  });

  test('returns username from users table', () => {
    userRepo.create({ telegram_id: 555, timezone: 'UTC', username: 'fromusers' });
    expect(lookupInviteeUsername({ userRepo, contactRepo }, INVITER_ID, 555)).toBe('fromusers');
  });

  test('falls back to contacts when user has no username', () => {
    contactRepo.upsert(INVITER_ID, 'Anya', 'anya_contact', 666);
    expect(lookupInviteeUsername({ userRepo, contactRepo }, INVITER_ID, 666)).toBe('anya_contact');
  });

  test('returns undefined when nothing matches', () => {
    expect(lookupInviteeUsername({ userRepo, contactRepo }, INVITER_ID, 999)).toBeUndefined();
  });
});
