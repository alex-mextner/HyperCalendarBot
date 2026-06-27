import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  buildChatSharedResultText,
  deliverPickerInvitation,
  deliverPickerInvitations,
  type PickerAckIo,
  type PickerDeliveryOutcome,
  type PickerInvitationDeps,
  pickerAiLine,
  pickerStatusLine,
  runChatShareWithAck,
  runPickerBatchWithAck,
} from '../../../src/bot/handlers/picker-invitation.ts';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { User } from '../../../src/database/types.ts';
import type { TelegramSender } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { DeepLinkService } from '../../../src/services/sharing/deep-link-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';

/** Centralized test cast: build an InvitationService whose sendInvitation we control. */
function invitationServiceWith(sendInvitation: InvitationService['sendInvitation']): InvitationService {
  const partial: Pick<InvitationService, 'sendInvitation'> = { sendInvitation };
  return partial as unknown as InvitationService;
}

const ALL_KINDS: PickerDeliveryOutcome[] = [
  { kind: 'delivered' },
  { kind: 'deeplink' },
  { kind: 'failed' },
  { kind: 'error', error: 'Cannot invite yourself' },
  { kind: 'notConfigured' },
];

describe('pickerStatusLine', () => {
  test.each(ALL_KINDS.map((o) => o.kind))('EN: %s line contains the name and the status emoji', (kind) => {
    const outcome = ALL_KINDS.find((o) => o.kind === kind)!;
    const line = pickerStatusLine('en', 'Bob', outcome);
    expect(line).toContain('Bob');
    expect(line).toMatch(/[✅🔗❌]/u);
  });

  test('EN routes each kind to its distinct localized string', () => {
    expect(pickerStatusLine('en', 'Bob', { kind: 'delivered' })).toBe('✅ Bob');
    expect(pickerStatusLine('en', 'Bob', { kind: 'deeplink' })).toContain('link sent to you to forward');
    expect(pickerStatusLine('en', 'Bob', { kind: 'failed' })).toContain('not delivered');
    expect(pickerStatusLine('en', 'Bob', { kind: 'notConfigured' })).toContain('invitations not configured');
    expect(pickerStatusLine('en', 'Bob', { kind: 'error', error: 'boom' })).toBe('❌ Bob: boom');
  });

  test('RU routes each kind to its distinct localized string', () => {
    expect(pickerStatusLine('ru', 'Боб', { kind: 'delivered' })).toBe('✅ Боб');
    expect(pickerStatusLine('ru', 'Боб', { kind: 'deeplink' })).toContain('ссылку отправил тебе');
    expect(pickerStatusLine('ru', 'Боб', { kind: 'failed' })).toContain('не доставлено');
    expect(pickerStatusLine('ru', 'Боб', { kind: 'notConfigured' })).toContain('приглашения не настроены');
    expect(pickerStatusLine('ru', 'Боб', { kind: 'error', error: 'boom' })).toBe('❌ Боб: boom');
  });

  test('is escaping-agnostic — the raw error is interpolated verbatim (caller escapes for HTML)', () => {
    const line = pickerStatusLine('en', 'Bob', { kind: 'error', error: '<b>oops</b>' });
    expect(line).toContain('<b>oops</b>');
  });
});

describe('pickerAiLine', () => {
  test('delivered', () => {
    expect(pickerAiLine('Bob', 42, { kind: 'delivered' })).toBe('Bob (id:42): delivered to the invitee');
  });
  test('deeplink', () => {
    expect(pickerAiLine('Bob', 42, { kind: 'deeplink' })).toBe(
      'Bob (id:42): could not reach the invitee — a forward link was sent to the inviter',
    );
  });
  test('failed', () => {
    expect(pickerAiLine('Bob', 42, { kind: 'failed' })).toBe('Bob (id:42): delivery failed');
  });
  test('error includes the reason', () => {
    expect(pickerAiLine('Bob', 42, { kind: 'error', error: 'Cannot invite yourself' })).toBe(
      'Bob (id:42): invitation not created (Cannot invite yourself)',
    );
  });
  test('notConfigured', () => {
    expect(pickerAiLine('Bob', 42, { kind: 'notConfigured' })).toBe('Bob (id:42): invitations not configured');
  });
});

