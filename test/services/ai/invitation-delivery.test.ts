import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Bot, TelegramError } from 'gramio';
import { z } from 'zod';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CalendarEvent } from '../../../src/database/types.ts';
import { deliverMessage } from '../../../src/services/ai/deliver-message.ts';
import {
  type DeliverInvitationParams,
  deliverInvitation,
  type InvitationDeliveryDeps,
  lookupInviteeUsername,
} from '../../../src/services/ai/invitation-delivery.ts';
import { createTelegramSender } from '../../../src/services/ai/telegram-sender.ts';
import type { InvitationKeyboardVariant, TelegramSender } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { DeepLinkService } from '../../../src/services/sharing/deep-link-service.ts';
import { jsonCodec } from '../../../src/utils/json-codec.ts';

const INVITER_ID = 100;
const INVITEE_ID = 200;

const BotRequestSchema = z.object({
  chat_id: z.number(),
  reply_markup: z
    .object({
      inline_keyboard: z.array(z.array(z.object({ text: z.string(), callback_data: z.string().optional() }))),
    })
    .optional(),
});

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
    allowInviterSession?: boolean;
    lang?: 'en' | 'ru';
    inviterLang?: 'en' | 'ru';
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
      lang: opts.lang ?? 'en',
      inviterLang: opts.inviterLang ?? opts.lang ?? 'en',
      fallbackChatId: INVITER_ID,
      allowInviterSession: opts.allowInviterSession,
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

    expect(result).toEqual({ delivered: true, viaDeepLink: false, viaBotApi: true });
    expect(sentInvId).toBe(invId);
    const stored = invitationRepo.findById(invId);
    expect(stored?.message_id).toBe(42);
    expect(stored?.chat_id).toBe(INVITEE_ID);
  });

  test('invitee who never started the bot: Bot API, then the inviter own session, then a deep link to the inviter', async () => {
    const invId = createInvitation();
    const attempts: string[] = [];
    const sender = makeSender({
      sendInvitation: async (chatId) => {
        attempts.push(`bot-api:${chatId}`);
        return null;
      },
      sendAsConnectedUser: async (inviterId, targetId) => {
        attempts.push(`inviter-session:${inviterId}->${targetId}`);
        return false;
      },
      sendMessage: async (chatId, text) => {
        attempts.push(`to-inviter:${chatId}:${text.includes('t.me/TestBot?start=') ? 'link' : 'no-link'}`);
        return { message_id: 1 };
      },
    });

    const result = await deliverInvitation(
      baseParams({ invitationId: invId, deps: makeDeps(sender), event: seedEvent }),
    );

    expect(attempts).toEqual([
      `bot-api:${INVITEE_ID}`,
      `inviter-session:${INVITER_ID}->${INVITEE_ID}`,
      `to-inviter:${INVITER_ID}:link`,
    ]);
    expect(result).toEqual({ delivered: false, viaDeepLink: true, viaBotApi: false });
  });

  test('inviter without a connected session: Bot API, then a deep link to the inviter — nothing else sends', async () => {
    const invId = createInvitation();
    const attempts: string[] = [];
    // A sender object still carrying a shared service-account send (#753): the chain must never call it.
    const sender = Object.assign(
      makeSender({
        sendInvitation: async (chatId) => {
          attempts.push(`bot-api:${chatId}`);
          return null;
        },
        sendMessage: async (chatId, text) => {
          attempts.push(`to-inviter:${chatId}:${text.includes('t.me/TestBot?start=') ? 'link' : 'no-link'}`);
          return { message_id: 1 };
        },
      }),
      {
        sendAsUser: async (userId: number) => {
          attempts.push(`service-account:${userId}`);
          return true;
        },
      },
    );

    const result = await deliverInvitation(
      baseParams({ invitationId: invId, deps: makeDeps(sender), event: seedEvent }),
    );

    expect(attempts).toEqual([`bot-api:${INVITEE_ID}`, `to-inviter:${INVITER_ID}:link`]);
    expect(result).toEqual({ delivered: false, viaDeepLink: true, viaBotApi: false });
  });

  test("bot API fails, the inviter's own session succeeds → delivered, no deep link", async () => {
    const invId = createInvitation();
    const event = seedEvent;
    let connectedCalled = false;
    const sender = makeSender({
      sendInvitation: async () => null,
      sendAsConnectedUser: async () => {
        connectedCalled = true;
        return true;
      },
    });

    const result = await deliverInvitation(baseParams({ invitationId: invId, deps: makeDeps(sender), event }));

    expect(result).toEqual({ delivered: true, viaDeepLink: false, viaBotApi: false });
    expect(connectedCalled).toBe(true);
  });

  test('first-person text from the inviter account names the verified place with a map link', async () => {
    const mapUrl = 'https://www.google.com/maps/search/?api=1&query=55.75,37.61&query_place_id=synthetic-place';
    const placed = eventService.createEvent({
      user_id: INVITER_ID,
      title: 'Launch Party',
      start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
      location: 'кафе у парка',
    });
    eventRepo.updateLocationFields(placed.id, {
      resolved_address: 'ул. Примерная, 1, Москва',
      latitude: 55.75,
      longitude: 37.61,
      google_maps_url: mapUrl,
      location_verified: 1,
      venue_name: 'Кафе Ромашка',
    });
    const event = eventRepo.findById(placed.id, INVITER_ID)!;
    const invId = invitationRepo.create({ event_id: event.id, inviter_id: INVITER_ID, invitee_id: INVITEE_ID }).id;
    const firstPersonTexts: string[] = [];
    const sender = makeSender({
      sendInvitation: async () => null,
      sendAsConnectedUser: async (_inviterId, _targetId, text) => {
        firstPersonTexts.push(text);
        return true;
      },
    });

    const result = await deliverInvitation({
      ...baseParams({ invitationId: invId, deps: makeDeps(sender), event }),
      eventId: event.id,
    });

    expect(result).toEqual({ delivered: true, viaDeepLink: false, viaBotApi: false });
    expect(firstPersonTexts).toHaveLength(1);
    expect(firstPersonTexts[0]).toContain(`📍 Кафе Ромашка — ул. Примерная, 1, Москва\n${mapUrl}`);
    expect(firstPersonTexts[0]).not.toContain('кафе у парка');
  });

  test("allowInviterSession:false + bot API fails → the inviter's session is skipped, deep-link fallback", async () => {
    const invId = createInvitation();
    let sessionCalled = false;
    const sentMessages: { chatId: number; text: string }[] = [];
    const sender = makeSender({
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
      sendInvitation: async () => null,
      sendAsConnectedUser: async () => {
        sessionCalled = true;
        return true;
      },
    });

    const result = await deliverInvitation(
      baseParams({ invitationId: invId, deps: makeDeps(sender), allowInviterSession: false, event: seedEvent }),
    );

    expect(result).toEqual({ delivered: false, viaDeepLink: true, viaBotApi: false });
    expect(sessionCalled).toBe(false);
    const fallback = sentMessages.find((m) => m.chatId === INVITER_ID);
    expect(fallback!.text).toContain('t.me/TestBot');
  });

  test('isGroupTarget + bot API fails → viaDeepLink false, no forward link sent to inviter', async () => {
    const invId = createInvitation();
    const sentMessages: { chatId: number; text: string }[] = [];
    const sender = makeSender({
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
      sendInvitation: async () => null,
    });

    const result = await deliverInvitation({
      ...baseParams({ invitationId: invId, deps: makeDeps(sender), allowInviterSession: false }),
      isGroupTarget: true,
    });

    // A forward deep-link is meaningless for a group target: it resolves in a USER's private
    // /start and callbacks auth against the user's telegram_id, not the group. So no fallback
    // is sent and the result is an honest non-delivery — never a "link sent" claim.
    expect(result).toEqual({ delivered: false, viaDeepLink: false, viaBotApi: false });
    expect(sentMessages.find((m) => m.chatId === INVITER_ID)).toBeUndefined();
  });

  test('group target passes the per-member RSVP keyboard variant {kind:group, eventId} to sendInvitation', async () => {
    const invId = createInvitation();
    let variant: InvitationKeyboardVariant | undefined;
    let sawLang: string | undefined;
    const sender = makeSender({
      sendInvitation: async (_inviteeId, _text, _invitationId, lang, v) => {
        sawLang = lang;
        variant = v;
        return { message_id: 7 };
      },
    });

    const result = await deliverInvitation({
      ...baseParams({ invitationId: invId, deps: makeDeps(sender), allowInviterSession: false, event: seedEvent }),
      isGroupTarget: true,
    });

    expect(result).toEqual({ delivered: true, viaDeepLink: false, viaBotApi: true });
    // A group target must carry the grsvp per-member keyboard keyed by eventId (not the invitation
    // id), so any member can respond for themselves — never the personal inv: keyboard.
    expect(variant).toEqual({
      kind: 'group',
      eventId: seedEvent.id,
      place: expect.objectContaining({ id: seedEvent.id }),
    });
    expect(sawLang).toBe('en');
  });

  test('personal target passes the personal keyboard variant with the event and the invitee language', async () => {
    const invId = createInvitation();
    let variant: InvitationKeyboardVariant | undefined;
    let sawLang: string | undefined;
    const sender = makeSender({
      sendInvitation: async (_inviteeId, _text, _invitationId, lang, v) => {
        sawLang = lang;
        variant = v;
        return { message_id: 8 };
      },
    });

    const result = await deliverInvitation(
      baseParams({ invitationId: invId, deps: makeDeps(sender), event: seedEvent }),
    );

    expect(result).toEqual({ delivered: true, viaDeepLink: false, viaBotApi: true });
    // The personal inv: keyboard, with the event so a confirmed place adds the Map button
    expect(variant).toEqual({ kind: 'personal', place: expect.objectContaining({ id: seedEvent.id }) });
    expect(sawLang).toBe('en');
  });

  test('no deepLinkService → fallback without link, viaDeepLink false (no link existed)', async () => {
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

    // No deep link could be built → the fallback message has no link, so reporting
    // "link sent" would be a lie. viaDeepLink must be false (→ honest "not delivered").
    expect(result).toEqual({ delivered: false, viaDeepLink: false, viaBotApi: false });
    const fallback = sentMessages.find((m) => m.chatId === INVITER_ID);
    expect(fallback).toBeDefined();
    expect(fallback!.text).not.toContain('t.me');
  });

  test("bot API + the inviter's session fail and deep-link fallback throws → not delivered, viaDeepLink false", async () => {
    const invId = createInvitation();
    let sessionCalled = false;
    const sender = makeSender({
      sendMessage: async () => {
        throw new Error('inviter blocked the bot');
      },
      sendInvitation: async () => null,
      sendAsConnectedUser: async () => {
        sessionCalled = true;
        return false;
      },
    });

    const result = await deliverInvitation(
      baseParams({ invitationId: invId, deps: makeDeps(sender), event: seedEvent }),
    );

    // The link existed but the fallback message never reached the inviter → no honest
    // claim of "link sent" can be made.
    expect(result).toEqual({ delivered: false, viaDeepLink: false, viaBotApi: false });
    expect(sessionCalled).toBe(true);
  });

  test('fallback to inviter uses inviter language; invitee message uses invitee language', async () => {
    const invId = createInvitation();
    let inviteeText: string | undefined;
    const sentToInviter: string[] = [];
    const sender = makeSender({
      sendInvitation: async (_id, text) => {
        inviteeText = text;
        return null;
      },
      sendMessage: async (chatId, text) => {
        if (chatId === INVITER_ID) sentToInviter.push(text);
        return { message_id: 1 };
      },
    });

    // Invitee speaks English, inviter speaks Russian. event:null → invitation_received text.
    const result = await deliverInvitation(
      baseParams({ invitationId: invId, deps: makeDeps(sender), event: null, lang: 'en', inviterLang: 'ru' }),
    );

    expect(result).toEqual({ delivered: false, viaDeepLink: true, viaBotApi: false });
    // The invitee-facing invitation stays in the invitee's language.
    expect(inviteeText).toContain('invitation from');
    // The fallback/forwarding message goes to the inviter and must be in the inviter's language.
    const fallback = sentToInviter.join('\n');
    expect(fallback).toContain('Перешлите ссылку получателю');
    expect(fallback).not.toContain('Forward this link');
  });

  test('setMessageInfo throw after a successful send → still delivered (no false non-delivery, no duplicate)', async () => {
    const invId = createInvitation();
    const sender = makeSender({ sendInvitation: async () => ({ message_id: 42 }) });
    // The Bot API send SUCCEEDED; only persisting the message_id (a DB UPDATE) throws.
    // The invitation was already delivered, so it MUST be reported delivered. Reporting
    // non-delivery here would make the inviter retry → the invitee gets a DUPLICATE invitation.
    // A lost message_id is a degraded-but-acceptable state; the persistence failure is logged.
    spyOn(invitationRepo, 'setMessageInfo').mockImplementation(() => {
      throw new Error('db write failed');
    });
    const result = await deliverInvitation(baseParams({ invitationId: invId, deps: makeDeps(sender) }));
    expect(result).toEqual({ delivered: true, viaDeepLink: false, viaBotApi: true });
  });

  test('createInvitationLink throws but Bot API succeeds → delivered, no deep link', async () => {
    const invId = createInvitation();
    let sentInvId: number | undefined;
    const sender = makeSender({
      sendInvitation: async (_inviteeId, _text, invitationId) => {
        sentInvId = invitationId;
        return { message_id: 42 };
      },
    });
    // Deep-link creation fails (DB error). The link is only needed by the MTProto/fallback path,
    // so a creation failure must NOT block the primary Bot API send to a reachable invitee — the
    // invitee who already started the bot still gets the invitation.
    spyOn(deepLinkService, 'createInvitationLink').mockImplementation(() => {
      throw new Error('deep-link creation failed');
    });
    const result = await deliverInvitation(baseParams({ invitationId: invId, deps: makeDeps(sender) }));
    expect(result).toEqual({ delivered: true, viaDeepLink: false, viaBotApi: true });
    expect(sentInvId).toBe(invId);
  });

  test('createInvitationLink throws and Bot API fails → no-link fallback to inviter, viaDeepLink false', async () => {
    const invId = createInvitation();
    const sentMessages: { chatId: number; text: string }[] = [];
    const sender = makeSender({
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
      sendInvitation: async () => null,
    });
    spyOn(deepLinkService, 'createInvitationLink').mockImplementation(() => {
      throw new Error('deep-link creation failed');
    });
    const result = await deliverInvitation(baseParams({ invitationId: invId, deps: makeDeps(sender) }));
    // No link could be built → MTProto (which needs the link) is skipped and the inviter fallback
    // uses the no-link variant, so no honest "link sent" claim can be made.
    expect(result).toEqual({ delivered: false, viaDeepLink: false, viaBotApi: false });
    const fallback = sentMessages.find((m) => m.chatId === INVITER_ID);
    expect(fallback).toBeDefined();
    expect(fallback!.text).not.toContain('t.me');
  });

  test('regression: a fallback send that THROWS (inviter blocked the bot, 403) → honest viaDeepLink false', async () => {
    // The fallback path relies on sender.sendMessage, which has NO internal try/catch and
    // THROWS on failure (it never resolves to a falsy value). So a failed fallback can only
    // surface as a thrown error → caught → fallbackSent:false → viaDeepLink:false. This pins
    // that there is no false "link sent" claim when the inviter has blocked the bot.
    const blocked403 = (): never => {
      throw new TelegramError(
        { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
        'sendMessage',
        { chat_id: INVITER_ID, text: 'forward https://t.me/TestBot?start=i_SECRET' },
      );
    };

    // Level 1 — deliverMessage: a rejecting fallback botSend yields fallbackSent:false.
    const dmResult = await deliverMessage({
      targetId: INVITEE_ID,
      text: 'hi',
      fallbackRecipientId: INVITER_ID,
      fallbackText: 'forward link',
      botSend: async () => blocked403(),
    });
    expect(dmResult).toEqual({ delivered: false, fallbackSent: false });

    // Level 2 — deliverInvitation: bot API + MTProto fail and the fallback to the inviter
    // throws (403) → no honest "link sent" can be claimed.
    const invId = createInvitation();
    const sender = makeSender({
      sendInvitation: async () => null,
      sendMessage: async () => blocked403(),
    });
    const result = await deliverInvitation(baseParams({ invitationId: invId, deps: makeDeps(sender) }));
    expect(result).toEqual({ delivered: false, viaDeepLink: false, viaBotApi: false });
  });

  test('sendInvitation capability missing → not delivered, no deep link', async () => {
    const invId = createInvitation();
    const result = await deliverInvitation(baseParams({ invitationId: invId, deps: makeDeps(SENDER_BASE) }));
    expect(result).toEqual({ delivered: false, viaDeepLink: false, viaBotApi: false });
  });

  test('the personal card sent to a Russian invitee has all four RSVP buttons in Russian (#727)', async () => {
    const requests: z.infer<typeof BotRequestSchema>[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requests.push(jsonCodec(BotRequestSchema).parse(await request.text()));
        return Response.json({
          ok: true,
          result: { message_id: 77, date: 1, chat: { id: INVITEE_ID, type: 'private' }, text: 'card' },
        });
      },
    });
    try {
      const bot = new Bot('1:synthetic-test', {
        info: { id: 1, is_bot: true, first_name: 'Test', username: 'TestBot' },
        api: { baseURL: `http://127.0.0.1:${server.port}/bot` },
      });
      const invId = createInvitation();
      const result = await deliverInvitation(
        baseParams({ invitationId: invId, deps: makeDeps(createTelegramSender(bot)), lang: 'ru' }),
      );

      expect(result).toEqual({ delivered: true, viaDeepLink: false, viaBotApi: true });
      expect(
        requests.map((request) => ({ to: request.chat_id, keyboard: request.reply_markup?.inline_keyboard })),
      ).toEqual([
        {
          to: INVITEE_ID,
          keyboard: [
            [
              { text: '✅ Принять', callback_data: `inv:accept:${invId}` },
              { text: '❌ Отклонить', callback_data: `inv:decline:${invId}` },
            ],
            [
              { text: 'Возможно 🤔', callback_data: `inv:maybe:${invId}` },
              { text: 'Другое время 🕐', callback_data: `inv:propose:${invId}` },
            ],
          ],
        },
      ]);
    } finally {
      server.stop(true);
    }
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
