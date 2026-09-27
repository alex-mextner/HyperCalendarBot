// test/services/location/native-venue-map.test.ts
// #399: the bot shows a confirmed event place as a native Telegram venue (the Map button on the event
// detail card and on the invitation, and once right after the creator picks a candidate), and a venue
// the user picks in Telegram's own place search is applied with its name and address, not
// reverse-geocoded. Real SQLite repositories, the real callback and message handlers, gramio contexts
// over a bot whose API calls are captured.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { Scene } from '@gramio/scenes';
import {
  Bot,
  CallbackQueryContext,
  MessageContext,
  type TelegramInlineKeyboardMarkup,
  type TelegramMessage,
  type TelegramReplyKeyboardMarkup,
} from 'gramio';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';
import { createMessageHandler, type MessageHandlerDeps } from '../../../src/bot/handlers/message.handler.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { createTelegramSender } from '../../../src/services/ai/telegram-sender.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { AddressCache } from '../../../src/services/location/address-cache.ts';
import type { GeocodedLocation, GeocodingService } from '../../../src/services/location/geocoding-service.ts';
import { InMemoryLocationCandidateStore } from '../../../src/services/location/location-candidate-store.ts';
import { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';
import { InMemoryPendingGeoStore } from '../../../src/services/location/pending-geo-store.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';

const OWNER_ID = 1001;
const INVITEE_ID = 2002;
const STRANGER_ID = 3003;
const GROUP_CHAT_ID = -4004;
const RAW_LOCATION = 'Kafana Sunce';
const MAP_BUTTON = t('ru').event_map_btn;

const BELGRADE_CAFE: GeocodedLocation = {
  formattedAddress: 'Dunavska 1, Белград, Сербия',
  latitude: 44.8231,
  longitude: 20.4632,
  city: 'Белград',
  country: 'Сербия',
  countryCode: 'RS',
  placeId: 'place-bg',
  googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=44.8231,20.4632&query_place_id=place-bg',
  venueName: 'Kafana Sunce',
};
const NIS_CAFE: GeocodedLocation = {
  formattedAddress: 'Obrenovićeva 1, Ниш, Сербия',
  latitude: 43.3209,
  longitude: 21.8958,
  city: 'Ниш',
  country: 'Сербия',
  countryCode: 'RS',
  placeId: 'place-nis',
  googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=43.3209,21.8958&query_place_id=place-nis',
  venueName: null,
};
/** What a reverse geocode of the venue's coordinates returns: a street address, no venue name. */
const STREET_AT_VENUE: GeocodedLocation = {
  ...BELGRADE_CAFE,
  formattedAddress: 'Kralja Petra 12, Белград, Сербия',
  placeId: 'street-bg',
  venueName: null,
};

/** A venue picked in Telegram's attach → Location → place search. */
const TELEGRAM_VENUE = {
  location: { latitude: 44.8176, longitude: 20.4569 },
  title: 'Supermarket Café',
  address: 'Višnjićeva 9, Beograd',
  google_place_id: 'ChIJ-venue',
};

type ReplyMarkup = TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;
type VenueCall = Parameters<Bot['api']['sendVenue']>[0];

interface OutgoingMessage {
  chatId: number | string;
  text: string;
  replyMarkup: ReplyMarkup | undefined;
}

function buttons(markup: unknown): { text: string; callback_data?: string }[] {
  if (!markup || typeof markup !== 'object') return [];
  const json = 'toJSON' in markup && typeof markup.toJSON === 'function' ? markup.toJSON() : markup;
  if (!json || typeof json !== 'object' || !('inline_keyboard' in json) || !Array.isArray(json.inline_keyboard)) {
    return [];
  }
  return json.inline_keyboard.flat();
}

function mapButtonData(markup: unknown): string | undefined {
  return buttons(markup).find((b) => b.text === MAP_BUTTON)?.callback_data;
}

function scriptedGeocoder(places: GeocodedLocation[]) {
  const reverseCalls: { lat: number; lng: number }[] = [];
  const service: GeocodingService = {
    findPlace: async () => places,
    geocodeAddress: async () => [],
    reverseGeocode: async (lat, lng) => {
      reverseCalls.push({ lat, lng });
      return STREET_AT_VENUE;
    },
    locateArea: async () => null,
  };
  return { service, reverseCalls };
}

function memoryRedis() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
  };
}

