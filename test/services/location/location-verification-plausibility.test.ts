// test/services/location/location-verification-plausibility.test.ts
// Regression for the 2026-09-27 incident: an unconfirmed far-away geocode was shown to invitees as a
// verified address and poisoned the user's home city and address cache. The bot now always asks: no
// geocode is applied, cached or taught as the home city until the creator taps a candidate. Real
// SQLite repositories, real address cache over an in-memory Redis, a scripted geocoder and the real
// callback handler for the taps.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Scene } from '@gramio/scenes';
import { Bot, CallbackQueryContext, type TelegramInlineKeyboardMarkup, type TelegramReplyKeyboardMarkup } from 'gramio';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { AddressCache } from '../../../src/services/location/address-cache.ts';
import { buildAddressContext } from '../../../src/services/location/address-context.ts';
import type {
  GeoBounds,
  GeocodedArea,
  GeocodedLocation,
  GeocodingBias,
  GeocodingService,
} from '../../../src/services/location/geocoding-service.ts';
import { InMemoryLocationCandidateStore } from '../../../src/services/location/location-candidate-store.ts';
import {
  type LocationVerificationDeps,
  LocationVerificationService,
} from '../../../src/services/location/location-verification-service.ts';
import { InMemoryPendingGeoStore } from '../../../src/services/location/pending-geo-store.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';
import { invitationRsvpKeyboard } from '../../../src/services/sharing/invitation-rsvp-keyboard.ts';
import { escapeHtml } from '../../../src/utils/telegram.ts';

const USER_ID = 1001;
const INVITEE_ID = 2002;
const RAW_LOCATION = 'Kafana Sunce';
// The event's text after the creator edits the location.
const EDITED_LOCATION = 'У Иры дома';
const KEEP_AS_TYPED = t('ru').aiTools.location.noneOfThese;

const SERBIA_BOUNDS: GeoBounds = { south: 42.23, west: 18.82, north: 46.19, east: 23.01 };
const SERBIA: GeocodedArea = { latitude: 44.02, longitude: 21.01, countryCode: 'RS', bounds: SERBIA_BOUNDS };
const BELGRADE: GeocodedArea = {
  latitude: 44.8125,
  longitude: 20.4612,
  countryCode: 'RS',
  bounds: { south: 44.68, west: 20.2, north: 44.94, east: 20.62 },
};
const COASTAL_VILLAGE_NL: GeocodedArea = {
  latitude: 51.58,
  longitude: 3.62,
  countryCode: 'NL',
  bounds: { south: 51.57, west: 3.6, north: 51.6, east: 3.64 },
};
// Montenegro shares the Europe/Belgrade timezone zone with Serbia.
const BUDVA_ME: GeocodedArea = {
  latitude: 42.2864,
  longitude: 18.84,
  countryCode: 'ME',
  bounds: { south: 42.26, west: 18.8, north: 42.31, east: 18.9 },
};

function place(overrides: Partial<GeocodedLocation>): GeocodedLocation {
  return {
    formattedAddress: 'Somewhere',
    latitude: 0,
    longitude: 0,
    city: null,
    country: null,
    countryCode: null,
    placeId: null,
    googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=0,0',
    venueName: null,
    ...overrides,
  };
}

const DUTCH_HOTEL = place({
  formattedAddress: 'Strandweg 1, 4354 AA Zeedorp, Нидерланды',
  latitude: 51.586,
  longitude: 3.621,
  city: 'Zeedorp',
  country: 'Нидерланды',
  countryCode: 'NL',
  placeId: 'place-nl',
  googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=51.586,3.621&query_place_id=place-nl',
  venueName: 'Strand & Hotel',
});
const BELGRADE_CAFE = place({
  formattedAddress: 'Dunavska 1, Белград, Сербия',
  latitude: 44.8231,
  longitude: 20.4632,
  city: 'Белград',
  country: 'Сербия',
  countryCode: 'RS',
  placeId: 'place-bg',
  venueName: 'Kafana Sunce',
  googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=44.8231,20.4632&query_place_id=place-bg',
});
const NIS_CAFE = place({
  formattedAddress: 'Obrenovićeva 1, Ниш, Сербия',
  latitude: 43.3209,
  longitude: 21.8958,
  city: 'Ниш',
  country: 'Сербия',
  countryCode: 'RS',
  placeId: 'place-nis',
  googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=43.3209,21.8958&query_place_id=place-nis',
});
// HTML-significant characters in both the venue and the address.
const TRICKY_CAFE = place({
  formattedAddress: 'Cara Dušana 1 <dvorište & ulaz>, Белград, Сербия',
  latitude: 44.8235,
  longitude: 20.4641,
  city: 'Белград',
  countryCode: 'RS',
  placeId: 'place-tricky',
  venueName: 'Bar & Grill <Dorćol>',
  googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=44.8235,20.4641&query_place_id=place-tricky',
});

interface GeocoderCall {
  query: string;
  bias: GeocodingBias | undefined;
}