const INVITER_ID = 100;
const INVITEE_ID = 200;
const GROUP_ID = -500;

describe('deliverPickerInvitation', () => {
  let db: Database;
  let userRepo: UserRepository;
  let contactRepo: ContactRepository;
  let invitationRepo: InvitationRepository;
  let eventRepo: EventRepository;
  let eventService: EventService;
  let invitationService: InvitationService;
  let deepLinkService: DeepLinkService;
  let inviter: User;
  let eventId: number;

  const SENDER_BASE: TelegramSender = {
    sendMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => {},
  };

  function makeDeps(sender: TelegramSender, extra: Partial<PickerInvitationDeps> = {}): PickerInvitationDeps {
    return {
      sender,
      invitationService,
      eventService,
      invitationRepo,
      userRepo,
      deepLinkService,
      botUsername: 'TestBot',
      contactRepo,
      ...extra,
    };
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
    invitationService = new InvitationService(invitationRepo, eventRepo, new SharingSettingsRepository(db));
    deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
    inviter = userRepo.create({ telegram_id: INVITER_ID, timezone: 'UTC', first_name: 'Alex' });
    userRepo.create({ telegram_id: INVITEE_ID, timezone: 'UTC' });
    const event = eventService.createEvent({
      user_id: INVITER_ID,
      title: 'Launch Party',
      start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
    });
    eventId = event.id;
  });

  test('no invitationService → notConfigured, nothing created or sent', async () => {
    let sent = false;
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 9 }) };
    sender.sendMessage = async () => {
      sent = true;
      return { message_id: 1 };
    };
    const outcome = await deliverPickerInvitation(
      { eventId, inviter, inviteeId: INVITEE_ID, fallbackChatId: INVITER_ID },
      makeDeps(sender, { invitationService: undefined }),
    );
    expect(outcome).toEqual({ kind: 'notConfigured' });
    expect(sent).toBe(false);
  });

  test('invitationService rejects → error outcome with the reason (no invitation row)', async () => {
    // Inviting yourself is rejected by InvitationService.
    const outcome = await deliverPickerInvitation(
      { eventId, inviter, inviteeId: INVITER_ID, fallbackChatId: INVITER_ID },
      makeDeps(SENDER_BASE),
    );
    expect(outcome).toEqual({ kind: 'error', error: 'Cannot invite yourself' });
  });

  test('bot API success → delivered', async () => {
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 42 }) };
    const outcome = await deliverPickerInvitation(
      { eventId, inviter, inviteeId: INVITEE_ID, fallbackChatId: INVITER_ID },
      makeDeps(sender),
    );
    expect(outcome).toEqual({ kind: 'delivered' });
  });

  test('persists the picker-supplied invitee_username on the created invitation row', async () => {
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 42 }) };
    await deliverPickerInvitation(
      { eventId, inviter, inviteeId: INVITEE_ID, inviteeUsername: 'invitee_handle', fallbackChatId: INVITER_ID },
      makeDeps(sender),
    );
    const row = invitationRepo.findActiveByEventAndInvitee(eventId, INVITEE_ID);
    expect(row).not.toBeNull();
    expect(row!.invitee_username).toBe('invitee_handle');
  });

  test('bot API fails, deep link available → deeplink, fallback sent to inviter private chat', async () => {
    const sentMessages: { chatId: number; text: string }[] = [];
    const sender: TelegramSender = {
      ...SENDER_BASE,
      sendInvitation: async () => null,
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
        return { message_id: 1 };
      },
    };
    const outcome = await deliverPickerInvitation(
      { eventId, inviter, inviteeId: INVITEE_ID, fallbackChatId: INVITER_ID },
      makeDeps(sender),
    );
    expect(outcome).toEqual({ kind: 'deeplink' });
    // P2-1: the private deep-link fallback must land in the inviter's private chat,
    // never in a group. No message may go to a group id.
    expect(sentMessages.some((m) => m.chatId === INVITER_ID)).toBe(true);
    expect(sentMessages.some((m) => m.chatId === GROUP_ID)).toBe(false);
  });

  test('bot API fails, no deep link configured → failed', async () => {
    const sender: TelegramSender = {
      ...SENDER_BASE,
      sendInvitation: async () => null,
      sendMessage: async () => ({ message_id: 1 }),
    };
    const outcome = await deliverPickerInvitation(
      { eventId, inviter, inviteeId: INVITEE_ID, fallbackChatId: INVITER_ID },
      makeDeps(sender, { deepLinkService: undefined, botUsername: undefined }),
    );
    expect(outcome).toEqual({ kind: 'failed' });
  });

  test('allowMtproto:false → MTProto skipped even when it would have succeeded', async () => {
    let mtprotoCalled = false;
    const sender: TelegramSender = {
      ...SENDER_BASE,
      sendInvitation: async () => null,
      sendMessage: async () => ({ message_id: 1 }),
      sendAsUser: async () => {
        mtprotoCalled = true;
        return true;
      },
    };
    const outcome = await deliverPickerInvitation(
      { eventId, inviter, inviteeId: INVITEE_ID, fallbackChatId: INVITER_ID, allowMtproto: false },
      makeDeps(sender),
    );
    expect(mtprotoCalled).toBe(false);
    // Bot API failed, MTProto disabled → deep-link fallback path.
    expect(outcome).toEqual({ kind: 'deeplink' });
  });

  test('group target failed Bot-API delivery → failed (not deeplink), no forward link to inviter (#97)', async () => {
    const sentToInviter: string[] = [];
    const sender: TelegramSender = {
      ...SENDER_BASE,
      sendInvitation: async () => null,
      sendMessage: async (chatId, text) => {
        if (chatId === INVITER_ID) sentToInviter.push(text);
        return { message_id: 1 };
      },
    };
    const outcome = await deliverPickerInvitation(
      { eventId, inviter, inviteeId: GROUP_ID, fallbackChatId: INVITER_ID, allowMtproto: false, isGroupTarget: true },
      makeDeps(sender),
    );
    // A forward deep-link cannot be accepted in a group, so the outcome must be an honest
    // failure — never a deeplink — and no useless "forward this link" message is sent.
    expect(outcome).toEqual({ kind: 'failed' });
    expect(sentToInviter).toHaveLength(0);
  });

  test('invitationService.sendInvitation throwing → error outcome, not a propagated throw (#96)', async () => {
    const svc = invitationServiceWith(() => {
      throw new Error('invitation service exploded');
    });
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 1 }) };
    const outcome = await deliverPickerInvitation(
      { eventId, inviter, inviteeId: INVITEE_ID, fallbackChatId: INVITER_ID },
      makeDeps(sender, { invitationService: svc }),
    );
    expect(outcome.kind).toBe('error');
  });
});