let db: Database;
afterEach(() => db.close());

function setup(places: GeocodedLocation[] = [BELGRADE_CAFE, NIS_CAFE]) {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  for (const id of [OWNER_ID, INVITEE_ID, STRANGER_ID]) {
    userRepo.create({ telegram_id: id, language: 'ru', timezone: 'Europe/Belgrade' });
  }
  const eventRepo = new EventRepository(db);
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const event = eventRepo.create({
    user_id: OWNER_ID,
    title: 'Встреча',
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
    timezone: 'Europe/Belgrade',
    location: RAW_LOCATION,
  });
  const invitationRepo = new InvitationRepository(db);
  const invitation = invitationRepo.create({
    event_id: event.id,
    inviter_id: OWNER_ID,
    invitee_id: INVITEE_ID,
    message_id: 77,
    chat_id: INVITEE_ID,
  });
  const geocoder = scriptedGeocoder(places);
  const candidateStore = new InMemoryLocationCandidateStore();
  const pickerMessages: OutgoingMessage[] = [];
  const invitationEdits: { chatId: number; text: string; replyMarkup: unknown }[] = [];
  const agendaRepository = new AgendaRepository(db);
  const service = new LocationVerificationService({
    geocodingService: geocoder.service,
    addressCache: new AddressCache(memoryRedis()),
    eventRepo,
    userRepo,
    invitationRepo,
    agendaRepository,
    candidateStore,
    sendMessage: async (userId, text, options) => {
      pickerMessages.push({ chatId: userId, text, replyMarkup: options?.reply_markup });
    },
    editMessage: async (chatId, _messageId, text, options) => {
      invitationEdits.push({ chatId, text, replyMarkup: options.reply_markup });
    },
  });
  const pendingGeoStore = new InMemoryPendingGeoStore();
  const eventService = new EventService({ eventRepo, agendaRepository });

  // Every Bot API call the handlers make is captured here
  const bot = new Bot('123:test');
  const venues: VenueCall[] = [];
  const sent: OutgoingMessage[] = [];
  const edits: { text: string; replyMarkup: unknown }[] = [];
  const answers: { text?: string }[] = [];
  const botMessage = (chatId: number | string): TelegramMessage => ({
    message_id: 900 + sent.length + venues.length,
    date: 0,
    chat: { id: Number(chatId), type: 'private' },
  });
  bot.api.answerCallbackQuery = async (params) => {
    answers.push({ text: params.text });
    return true;
  };
  bot.api.editMessageText = async (params) => {
    edits.push({ text: params.text.toString(), replyMarkup: params.reply_markup });
    return true;
  };
  bot.api.sendVenue = async (params) => {
    venues.push(params);
    return botMessage(params.chat_id);
  };
  bot.api.sendMessage = async (params) => {
    sent.push({
      chatId: params.chat_id,
      text: params.text.toString(),
      replyMarkup:
        buttons(params.reply_markup).length > 0 ? { inline_keyboard: [buttons(params.reply_markup)] } : undefined,
    });
    return botMessage(params.chat_id);
  };

  const dbUser = (id: number) => {
    const row = userRepo.findByTelegramId(id);
    if (!row) throw new Error(`test user ${id} missing`);
    return row;
  };
  const storedEvent = () => {
    const row = eventRepo.findById(event.id, OWNER_ID);
    if (!row) throw new Error('test event missing');
    return row;
  };

  /** Press an inline button through the real callback handler, as `from` in chat `chatId`. */
  async function tap(data: string, as: { from?: number; chatId?: number } = {}): Promise<void> {
    const from = as.from ?? OWNER_ID;
    const chatId = as.chatId ?? from;
    const user = dbUser(from);
    const ctx = Object.assign(
      new CallbackQueryContext({
        bot,
        update: { update_id: 1 },
        updateId: 1,
        payload: {
          id: 'callback',
          chat_instance: 'test',
          from: { id: from, is_bot: false, first_name: 'User' },
          data,
          message: { message_id: 10, date: 0, chat: { id: chatId, type: chatId < 0 ? 'group' : 'private' } },
        },
      }),
      { dbUser: user, userTimezone: user.timezone, lang: 'ru' as const, scene: { enter: async () => {} } },
    );
    const handler = createCallbackHandler(
      eventService,
      new Scene('unused'),
      new HolidayService(new HolidayRepository(db)),
      new NotificationPreferencesService(new NotificationPreferencesRepository(db)),
      { eventRepo, userRepo, invitationRepo, locationVerification: service, pendingGeoStore },
    );
    await handler(ctx);
  }

  /** The creator shares a pin or a Telegram venue in the private chat, through the real message handler. */
  async function share(content: { location: { latitude: number; longitude: number }; venue?: typeof TELEGRAM_VENUE }) {
    const user = dbUser(OWNER_ID);
    const ctx = Object.assign(
      new MessageContext({
        bot,
        update: { update_id: 2 },
        updateId: 2,
        payload: {
          message_id: 20,
          date: 0,
          chat: { id: OWNER_ID, type: 'private' },
          from: { id: OWNER_ID, is_bot: false, first_name: 'Owner' },
          ...content,
        },
      }),
      { dbUser: user, userTimezone: user.timezone, lang: 'ru' as const, scene: { enter: async () => {} } },
    );
    const handler = createMessageHandler(
      messageHandlerDeps({ eventService, locationVerification: service, pendingGeoStore }),
    );
    await handler(messageContext(ctx));
  }

  return {
    event,
    invitation,
    eventRepo,
    storedEvent,
    service,
    geocoder,
    pendingGeoStore,
    pickerMessages,
    invitationEdits,
    venues,
    sent,
    edits,
    answers,
    tap,
    share,
    owner: () => dbUser(OWNER_ID),
    /** The creator confirms `choice` in the picker the bot sends for the event's typed text. */
    async confirmCandidate(choice: number) {
      await service.verifyEventLocation(event, dbUser(OWNER_ID));
      const data = buttons(pickerMessages.at(-1)?.replyMarkup).find((b) => b.callback_data?.endsWith(`:${choice}`));
      if (!data?.callback_data) throw new Error(`no candidate ${choice}`);
      await tap(data.callback_data);
    },
  };
}