function scriptedGeocoder(script: {
  places: GeocodedLocation[];
  areas?: { [cityAndCountry: string]: GeocodedArea };
  reverse?: GeocodedLocation;
}) {
  const searches: GeocoderCall[] = [];
  const service: GeocodingService = {
    findPlace: async (query, bias) => {
      searches.push({ query, bias });
      return script.places;
    },
    geocodeAddress: async (query, bias) => {
      searches.push({ query, bias });
      return [];
    },
    reverseGeocode: async () => script.reverse ?? null,
    locateArea: async ({ city, countryCode }) => script.areas?.[`${city ?? ''}|${countryCode ?? ''}`] ?? null,
  };
  return { service, searches };
}

interface SentMessage {
  userId: number;
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup | undefined;
}

function callbackData(message: SentMessage | undefined): string[] {
  const markup = message?.replyMarkup;
  if (!markup || !('inline_keyboard' in markup)) return [];
  return markup.inline_keyboard.flat().flatMap((button) => (button.callback_data ? [button.callback_data] : []));
}

/** The `index|keep` choices of a picker message, after checking every button answers the same picker of the event. */
function pickerChoices(message: SentMessage | undefined, eventId: number): string[] {
  const data = callbackData(message);
  for (const d of data) expect(d).toMatch(new RegExp(`^loc_cand:${eventId}:[0-9a-f]{8}:[^:]+$`));
  expect(new Set(data.map((d) => d.split(':')[2])).size).toBe(1);
  return data.map((d) => d.split(':')[3] ?? '');
}

/** The callback data of a picker button (`0`, `1`, … or `keep`). */
function button(message: SentMessage | undefined, choice: string): string {
  const data = callbackData(message).find((d) => d.endsWith(`:${choice}`));
  if (!data) throw new Error(`no ${choice} button`);
  return data;
}