describe('deliverPickerInvitations (batch)', () => {
  let db: Database;
  let userRepo: UserRepository;
  let contactRepo: ContactRepository;
  let invitationRepo: InvitationRepository;
  let eventRepo: EventRepository;
  let eventService: EventService;
  let invitationService: InvitationService;
  let deepLinkService: DeepLinkService;
  let inviter: User;
  let eventId: number;

  const SENDER_BASE: TelegramSender = {
    sendMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => {},
  };

  function makeDeps(sender: TelegramSender, extra: Partial<PickerInvitationDeps> = {}): PickerInvitationDeps {
    return {
      sender,
      invitationService,
      eventService,
      invitationRepo,
      userRepo,
      deepLinkService,
      botUsername: 'TestBot',
      contactRepo,
      ...extra,
    };
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
    invitationService = new InvitationService(invitationRepo, eventRepo, new SharingSettingsRepository(db));
    deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
    inviter = userRepo.create({ telegram_id: INVITER_ID, timezone: 'UTC', first_name: 'Alex' });
    userRepo.create({ telegram_id: 201, timezone: 'UTC', first_name: 'Alice' });
    userRepo.create({ telegram_id: 202, timezone: 'UTC', first_name: 'Bob' });
    userRepo.create({ telegram_id: 203, timezone: 'UTC', first_name: 'Carol' });
    const event = eventService.createEvent({
      user_id: INVITER_ID,
      title: 'Launch Party',
      start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
    });
    eventId = event.id;
  });

  test('delivers serially (never overlapping) and preserves input order of result lines', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sender: TelegramSender = {
      ...SENDER_BASE,
      sendInvitation: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return { message_id: 1 };
      },
    };
    const result = await deliverPickerInvitations(
      {
        eventId,
        inviter,
        lang: 'en',
        fallbackChatId: INVITER_ID,
        invitees: [
          { userId: 201, firstName: 'Alice' },
          { userId: 202, firstName: 'Bob' },
          { userId: 203, firstName: 'Carol' },
        ],
      },
      makeDeps(sender),
    );
    // Serial delivery is REQUIRED: each invitee's MTProto fallback spawns send-message.py
    // against the shared non-WAL voice_caller.session; concurrent spawns corrupt it. So at
    // most one send may ever be in flight at a time.
    expect(maxInFlight).toBe(1);
    // Order preserved 1:1 with the input invitee list.
    expect(result.statusLines).toHaveLength(3);
    expect(result.statusLines[0]).toContain('Alice');
    expect(result.statusLines[1]).toContain('Bob');
    expect(result.statusLines[2]).toContain('Carol');
    expect(result.aiResultLines[0]).toContain('Alice');
    expect(result.aiResultLines[1]).toContain('Bob');
    expect(result.aiResultLines[2]).toContain('Carol');
  });

  test('one invitee throwing in the invitation pipeline does not abort the batch (#96)', async () => {
    const realSvc = invitationService;
    const svc = invitationServiceWith((e, i, id, u) => {
      if (id === 202) throw new Error('invitation service exploded');
      return realSvc.sendInvitation(e, i, id, u);
    });
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 1 }) };
    const result = await deliverPickerInvitations(
      {
        eventId,
        inviter,
        lang: 'en',
        fallbackChatId: INVITER_ID,
        invitees: [
          { userId: 201, firstName: 'Alice' },
          { userId: 202, firstName: 'Bob' },
          { userId: 203, firstName: 'Carol' },
        ],
      },
      makeDeps(sender, { invitationService: svc }),
    );
    expect(result.statusLines).toHaveLength(3);
    expect(result.statusLines[0]).toBe('✅ Alice');
    expect(result.statusLines[2]).toBe('✅ Carol');
    // The failing invitee still produces a (failure) line — its error did not abort the batch.
    expect(result.statusLines[1]).toContain('Bob');
    expect(result.aiResultLines[1]).toContain('invitation not created');
  });

  test('a throwing contact upsert does NOT cancel that invitee delivery (side effect is isolated)', async () => {
    const realUpsert = contactRepo.upsert.bind(contactRepo);
    spyOn(contactRepo, 'upsert').mockImplementation((userId, name, username, telegramId, preferredName) => {
      if (telegramId === 202) throw new Error('contact write failed');
      return realUpsert(userId, name, username, telegramId, preferredName);
    });
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 1 }) };
    const result = await deliverPickerInvitations(
      {
        eventId,
        inviter,
        lang: 'en',
        fallbackChatId: INVITER_ID,
        invitees: [
          { userId: 201, firstName: 'Alice' },
          { userId: 202, firstName: 'Bob' },
          { userId: 203, firstName: 'Carol' },
        ],
      },
      makeDeps(sender),
    );
    expect(result.statusLines).toHaveLength(3);
    expect(result.statusLines[0]).toBe('✅ Alice');
    // The contact write is a side effect — its throw must NOT abort Bob's invitation delivery.
    expect(result.statusLines[1]).toBe('✅ Bob');
    expect(result.statusLines[2]).toBe('✅ Carol');
  });

  test('each failed invitee gets a deep-link fallback that names that invitee (no cross-wiring)', async () => {
    const sentToInviter: string[] = [];
    const sender: TelegramSender = {
      ...SENDER_BASE,
      // Both invitees fail Bot API → each gets a private deep-link fallback to the inviter.
      sendInvitation: async () => null,
      sendMessage: async (chatId, text) => {
        if (chatId === INVITER_ID) sentToInviter.push(text);
        return { message_id: 1 };
      },
    };
    const result = await deliverPickerInvitations(
      {
        eventId,
        inviter,
        lang: 'en',
        fallbackChatId: INVITER_ID,
        invitees: [
          { userId: 201, firstName: 'Alice' },
          { userId: 202, firstName: 'Bob' },
        ],
      },
      makeDeps(sender),
    );
    expect(result.statusLines).toHaveLength(2);
    // Two distinct fallback messages, each identifying its own invitee — so the inviter can't
    // forward Alice's link to Bob.
    const aliceMsg = sentToInviter.find((m) => m.includes('Alice'));
    const bobMsg = sentToInviter.find((m) => m.includes('Bob'));
    expect(aliceMsg).toBeDefined();
    expect(bobMsg).toBeDefined();
    expect(aliceMsg).not.toContain('Bob');
    expect(bobMsg).not.toContain('Alice');
  });

  test('fallback uses the picker display name even when the invitee has no DB row/username', async () => {
    const NO_ROW_ID = 9001; // never created in userRepo, no username — only a picker firstName
    const sentToInviter: string[] = [];
    const sender: TelegramSender = {
      ...SENDER_BASE,
      sendInvitation: async () => null,
      sendMessage: async (chatId, text) => {
        if (chatId === INVITER_ID) sentToInviter.push(text);
        return { message_id: 1 };
      },
    };
    const result = await deliverPickerInvitations(
      {
        eventId,
        inviter,
        lang: 'en',
        fallbackChatId: INVITER_ID,
        invitees: [{ userId: NO_ROW_ID, firstName: 'Zoe' }],
      },
      makeDeps(sender),
    );
    expect(result.statusLines).toHaveLength(1);
    const fallback = sentToInviter.find((m) => m.includes('Zoe'));
    expect(fallback).toBeDefined();
    // Must NOT fall through to the numeric id placeholder.
    expect(fallback).not.toContain(`#${NO_ROW_ID}`);
  });

  test('upserts each invitee as a contact', async () => {
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 1 }) };
    await deliverPickerInvitations(
      {
        eventId,
        inviter,
        lang: 'en',
        fallbackChatId: INVITER_ID,
        invitees: [{ userId: 201, firstName: 'Alice', username: 'alice_u' }],
      },
      makeDeps(sender),
    );
    const contact = contactRepo.findByTelegramId(INVITER_ID, 201);
    expect(contact).not.toBeNull();
    expect(contact!.name).toBe('Alice');
  });
});