/** Only the location branch of the message handler runs; it reads nothing else from its deps. */
function messageHandlerDeps(deps: Partial<MessageHandlerDeps>): MessageHandlerDeps {
  return { sceneStorage: { get: async () => null }, ...deps } as unknown as MessageHandlerDeps;
}

/** A gramio message context with the derived user props; the scene plugin is not needed here. */
function messageContext(ctx: MessageContext<Bot>): BotCommandContext {
  return ctx as unknown as BotCommandContext;
}

describe('Map button on the event detail card', () => {
  test('an event with a confirmed place gets a Map button; pressing it sends the venue with name, address and coordinates', async () => {
    const s = setup();
    await s.confirmCandidate(0);
    s.venues.length = 0;

    await s.tap(`ev:${s.event.id}`);

    const card = s.edits.at(-1);
    const data = mapButtonData(card?.replyMarkup);
    expect(data).toBe(`ev_map:${s.event.id}`);

    await s.tap(data ?? '');

    expect(s.venues).toEqual([
      {
        chat_id: OWNER_ID,
        latitude: BELGRADE_CAFE.latitude,
        longitude: BELGRADE_CAFE.longitude,
        title: 'Kafana Sunce',
        address: BELGRADE_CAFE.formattedAddress,
      },
    ]);
  });

  test('an event whose place is not confirmed has no Map button', async () => {
    const s = setup();

    await s.tap(`ev:${s.event.id}`);

    expect(s.edits).toHaveLength(1);
    expect(mapButtonData(s.edits[0]?.replyMarkup)).toBeUndefined();
  });

  test('pressing Map on an event the user cannot see sends nothing', async () => {
    const s = setup();
    await s.confirmCandidate(0);
    s.venues.length = 0;

    await s.tap(`ev_map:${s.event.id}`, { from: STRANGER_ID });

    expect(s.venues).toEqual([]);
    expect(s.answers.at(-1)?.text).toBe(t('ru').callbackErrors.notFound);
  });

  test('pressing Map after the place was dropped sends nothing', async () => {
    const s = setup();
    await s.confirmCandidate(0);
    s.eventRepo.clearLocationFields(s.event.id);
    s.venues.length = 0;

    await s.tap(`ev_map:${s.event.id}`);

    expect(s.venues).toEqual([]);
  });
});