function buttonLabels(message: SentMessage | undefined): string[] {
  const markup = message?.replyMarkup;
  if (!markup || !('inline_keyboard' in markup)) return [];
  return markup.inline_keyboard.map((row) => row.map((button) => button.text).join(' | '));
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

interface EditedMessage {
  text: string;
  parseMode: string | undefined;
  replyMarkup: unknown;
}

/** An edit of a delivered invitation card, with the keyboard it leaves on the card. */
interface InvitationCardEdit {
  chatId: number;
  messageId: number;
  text: string;
  options: Parameters<NonNullable<LocationVerificationDeps['editMessage']>>[3];
}

let db: Database;
afterEach(() => db.close());

function setup(
  profile: { timezone: string; city?: string; countryCode?: string; title?: string },
  geocodingService: GeocodingService,
) {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  userRepo.create({
    telegram_id: USER_ID,
    language: 'ru',
    timezone: profile.timezone,
    ...(profile.countryCode ? { country_code: profile.countryCode } : {}),
  });
  userRepo.create({ telegram_id: INVITEE_ID, language: 'ru', timezone: 'Europe/Belgrade' });
  if (profile.city) userRepo.update(USER_ID, { city: profile.city });
  const eventRepo = new EventRepository(db);
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const event = eventRepo.create({
    user_id: USER_ID,
    title: profile.title ?? 'Встреча',
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
    timezone: 'Europe/Belgrade',
    location: RAW_LOCATION,
  });
  // A delivered invitation: its card is edited whenever the event's place changes.
  const invitationRepo = new InvitationRepository(db);
  const invitation = invitationRepo.create({
    event_id: event.id,
    inviter_id: USER_ID,
    invitee_id: INVITEE_ID,
    message_id: 77,
    chat_id: INVITEE_ID,
  });
  const addressRedis = memoryRedis();
  const addressCache = new AddressCache(addressRedis);
  const candidateStore = new InMemoryLocationCandidateStore();
  const sent: SentMessage[] = [];
  const invitationEdits: InvitationCardEdit[] = [];
  const service = new LocationVerificationService({
    geocodingService,
    addressCache,
    eventRepo,
    userRepo,
    invitationRepo,
    agendaRepository: new AgendaRepository(db),
    candidateStore,
    sendMessage: async (userId, text, options) => {
      sent.push({ userId, text, replyMarkup: options?.reply_markup });
    },
    editMessage: async (chatId, messageId, text, options) => {
      invitationEdits.push({ chatId, messageId, text, options });
    },
  });
  const pendingGeoStore = new InMemoryPendingGeoStore();
  const user = () => {
    const row = userRepo.findByTelegramId(USER_ID);
    if (!row) throw new Error('test user missing');
    return row;
  };
  const storedEvent = () => {
    const row = eventRepo.findById(event.id, USER_ID);
    if (!row) throw new Error('test event missing');
    return row;
  };

  /** Press an inline button as the creator, through the real callback handler. */
  async function tap(data: string): Promise<EditedMessage[]> {
    const bot = new Bot('123:test');
    const edits: EditedMessage[] = [];
    bot.api.answerCallbackQuery = async () => true;
    bot.api.editMessageText = async (params) => {
      edits.push({ text: params.text.toString(), parseMode: params.parse_mode, replyMarkup: params.reply_markup });
      return true;
    };
    const dbUser = user();
    const ctx = Object.assign(
      new CallbackQueryContext({
        bot,
        update: { update_id: 1 },
        updateId: 1,
        payload: {
          id: 'callback',
          chat_instance: 'test',
          from: { id: USER_ID, is_bot: false, first_name: 'Owner' },
          data,
          message: { message_id: 10, date: 0, chat: { id: USER_ID, type: 'private' } },
        },
      }),
      { dbUser, userTimezone: dbUser.timezone, lang: 'ru' as const, scene: { enter: async () => {} } },
    );
    const handler = createCallbackHandler(
      new EventService({ eventRepo, agendaRepository: new AgendaRepository(db) }),
      new Scene('unused'),
      new HolidayService(new HolidayRepository(db)),
      new NotificationPreferencesService(new NotificationPreferencesRepository(db)),
      { eventRepo, userRepo, locationVerification: service, pendingGeoStore },
    );
    await handler(ctx);
    return edits;
  }

  /** Nothing about the typed place was applied, remembered or learned. */
  async function expectNothingWritten() {
    const stored = storedEvent();
    expect(stored.location).toBe(RAW_LOCATION);
    expect(stored.location_verified).toBe(0);
    expect(stored.resolved_address).toBeNull();
    expect(stored.venue_name).toBeNull();
    expect(stored.google_maps_url).toBeNull();
    expect(stored.latitude).toBeNull();
    expect(stored.longitude).toBeNull();
    expect(invitationEdits).toEqual([]);
    expect(await addressCache.findMapping(USER_ID, RAW_LOCATION)).toBeNull();
    expect(await addressCache.getRecent(USER_ID)).toEqual([]);
  }

  /** The creator confirmed `geo` earlier, by answering a picker that offered it. */
  async function confirmEarlier(geo: GeocodedLocation) {
    await candidateStore.set(event.id, {
      id: 'e0e0e0e0',
      location: RAW_LOCATION,
      candidates: [geo],
      remembered: false,
    });
    expect(await service.handleLocationChoice(event.id, USER_ID, 'e0e0e0e0', 0)).toBe(true);
  }

  return {
    service,
    event,
    eventRepo,
    user,
    storedEvent,
    addressRedis,
    addressCache,
    candidateStore,
    pendingGeoStore,
    sent,
    invitation,
    invitationEdits,
    tap,
    expectNothingWritten,
    confirmEarlier,
  };
}

describe('no geocode is applied before the creator taps a candidate', () => {
  test('a single plausible result in the home city is offered as a candidate, and nothing is written', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(false);
    await s.expectNothingWritten();
    expect(s.user().city).toBeNull();

    expect(s.sent).toHaveLength(1);
    const ask = s.sent[0]!;
    expect(ask.userId).toBe(USER_ID);
    expect(ask.text).toContain(
      `<a href="${escapeHtml(BELGRADE_CAFE.googleMapsUrl)}">Kafana Sunce — ${escapeHtml(BELGRADE_CAFE.formattedAddress)}</a>`,
    );
    expect(buttonLabels(ask)).toEqual(['1. Kafana Sunce', KEEP_AS_TYPED]);
    expect(pickerChoices(ask, s.event.id)).toEqual(['0', 'keep']);
    expect((await s.candidateStore.get(s.event.id))?.candidates).toEqual([BELGRADE_CAFE]);
  });

  test('the incident: a far-away single result is offered, not applied, and the search was biased home', async () => {
    const geocoder = scriptedGeocoder({ places: [DUTCH_HOTEL], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(false);
    // Biased toward the timezone country, not left to the server's IP location.
    expect(geocoder.searches[0]?.bias).toEqual({ countryCode: 'RS', bounds: SERBIA_BOUNDS });
    await s.expectNothingWritten();
    expect(s.user().city).toBeNull();
    expect(s.sent[0]!.text).toContain(`<a href="${escapeHtml(DUTCH_HOTEL.googleMapsUrl)}">`);
    expect(buttonLabels(s.sent[0])).toEqual([`1. ${DUTCH_HOTEL.venueName}`, KEEP_AS_TYPED]);
  });

  test('a remembered place is offered as the candidate, not applied, without a new search', async () => {
    const geocoder = scriptedGeocoder({ places: [NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.addressCache.recordMapping(USER_ID, RAW_LOCATION, {
      resolvedAddress: BELGRADE_CAFE.formattedAddress,
      googleMapsUrl: BELGRADE_CAFE.googleMapsUrl,
      latitude: BELGRADE_CAFE.latitude,
      longitude: BELGRADE_CAFE.longitude,
      placeId: BELGRADE_CAFE.placeId,
      venueName: BELGRADE_CAFE.venueName,
    });

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(false);
    expect(geocoder.searches).toEqual([]);
    const stored = s.storedEvent();
    expect(stored.location_verified).toBe(0);
    expect(stored.resolved_address).toBeNull();
    expect(s.invitationEdits).toEqual([]);
    expect(s.sent[0]!.text).toContain(`<a href="${escapeHtml(BELGRADE_CAFE.googleMapsUrl)}">`);
    expect(buttonLabels(s.sent[0])).toEqual(['1. Kafana Sunce', KEEP_AS_TYPED]);
    expect((await s.candidateStore.get(s.event.id))?.candidates.map((c) => c.formattedAddress)).toEqual([
      BELGRADE_CAFE.formattedAddress,
    ]);
  });

  test('several results: every candidate gets a map link and a button named after the place, plus keep as typed', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE, NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    await s.service.verifyEventLocation(s.event, s.user());

    await s.expectNothingWritten();
    const ask = s.sent[0]!;
    for (const candidate of [BELGRADE_CAFE, NIS_CAFE]) {
      expect(ask.text).toContain(`<a href="${escapeHtml(candidate.googleMapsUrl)}">`);
    }
    expect(buttonLabels(ask)).toEqual(['1. Kafana Sunce', `2. ${NIS_CAFE.formattedAddress}`, KEEP_AS_TYPED]);
    expect(pickerChoices(ask, s.event.id)).toEqual(['0', '1', 'keep']);
  });

  test('no result tells the creator to send a pin or the full address, and nothing is written', async () => {
    const geocoder = scriptedGeocoder({ places: [], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(false);
    await s.expectNothingWritten();
    expect(s.sent.map((m) => m.text)).toEqual([t('ru').aiTools.location.locationNotFound('Встреча')]);
    expect(await s.candidateStore.get(s.event.id)).toBeNull();
  });

  test('a new verification drops a place confirmed for the earlier text, without editing invitations', async () => {
    const geocoder = scriptedGeocoder({ places: [NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.confirmEarlier(BELGRADE_CAFE);
    const editsAfterConfirmation = s.invitationEdits.length;

    await s.service.verifyEventLocation(s.storedEvent(), s.user());

    const stored = s.storedEvent();
    expect(stored.location_verified).toBe(0);
    expect(stored.resolved_address).toBeNull();
    expect(stored.venue_name).toBeNull();
    expect(stored.google_maps_url).toBeNull();
    expect(s.invitationEdits).toHaveLength(editsAfterConfirmation);
  });

  test('a verification by a user who cannot see the event keeps its place and neither searches nor asks', async () => {
    const geocoder = scriptedGeocoder({ places: [NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.confirmEarlier(BELGRADE_CAFE);
    // A secretary updating the owner's event: the event is the owner's, the acting user is not
    const secretary = { ...s.user(), telegram_id: INVITEE_ID };

    await s.service.verifyEventLocation(s.storedEvent(), secretary);

    const stored = s.storedEvent();
    expect(stored.location_verified).toBe(1);
    expect(stored.resolved_address).toBe(BELGRADE_CAFE.formattedAddress);
    expect(geocoder.searches).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  test('a new verification closes the previous picker, even when it finds nothing', async () => {
    const script = { places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } };
    const s = setup({ timezone: 'Europe/Belgrade' }, scriptedGeocoder(script).service);
    await s.service.verifyEventLocation(s.event, s.user());
    script.places = [];
    await s.service.verifyEventLocation(s.event, s.user());

    const edits = await s.tap(button(s.sent[0], '0'));

    await s.expectNothingWritten();
    expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);
  });

  test('a slow search for an earlier text never replaces the picker of the newer text', async () => {
    let releaseOldSearch = () => {};
    const oldSearchReleased = new Promise<void>((resolve) => {
      releaseOldSearch = resolve;
    });
    const geocoder: GeocodingService = {
      findPlace: async (query) => {
        if (query !== RAW_LOCATION) return [BELGRADE_CAFE];
        await oldSearchReleased;
        return [DUTCH_HOTEL];
      },
      geocodeAddress: async () => [],
      reverseGeocode: async () => null,
      locateArea: async () => SERBIA,
    };
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder);
    const oldVerification = s.service.verifyEventLocation(s.event, s.user());
    s.eventRepo.update(s.event.id, USER_ID, { location: EDITED_LOCATION });
    await s.service.verifyEventLocation(s.storedEvent(), s.user());

    releaseOldSearch();
    await oldVerification;
    await s.tap(button(s.sent[0], '0'));

    // Only the current text was asked about, and its answer applies to it
    expect(s.sent).toHaveLength(1);
    expect(s.storedEvent().location).toBe(EDITED_LOCATION);
    expect(s.storedEvent().resolved_address).toBe(BELGRADE_CAFE.formattedAddress);
    expect((await s.addressCache.findMapping(USER_ID, EDITED_LOCATION))?.resolvedAddress).toBe(
      BELGRADE_CAFE.formattedAddress,
    );
  });

  test('a pin shared while the search runs answers the question: no picker follows it', async () => {
    let releaseSearch = () => {};
    const searchReleased = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const geocoder: GeocodingService = {
      findPlace: async () => {
        await searchReleased;
        return [DUTCH_HOTEL];
      },
      geocodeAddress: async () => [],
      reverseGeocode: async () => BELGRADE_CAFE,
      locateArea: async () => SERBIA,
    };
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder);
    const verification = s.service.verifyEventLocation(s.event, s.user());
    await s.pendingGeoStore.set(USER_ID, { latitude: BELGRADE_CAFE.latitude, longitude: BELGRADE_CAFE.longitude });
    await s.tap(`loc_geo:geo:${s.event.id}`);

    releaseSearch();
    await verification;

    // A picker sent now would let a keep tap erase the pinned place
    expect(s.sent).toEqual([]);
    expect(s.storedEvent().location_verified).toBe(1);
    expect(s.storedEvent().resolved_address).toBe(BELGRADE_CAFE.formattedAddress);
  });

  test('a place remembered before the bot required a confirmation is not offered; a fresh search is', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE, NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    // What the bot stored in production when it applied the incident's geocode on its own
    const autoResolved = {
      input: RAW_LOCATION,
      resolvedAddress: DUTCH_HOTEL.formattedAddress,
      googleMapsUrl: DUTCH_HOTEL.googleMapsUrl,
      latitude: DUTCH_HOTEL.latitude,
      longitude: DUTCH_HOTEL.longitude,
      placeId: DUTCH_HOTEL.placeId,
      venueName: DUTCH_HOTEL.venueName,
      timestamp: Date.now(),
    };
    await s.addressRedis.set(`addr:${USER_ID}:mappings`, JSON.stringify([autoResolved]));
    await s.addressRedis.set(
      `addr:${USER_ID}:freq`,
      JSON.stringify({ [DUTCH_HOTEL.formattedAddress]: { url: DUTCH_HOTEL.googleMapsUrl, count: 3, lastUsed: 1 } }),
    );

    await s.service.verifyEventLocation(s.event, s.user());

    expect(geocoder.searches.map((search) => search.query)).toEqual([RAW_LOCATION]);
    expect(buttonLabels(s.sent[0])).toEqual(['1. Kafana Sunce', `2. ${NIS_CAFE.formattedAddress}`, KEEP_AS_TYPED]);
    expect(s.sent[0]!.text).not.toContain(escapeHtml(DUTCH_HOTEL.formattedAddress));
    // Nor is it suggested to the assistant as a known place
    expect(await buildAddressContext(s.addressCache, USER_ID)).toBe('');
  });
});

describe('searches are biased to the creator home area', () => {
  test('a confirmed home city anchors the search to its viewport', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { 'Белград|RS': BELGRADE } });
    const s = setup({ timezone: 'Europe/Belgrade', city: 'Белград' }, geocoder.service);

    await s.service.verifyEventLocation(s.event, s.user());

    expect(geocoder.searches[0]?.bias).toEqual({ countryCode: 'RS', bounds: BELGRADE.bounds });
    await s.expectNothingWritten();
  });

  test('without a city, the profile country wins over the timezone country', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Amsterdam', countryCode: 'RS' }, geocoder.service);

    await s.service.verifyEventLocation(s.event, s.user());

    expect(geocoder.searches[0]?.bias).toEqual({ countryCode: 'RS', bounds: SERBIA_BOUNDS });
  });

  test('a city learned from a wrong guess outside the user region does not anchor the search', async () => {
    const geocoder = scriptedGeocoder({
      places: [DUTCH_HOTEL],
      areas: { 'Zeedorp|RS': COASTAL_VILLAGE_NL, '|RS': SERBIA },
    });
    const s = setup({ timezone: 'Europe/Belgrade', city: 'Zeedorp' }, geocoder.service);

    await s.service.verifyEventLocation(s.event, s.user());

    expect(geocoder.searches[0]?.bias).toEqual({ countryCode: 'RS', bounds: SERBIA_BOUNDS });
  });

  test('a home city across the border but inside the user timezone anchors the search', async () => {
    const geocoder = scriptedGeocoder({ places: [], areas: { 'Будва|RS': BUDVA_ME } });
    const s = setup({ timezone: 'Europe/Belgrade', city: 'Будва' }, geocoder.service);

    await s.service.verifyEventLocation(s.event, s.user());

    expect(geocoder.searches[0]?.bias).toEqual({ countryCode: 'ME', bounds: BUDVA_ME.bounds });
  });

  test('with no home country, a city outside the user timezone gives no bias', async () => {
    const geocoder = scriptedGeocoder({ places: [DUTCH_HOTEL], areas: { 'Zeedorp|': COASTAL_VILLAGE_NL } });
    const s = setup({ timezone: 'Asia/Novosibirsk', city: 'Zeedorp' }, geocoder.service);

    await s.service.verifyEventLocation(s.event, s.user());

    expect(geocoder.searches[0]?.bias).toBeUndefined();
    await s.expectNothingWritten();
  });
});

describe('tapping a candidate resolves the event', () => {
  test('the tap applies the place, edits delivered invitations, remembers the place and fills an empty home city', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE, NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());
    expect(s.invitationEdits).toEqual([]);

    const edits = await s.tap(button(s.sent[0], '0'));

    const stored = s.storedEvent();
    expect(stored.location).toBe(RAW_LOCATION);
    expect(stored.location_verified).toBe(1);
    expect(stored.resolved_address).toBe(BELGRADE_CAFE.formattedAddress);
    expect(stored.venue_name).toBe('Kafana Sunce');
    expect(stored.google_maps_url).toBe(BELGRADE_CAFE.googleMapsUrl);
    // The invitee's card shows the place and keeps its RSVP buttons: an edit without them deletes them
    expect(s.invitationEdits).toHaveLength(1);
    expect(s.invitationEdits[0]!.text).toContain(escapeHtml(BELGRADE_CAFE.formattedAddress));
    expect(s.invitationEdits[0]!.options.reply_markup?.toJSON()).toEqual(
      invitationRsvpKeyboard(s.invitation.id, 'ru').toJSON(),
    );
    expect((await s.addressCache.findMapping(USER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      BELGRADE_CAFE.formattedAddress,
    );
    expect(s.user().city).toBe('Белград');
    expect(await s.candidateStore.get(s.event.id)).toBeNull();
    // The picker turns into the confirmation, without buttons.
    expect(edits).toHaveLength(1);
    expect(edits[0]!.replyMarkup).toBeUndefined();
    expect(edits[0]!.text).toContain(`<a href="${escapeHtml(BELGRADE_CAFE.googleMapsUrl)}">`);
  });

  test('choosing a place abroad remembers it for this text but never makes it the home city', async () => {
    const geocoder = scriptedGeocoder({ places: [DUTCH_HOTEL], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());

    await s.tap(button(s.sent[0], '0'));

    expect(s.storedEvent().resolved_address).toBe(DUTCH_HOTEL.formattedAddress);
    expect((await s.addressCache.findMapping(USER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      DUTCH_HOTEL.formattedAddress,
    );
    expect(s.user().city).toBeNull();
  });

  test('choosing a place never overwrites an existing home city', async () => {
    const s = setup({ timezone: 'Europe/Belgrade', city: 'Нови-Сад' }, scriptedGeocoder({ places: [] }).service);

    await s.confirmEarlier(BELGRADE_CAFE);

    expect(s.user().city).toBe('Нови-Сад');
  });

  test('a tap on an older picker never applies a place from the newer one', async () => {
    const script = { places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } };
    const s = setup({ timezone: 'Europe/Belgrade' }, scriptedGeocoder(script).service);
    await s.service.verifyEventLocation(s.event, s.user());
    script.places = [NIS_CAFE];
    await s.service.verifyEventLocation(s.event, s.user());

    const edits = await s.tap(button(s.sent[0], '0'));

    await s.expectNothingWritten();
    expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);

    await s.tap(button(s.sent[1], '0'));

    expect(s.storedEvent().resolved_address).toBe(NIS_CAFE.formattedAddress);
  });

  test('the picker can still be answered days after it was sent', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());

    setSystemTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    try {
      await s.tap(button(s.sent[0], '0'));
    } finally {
      setSystemTime();
    }

    expect(s.storedEvent().location_verified).toBe(1);
    expect(s.storedEvent().resolved_address).toBe(BELGRADE_CAFE.formattedAddress);
  });

  test('a tap after the picker expired changes nothing and says the choice is out of date', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());

    setSystemTime(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    let edits: EditedMessage[];
    try {
      edits = await s.tap(button(s.sent[0], '0'));
    } finally {
      setSystemTime();
    }

    await s.expectNothingWritten();
    expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);
  });

  test('a button sent before pickers had an id changes nothing', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());

    for (const legacy of [`loc_cand:${s.event.id}:0`, `loc_cand:${s.event.id}:keep`]) {
      const edits = await s.tap(legacy);
      expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);
    }
    await s.expectNothingWritten();
    expect(await s.candidateStore.get(s.event.id)).not.toBeNull();
  });

  test('a tap after the text was edited without a new search applies and remembers nothing', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());
    // The /edit scene, an abstract location or a calendar sync change the text without verifying it
    s.eventRepo.update(s.event.id, USER_ID, { location: EDITED_LOCATION });

    const edits = await s.tap(button(s.sent[0], '0'));

    const stored = s.storedEvent();
    expect(stored.location).toBe(EDITED_LOCATION);
    expect(stored.location_verified).toBe(0);
    expect(stored.resolved_address).toBeNull();
    expect(stored.venue_name).toBeNull();
    expect(s.invitationEdits).toEqual([]);
    expect(await s.addressCache.getRecent(USER_ID)).toEqual([]);
    expect(s.user().city).toBeNull();
    expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);
  });

  test('a tap whose event text is edited while the picker is being taken applies nothing', async () => {
    const geocoder = scriptedGeocoder({ places: [DUTCH_HOTEL], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());
    const take = s.candidateStore.take.bind(s.candidateStore);
    s.candidateStore.take = async (eventId, pickerId) => {
      const picker = await take(eventId, pickerId);
      s.eventRepo.update(s.event.id, USER_ID, { location: EDITED_LOCATION });
      return picker;
    };

    const edits = await s.tap(button(s.sent[0], '0'));

    const stored = s.storedEvent();
    expect(stored.location).toBe(EDITED_LOCATION);
    expect(stored.location_verified).toBe(0);
    expect(stored.resolved_address).toBeNull();
    expect(s.invitationEdits).toEqual([]);
    expect(await s.addressCache.getRecent(USER_ID)).toEqual([]);
    expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);
  });

  test('the confirmation after a tap escapes the venue, the address and the title', async () => {
    const geocoder = scriptedGeocoder({ places: [TRICKY_CAFE, NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade', title: 'Q&A <встреча>' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());

    const edits = await s.tap(button(s.sent[0], '0'));

    expect(edits).toHaveLength(1);
    expect(edits[0]!.parseMode).toBe('HTML');
    expect(edits[0]!.text).toContain('Q&amp;A &lt;встреча&gt;');
    expect(edits[0]!.text).toContain('Bar &amp; Grill &lt;Dorćol&gt;');
    expect(edits[0]!.text).toContain('Cara Dušana 1 &lt;dvorište &amp; ulaz&gt;');
    expect(edits[0]!.text).not.toContain('<Dorćol>');
    expect(edits[0]!.text).not.toContain('<dvorište');
  });

  test('a pin shared for the event is a confirmation too, and its confirmation is escaped', async () => {
    const geocoder = scriptedGeocoder({ places: [], reverse: TRICKY_CAFE });
    const s = setup({ timezone: 'Europe/Belgrade', title: 'Q&A <встреча>' }, geocoder.service);
    await s.pendingGeoStore.set(USER_ID, { latitude: TRICKY_CAFE.latitude, longitude: TRICKY_CAFE.longitude });

    const edits = await s.tap(`loc_geo:geo:${s.event.id}`);

    expect(s.storedEvent().location_verified).toBe(1);
    expect(s.storedEvent().resolved_address).toBe(TRICKY_CAFE.formattedAddress);
    expect(s.invitationEdits).toHaveLength(1);
    expect((await s.addressCache.findMapping(USER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      TRICKY_CAFE.formattedAddress,
    );
    expect(s.user().city).toBe('Белград');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.parseMode).toBe('HTML');
    expect(edits[0]!.text).toContain('Q&amp;A &lt;встреча&gt;');
    expect(edits[0]!.text).toContain('Bar &amp; Grill &lt;Dorćol&gt;');
    expect(edits[0]!.text).toContain('Cara Dušana 1 &lt;dvorište &amp; ulaz&gt;');
  });
});

describe('keep as typed', () => {
  test('tapping it leaves the event unverified, caches nothing and drops the offered candidates', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());

    const edits = await s.tap(button(s.sent[0], 'keep'));

    const stored = s.storedEvent();
    expect(stored.location_verified).toBe(0);
    expect(stored.resolved_address).toBeNull();
    expect(await s.addressCache.findMapping(USER_ID, RAW_LOCATION)).toBeNull();
    expect(await s.addressCache.getRecent(USER_ID)).toEqual([]);
    // The card is re-rendered with just the typed text, keeping its RSVP buttons
    expect(s.invitationEdits).toHaveLength(1);
    expect(s.invitationEdits[0]!.text).toContain(RAW_LOCATION);
    expect(s.invitationEdits[0]!.text).not.toContain(escapeHtml(BELGRADE_CAFE.formattedAddress));
    expect(s.invitationEdits[0]!.options.reply_markup?.toJSON()).toEqual(
      invitationRsvpKeyboard(s.invitation.id, 'ru').toJSON(),
    );
    expect(s.user().city).toBeNull();
    expect(await s.candidateStore.get(s.event.id)).toBeNull();
    expect(edits).toEqual([
      {
        text: t('ru').aiTools.location.keptAsTyped('Встреча', RAW_LOCATION),
        parseMode: undefined,
        replyMarkup: undefined,
      },
    ]);
  });

  test('a keep tap after the text was edited without a new search changes nothing', async () => {
    const geocoder = scriptedGeocoder({ places: [NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.confirmEarlier(BELGRADE_CAFE);
    await s.service.verifyEventLocation(s.storedEvent(), s.user());
    s.eventRepo.update(s.event.id, USER_ID, { location: EDITED_LOCATION });
    const cardEditsBefore = s.invitationEdits.length;

    const edits = await s.tap(button(s.sent[0], 'keep'));

    expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);
    expect(s.invitationEdits).toHaveLength(cardEditsBefore);
    // The place confirmed for the earlier text stays remembered for it
    expect((await s.addressCache.findMapping(USER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      BELGRADE_CAFE.formattedAddress,
    );
  });

  test('rejecting a remembered place forgets it for this text', async () => {
    const s = setup({ timezone: 'Europe/Belgrade' }, scriptedGeocoder({ places: [] }).service);
    await s.addressCache.recordMapping(USER_ID, RAW_LOCATION, {
      resolvedAddress: DUTCH_HOTEL.formattedAddress,
      googleMapsUrl: DUTCH_HOTEL.googleMapsUrl,
      latitude: DUTCH_HOTEL.latitude,
      longitude: DUTCH_HOTEL.longitude,
      placeId: DUTCH_HOTEL.placeId,
      venueName: DUTCH_HOTEL.venueName,
    });
    await s.service.verifyEventLocation(s.event, s.user());

    await s.tap(button(s.sent[0], 'keep'));

    expect(s.storedEvent().location_verified).toBe(0);
    expect(await s.addressCache.findMapping(USER_ID, RAW_LOCATION)).toBeNull();
  });

  test('rejecting a remembered place keeps another place confirmed for the text after the picker was sent', async () => {
    const geocoder = scriptedGeocoder({ places: [], reverse: BELGRADE_CAFE });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.addressCache.recordMapping(USER_ID, RAW_LOCATION, {
      resolvedAddress: DUTCH_HOTEL.formattedAddress,
      googleMapsUrl: DUTCH_HOTEL.googleMapsUrl,
      latitude: DUTCH_HOTEL.latitude,
      longitude: DUTCH_HOTEL.longitude,
      placeId: DUTCH_HOTEL.placeId,
      venueName: DUTCH_HOTEL.venueName,
    });
    await s.service.verifyEventLocation(s.event, s.user());
    // Meanwhile a pin confirms another place for the same text on another event
    const other = s.eventRepo.create({
      user_id: USER_ID,
      title: 'Обед',
      start_at: s.event.start_at,
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });
    await s.pendingGeoStore.set(USER_ID, { latitude: BELGRADE_CAFE.latitude, longitude: BELGRADE_CAFE.longitude });
    await s.tap(`loc_geo:geo:${other.id}`);

    await s.tap(button(s.sent[0], 'keep'));

    expect(s.storedEvent().location_verified).toBe(0);
    expect((await s.addressCache.findMapping(USER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      BELGRADE_CAFE.formattedAddress,
    );
  });

  test('keeping the text on one event keeps a place confirmed for the same text on another', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE, NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    const other = s.eventRepo.create({
      user_id: USER_ID,
      title: 'Обед',
      start_at: s.event.start_at,
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });
    await s.service.verifyEventLocation(s.event, s.user());
    await s.service.verifyEventLocation(other, s.user());
    await s.tap(button(s.sent[1], '0'));

    // This picker offered fresh search results, not the place confirmed on the other event
    await s.tap(button(s.sent[0], 'keep'));

    expect(s.storedEvent().location_verified).toBe(0);
    expect((await s.addressCache.findMapping(USER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      BELGRADE_CAFE.formattedAddress,
    );
  });

  test('keeping the typed text drops a place confirmed earlier and refreshes the invitation with its RSVP buttons', async () => {
    const geocoder = scriptedGeocoder({ places: [NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.confirmEarlier(BELGRADE_CAFE);
    await s.service.verifyEventLocation(s.storedEvent(), s.user());

    await s.tap(button(s.sent[0], 'keep'));

    const stored = s.storedEvent();
    expect(stored.location).toBe(RAW_LOCATION);
    expect(stored.location_verified).toBe(0);
    expect(stored.resolved_address).toBeNull();
    expect(stored.google_maps_url).toBeNull();
    expect(s.invitationEdits).toHaveLength(2);
    const card = s.invitationEdits[1]!;
    expect(card.text).not.toContain(escapeHtml(BELGRADE_CAFE.formattedAddress));
    expect(card.options.reply_markup?.toJSON()).toEqual(invitationRsvpKeyboard(s.invitation.id, 'ru').toJSON());
  });

  test('a keep tap refreshes the invitation even when an earlier question already dropped the place', async () => {
    const geocoder = scriptedGeocoder({ places: [NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.confirmEarlier(BELGRADE_CAFE);
    // The first question drops the confirmed place; the second finds the event without one
    await s.service.verifyEventLocation(s.storedEvent(), s.user());
    await s.service.verifyEventLocation(s.storedEvent(), s.user());

    await s.tap(button(s.sent[1], 'keep'));

    expect(s.storedEvent().location_verified).toBe(0);
    expect(s.invitationEdits).toHaveLength(2);
    const card = s.invitationEdits[1]!;
    expect(card.text).not.toContain(escapeHtml(BELGRADE_CAFE.formattedAddress));
    expect(card.options.reply_markup?.toJSON()).toEqual(invitationRsvpKeyboard(s.invitation.id, 'ru').toJSON());
  });

  test('keeping the text of an event the user cannot see changes nothing', async () => {
    const s = setup({ timezone: 'Europe/Belgrade' }, scriptedGeocoder({ places: [] }).service);
    await s.confirmEarlier(BELGRADE_CAFE);
    await s.service.verifyEventLocation(s.storedEvent(), s.user());

    const editsBefore = s.invitationEdits.length;
    const pickerId = button(s.sent[0], 'keep').split(':')[2] ?? '';
    expect(await s.service.keepTypedLocation(s.event.id, USER_ID + 1, pickerId)).toBeNull();
    expect(s.invitationEdits).toHaveLength(editsBefore);
    expect(await s.candidateStore.get(s.event.id)).not.toBeNull();
    expect(await s.addressCache.findMapping(USER_ID, RAW_LOCATION)).not.toBeNull();
  });

  test('a late keep tap on a picker already answered with a candidate does not erase the choice', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE, NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());
    await s.tap(button(s.sent[0], '0'));

    const edits = await s.tap(button(s.sent[0], 'keep'));

    expect(s.storedEvent().location_verified).toBe(1);
    expect(s.storedEvent().resolved_address).toBe(BELGRADE_CAFE.formattedAddress);
    expect((await s.addressCache.findMapping(USER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      BELGRADE_CAFE.formattedAddress,
    );
    expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);
  });

  test('a candidate tap and a keep tap racing on one picker: exactly one of them takes effect', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE, NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());

    const [choose, keep] = await Promise.all([s.tap(button(s.sent[0], '0')), s.tap(button(s.sent[0], 'keep'))]);

    const outdated = t('ru').aiTools.location.locationChoiceOutdated;
    const outcomes = [choose[0]?.text === outdated, keep[0]?.text === outdated];
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    if (keep[0]?.text === outdated) {
      expect(s.storedEvent().resolved_address).toBe(BELGRADE_CAFE.formattedAddress);
    } else {
      await s.expectNothingWritten();
    }
  });

  test('a keep tap after the place was confirmed with a pin does not erase it', async () => {
    const geocoder = scriptedGeocoder({ places: [DUTCH_HOTEL], areas: { '|RS': SERBIA }, reverse: BELGRADE_CAFE });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());
    await s.pendingGeoStore.set(USER_ID, { latitude: BELGRADE_CAFE.latitude, longitude: BELGRADE_CAFE.longitude });
    await s.tap(`loc_geo:geo:${s.event.id}`);

    await s.tap(button(s.sent[0], 'keep'));

    expect(s.storedEvent().location_verified).toBe(1);
    expect(s.storedEvent().resolved_address).toBe(BELGRADE_CAFE.formattedAddress);
  });
});