describe('buildChatSharedResultText', () => {
  test('delivered → invite_delivered with the title HTML-escaped', () => {
    const text = buildChatSharedResultText('en', 'Party <b>X</b> & Co', { kind: 'delivered' });
    expect(text).toContain('Party &lt;b&gt;X&lt;/b&gt; &amp; Co');
    // The injected angle brackets must be escaped, not passed through as live markup.
    expect(text).not.toContain('<b>X</b>');
  });

  test('error → both the title and the error string are HTML-escaped', () => {
    const text = buildChatSharedResultText('en', 'Title <i>', { kind: 'error', error: 'bad <script>' });
    expect(text).toContain('Title &lt;i&gt;');
    expect(text).toContain('bad &lt;script&gt;');
    expect(text).not.toContain('<script>');
  });

  test('RU delivered uses the Russian string', () => {
    const text = buildChatSharedResultText('ru', 'Вечеринка', { kind: 'delivered' });
    expect(text).toContain('отправлено');
    expect(text).toContain('Вечеринка');
  });
});

describe('runPickerBatchWithAck (reply-fast ack)', () => {
  let db: Database;
  let userRepo: UserRepository;
  let contactRepo: ContactRepository;
  let invitationRepo: InvitationRepository;
  let eventRepo: EventRepository;
  let eventService: EventService;
  let invitationService: InvitationService;
  let deepLinkService: DeepLinkService;
  let inviter: User;
  let eventId: number;

  const SENDER_BASE: TelegramSender = {
    sendMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => {},
  };

  function makeDeps(sender: TelegramSender, extra: Partial<PickerInvitationDeps> = {}): PickerInvitationDeps {
    return {
      sender,
      invitationService,
      eventService,
      invitationRepo,
      userRepo,
      deepLinkService,
      botUsername: 'TestBot',
      contactRepo,
      ...extra,
    };
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
    invitationService = new InvitationService(invitationRepo, eventRepo, new SharingSettingsRepository(db));
    deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
    inviter = userRepo.create({ telegram_id: INVITER_ID, timezone: 'UTC', first_name: 'Alex' });
    userRepo.create({ telegram_id: 201, timezone: 'UTC', first_name: 'Alice' });
    userRepo.create({ telegram_id: 202, timezone: 'UTC', first_name: 'Bob' });
    const event = eventService.createEvent({
      user_id: INVITER_ID,
      title: 'Launch Party',
      start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
    });
    eventId = event.id;
  });

  test('acks immediately, then delivers, then edits the ack in place with the final status', async () => {
    const events: string[] = [];
    let editedText = '';
    const sender: TelegramSender = {
      ...SENDER_BASE,
      sendInvitation: async () => {
        events.push('deliver');
        return { message_id: 1 };
      },
    };
    const io: PickerAckIo = {
      sendAck: async (text) => {
        events.push(`sendAck:${text}`);
        return { message_id: 555 };
      },
      editAck: async (messageId, text) => {
        events.push(`editAck:${messageId}`);
        editedText = text;
      },
    };
    const result = await runPickerBatchWithAck(
      { eventId, inviter, lang: 'en', fallbackChatId: INVITER_ID, invitees: [{ userId: 201, firstName: 'Alice' }] },
      makeDeps(sender),
      io,
    );
    // Reply-fast: the "sending…" ack goes out BEFORE any delivery work, and the final status is
    // an EDIT of that same message AFTER delivery completes — never a second fresh message.
    expect(events).toEqual([`sendAck:${t('en').invite_picker_sending}`, 'deliver', 'editAck:555']);
    expect(editedText).toBe(`${t('en').invite_picker_header}\n✅ Alice`);
    expect(result.aiResultLines).toEqual(['Alice (id:201): delivered to the invitee']);
  });

  test('uses the Russian sending ack when lang is ru', async () => {
    const sentTexts: string[] = [];
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 1 }) };
    const io: PickerAckIo = {
      sendAck: async (text) => {
        sentTexts.push(text);
        return { message_id: 1 };
      },
      editAck: async () => {},
    };
    await runPickerBatchWithAck(
      { eventId, inviter, lang: 'ru', fallbackChatId: INVITER_ID, invitees: [{ userId: 201, firstName: 'Алиса' }] },
      makeDeps(sender),
      io,
    );
    expect(sentTexts[0]).toBe(t('ru').invite_picker_sending);
  });

  test('returns the AI result lines verbatim from the serial delivery (pickerAiLine preserved)', async () => {
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 1 }) };
    const io: PickerAckIo = { sendAck: async () => ({ message_id: 1 }), editAck: async () => {} };
    const result = await runPickerBatchWithAck(
      {
        eventId,
        inviter,
        lang: 'en',
        fallbackChatId: INVITER_ID,
        invitees: [
          { userId: 201, firstName: 'Alice' },
          { userId: 202, firstName: 'Bob' },
        ],
      },
      makeDeps(sender),
      io,
    );
    expect(result.aiResultLines).toEqual([
      'Alice (id:201): delivered to the invitee',
      'Bob (id:202): delivered to the invitee',
    ]);
  });

  test('edit failure (deleted message / 429) falls back to sending the final status as a new message', async () => {
    const sends: string[] = [];
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 1 }) };
    const io: PickerAckIo = {
      sendAck: async (text) => {
        sends.push(text);
        return { message_id: 555 };
      },
      editAck: async () => {
        throw new Error('message to edit not found');
      },
    };
    const result = await runPickerBatchWithAck(
      { eventId, inviter, lang: 'en', fallbackChatId: INVITER_ID, invitees: [{ userId: 201, firstName: 'Alice' }] },
      makeDeps(sender),
      io,
    );
    // The user must never be left staring at "sending…": when the edit fails, the final status is
    // sent as a fresh message instead.
    expect(sends).toEqual([t('en').invite_picker_sending, `${t('en').invite_picker_header}\n✅ Alice`]);
    expect(result.aiResultLines).toEqual(['Alice (id:201): delivered to the invitee']);
  });
});