describe('Map button on the invitation', () => {
  test('confirming the place re-renders the invitation with a Map button the invitee can press', async () => {
    const s = setup();

    await s.confirmCandidate(1);

    expect(s.invitationEdits).toHaveLength(1);
    const data = mapButtonData(s.invitationEdits[0]?.replyMarkup);
    expect(data).toBe(`ev_map:${s.event.id}`);
    // The RSVP buttons stay next to it
    expect(buttons(s.invitationEdits[0]?.replyMarkup).map((b) => b.callback_data)).toContain(
      `inv:accept:${s.invitation.id}`,
    );

    s.venues.length = 0;
    await s.tap(data ?? '', { from: INVITEE_ID });

    // A place without a venue name is titled with the event's typed text
    expect(s.venues).toEqual([
      {
        chat_id: INVITEE_ID,
        latitude: NIS_CAFE.latitude,
        longitude: NIS_CAFE.longitude,
        title: RAW_LOCATION,
        address: NIS_CAFE.formattedAddress,
      },
    ]);
  });

  test('an invitation delivered for an event with a confirmed place carries the Map button', async () => {
    const s = setup();
    await s.confirmCandidate(0);
    const bot = new Bot('123:test');
    const markups: unknown[] = [];
    bot.api.sendMessage = async (params) => {
      markups.push(params.reply_markup);
      return { message_id: 1, date: 0, chat: { id: Number(params.chat_id), type: 'private' } };
    };
    const sender = createTelegramSender(bot);

    await sender.sendInvitation?.(INVITEE_ID, 'invite', s.invitation.id, 'ru', {
      kind: 'personal',
      place: s.storedEvent(),
    });
    await sender.sendInvitation?.(GROUP_CHAT_ID, 'invite', s.invitation.id, 'ru', {
      kind: 'group',
      eventId: s.event.id,
      place: s.storedEvent(),
    });

    expect(markups.map(mapButtonData)).toEqual([`ev_map:${s.event.id}`, `ev_map:${s.event.id}`]);
  });

  test('a group member presses Map on the group invitation and the venue goes to the group', async () => {
    const s = setup();
    await s.confirmCandidate(0);
    new InvitationRepository(db).create({
      event_id: s.event.id,
      inviter_id: OWNER_ID,
      invitee_id: GROUP_CHAT_ID,
      message_id: 88,
      chat_id: GROUP_CHAT_ID,
    });
    s.venues.length = 0;

    await s.tap(`ev_map:${s.event.id}`, { from: STRANGER_ID, chatId: GROUP_CHAT_ID });

    expect(s.venues.map((v) => v.chat_id)).toEqual([GROUP_CHAT_ID]);
  });

  test('a declined-then-cancelled invitee can no longer press Map', async () => {
    const s = setup();
    await s.confirmCandidate(0);
    new InvitationRepository(db).cancelForEvent(s.event.id);
    s.venues.length = 0;

    await s.tap(`ev_map:${s.event.id}`, { from: INVITEE_ID });

    expect(s.venues).toEqual([]);
  });
});