describe('runChatShareWithAck (reply-fast group invite)', () => {
  let db: Database;
  let userRepo: UserRepository;
  let contactRepo: ContactRepository;
  let invitationRepo: InvitationRepository;
  let eventRepo: EventRepository;
  let eventService: EventService;
  let invitationService: InvitationService;
  let deepLinkService: DeepLinkService;
  let inviter: User;
  let eventId: number;

  const SENDER_BASE: TelegramSender = {
    sendMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => {},
  };

  function makeDeps(sender: TelegramSender, extra: Partial<PickerInvitationDeps> = {}): PickerInvitationDeps {
    return {
      sender,
      invitationService,
      eventService,
      invitationRepo,
      userRepo,
      deepLinkService,
      botUsername: 'TestBot',
      contactRepo,
      ...extra,
    };
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
    invitationService = new InvitationService(invitationRepo, eventRepo, new SharingSettingsRepository(db));
    deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
    inviter = userRepo.create({ telegram_id: INVITER_ID, timezone: 'UTC', first_name: 'Alex' });
    const event = eventService.createEvent({
      user_id: INVITER_ID,
      title: 'Launch Party',
      start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
    });
    eventId = event.id;
  });

  test('acks immediately, delivers, then edits with the localized group result', async () => {
    const events: string[] = [];
    let editedText = '';
    const sender: TelegramSender = {
      ...SENDER_BASE,
      sendInvitation: async () => {
        events.push('deliver');
        return { message_id: 42 };
      },
    };
    const io: PickerAckIo = {
      sendAck: async (text) => {
        events.push(`sendAck:${text}`);
        return { message_id: 7 };
      },
      editAck: async (messageId, text) => {
        events.push(`editAck:${messageId}`);
        editedText = text;
      },
    };
    const { outcome } = await runChatShareWithAck(
      {
        invitation: {
          eventId,
          inviter,
          inviteeId: GROUP_ID,
          fallbackChatId: INVITER_ID,
          allowMtproto: false,
          isGroupTarget: true,
        },
        lang: 'en',
        title: 'Launch Party',
      },
      makeDeps(sender),
      io,
    );
    expect(outcome).toEqual({ kind: 'delivered' });
    expect(events).toEqual([`sendAck:${t('en').invite_group_sending}`, 'deliver', 'editAck:7']);
    expect(editedText).toBe(t('en').invite_delivered('Launch Party'));
  });

  test('edit failure falls back to sending the final group result as a new message', async () => {
    const sends: string[] = [];
    const sender: TelegramSender = { ...SENDER_BASE, sendInvitation: async () => ({ message_id: 42 }) };
    const io: PickerAckIo = {
      sendAck: async (text) => {
        sends.push(text);
        return { message_id: 7 };
      },
      editAck: async () => {
        throw new Error('message to edit not found');
      },
    };
    const { outcome } = await runChatShareWithAck(
      {
        invitation: {
          eventId,
          inviter,
          inviteeId: GROUP_ID,
          fallbackChatId: INVITER_ID,
          allowMtproto: false,
          isGroupTarget: true,
        },
        lang: 'en',
        title: 'Launch Party',
      },
      makeDeps(sender),
      io,
    );
    expect(outcome).toEqual({ kind: 'delivered' });
    expect(sends).toEqual([t('en').invite_group_sending, t('en').invite_delivered('Launch Party')]);
  });
});