describe('the picker shows the chosen place on the map once', () => {
  test('tapping a candidate sends exactly one venue for the chosen place', async () => {
    const s = setup();

    await s.confirmCandidate(0);

    expect(s.venues).toEqual([
      {
        chat_id: OWNER_ID,
        latitude: BELGRADE_CAFE.latitude,
        longitude: BELGRADE_CAFE.longitude,
        title: 'Kafana Sunce',
        address: BELGRADE_CAFE.formattedAddress,
      },
    ]);
    // The picker itself keeps its map links and sends no venue per candidate
    expect(s.pickerMessages).toHaveLength(1);
    expect(s.pickerMessages[0]?.text).toContain(BELGRADE_CAFE.googleMapsUrl.replaceAll('&', '&amp;'));
  });

  test('a tap on an older picker sends no venue', async () => {
    const s = setup();
    await s.service.verifyEventLocation(s.event, s.owner());
    const older = buttons(s.pickerMessages[0]?.replyMarkup)[0]?.callback_data ?? '';
    // Asking again closes the first picker
    await s.service.verifyEventLocation(s.event, s.owner());

    await s.tap(older);

    expect(s.storedEvent().location_verified).toBe(0);
    expect(s.venues).toEqual([]);
  });
});

describe('a venue picked in Telegram is the place the user chose', () => {
  test('it is offered for the recent event and applied with its name and address, without a reverse geocode', async () => {
    const s = setup();

    await s.share({ location: TELEGRAM_VENUE.location, venue: TELEGRAM_VENUE });

    expect(buttons(s.sent.at(-1)?.replyMarkup).map((b) => b.callback_data)).toContain(`loc_geo:geo:${s.event.id}`);

    await s.tap(`loc_geo:geo:${s.event.id}`);

    const stored = s.storedEvent();
    expect(stored.location).toBe(RAW_LOCATION);
    expect(stored.location_verified).toBe(1);
    expect(stored.venue_name).toBe(TELEGRAM_VENUE.title);
    expect(stored.resolved_address).toBe(TELEGRAM_VENUE.address);
    expect(stored.latitude).toBe(TELEGRAM_VENUE.location.latitude);
    expect(stored.longitude).toBe(TELEGRAM_VENUE.location.longitude);
    expect(stored.google_maps_url).toBe(
      'https://www.google.com/maps/search/?api=1&query=44.8176,20.4569&query_place_id=ChIJ-venue',
    );
    expect(s.geocoder.reverseCalls).toEqual([]);
    // The confirmation and the invitation name the venue
    expect(s.edits.at(-1)?.text).toContain(TELEGRAM_VENUE.title);
    expect(s.invitationEdits.at(-1)?.text).toContain(TELEGRAM_VENUE.title);
    // The user just picked it on Telegram's map: no venue is echoed back
    expect(s.venues).toEqual([]);
  });

  test('the Map button then sends the picked venue back as it was chosen', async () => {
    const s = setup();
    await s.share({ location: TELEGRAM_VENUE.location, venue: TELEGRAM_VENUE });
    await s.tap(`loc_geo:geo:${s.event.id}`);

    await s.tap(`ev_map:${s.event.id}`);

    expect(s.venues).toEqual([
      {
        chat_id: OWNER_ID,
        latitude: TELEGRAM_VENUE.location.latitude,
        longitude: TELEGRAM_VENUE.location.longitude,
        title: TELEGRAM_VENUE.title,
        address: TELEGRAM_VENUE.address,
      },
    ]);
  });
});

describe('a plain pin keeps its behaviour', () => {
  test('it is offered for the recent event and resolved by a reverse geocode', async () => {
    const s = setup();

    await s.share({ location: { latitude: 44.8231, longitude: 20.4632 } });

    expect(buttons(s.sent.at(-1)?.replyMarkup).map((b) => b.callback_data)).toEqual([
      `loc_geo:geo:${s.event.id}`,
      'loc_geo:city:44.8231:20.4632',
      'loc_geo:other:44.8231:20.4632',
    ]);

    await s.tap(`loc_geo:geo:${s.event.id}`);

    expect(s.geocoder.reverseCalls).toEqual([{ lat: 44.8231, lng: 20.4632 }]);
    expect(s.storedEvent().resolved_address).toBe(STREET_AT_VENUE.formattedAddress);
    expect(s.storedEvent().venue_name).toBeNull();
  });

  test('without a recent unconfirmed event it offers a timezone update', async () => {
    const s = setup();
    await s.confirmCandidate(0);

    await s.share({ location: { latitude: 55.7558, longitude: 37.6173 } });

    expect(buttons(s.sent.at(-1)?.replyMarkup).map((b) => b.callback_data)).toContain('gtzc:Europe/Moscow');
  });
});
