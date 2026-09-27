// test/services/location/location-verification-plausibility.test.ts
// Regression for the 2026-09-27 incident: an unconfirmed far-away geocode was shown to invitees as a
// verified address and poisoned the user's home city and address cache. Real SQLite repositories,
// real address cache over an in-memory Redis, and a scripted geocoder.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
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
import type {
  GeoBounds,
  GeocodedArea,
  GeocodedLocation,
  GeocodingBias,
  GeocodingService,
} from '../../../src/services/location/geocoding-service.ts';
import { InMemoryLocationCandidateStore } from '../../../src/services/location/location-candidate-store.ts';
import { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';
import { escapeHtml } from '../../../src/utils/telegram.ts';

const USER_ID = 1001;
const RAW_LOCATION = 'Kafana Sunce';

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

let db: Database;
afterEach(() => db.close());

function setup(profile: { timezone: string; city?: string; countryCode?: string }, geocodingService: GeocodingService) {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  userRepo.create({
    telegram_id: USER_ID,
    language: 'ru',
    timezone: profile.timezone,
    ...(profile.countryCode ? { country_code: profile.countryCode } : {}),
  });
  if (profile.city) userRepo.update(USER_ID, { city: profile.city });
  const eventRepo = new EventRepository(db);
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const event = eventRepo.create({
    user_id: USER_ID,
    title: 'Встреча',
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
    timezone: 'Europe/Belgrade',
    location: RAW_LOCATION,
  });
  const addressCache = new AddressCache(memoryRedis());
  const candidateStore = new InMemoryLocationCandidateStore();
  const sent: SentMessage[] = [];
  const service = new LocationVerificationService({
    geocodingService,
    addressCache,
    eventRepo,
    userRepo,
    invitationRepo: new InvitationRepository(db),
    candidateStore,
    sendMessage: async (userId, text, options) => {
      sent.push({ userId, text, replyMarkup: options?.reply_markup });
    },
  });
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
  return { service, event, user, storedEvent, addressCache, candidateStore, sent };
}

describe('automatic resolution is limited to the user home area', () => {
  test('far-away single result for a Belgrade-timezone user without a city asks instead of resolving', async () => {
    const geocoder = scriptedGeocoder({ places: [DUTCH_HOTEL], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(false);
    // The search itself is biased toward the timezone country, not left to the server's IP location.
    expect(geocoder.searches[0]?.bias).toEqual({ countryCode: 'RS', bounds: SERBIA_BOUNDS });

    const event = s.storedEvent();
    expect(event.location).toBe(RAW_LOCATION);
    expect(event.location_verified).toBe(0);
    expect(event.resolved_address).toBeNull();
    expect(event.google_maps_url).toBeNull();

    expect(s.user().city).toBeNull();
    expect(await s.addressCache.findMapping(USER_ID, RAW_LOCATION)).toBeNull();
    expect(await s.addressCache.getRecent(USER_ID)).toEqual([]);

    expect(s.sent).toHaveLength(1);
    const ask = s.sent[0]!;
    expect(ask.userId).toBe(USER_ID);
    expect(ask.text).toContain(escapeHtml(DUTCH_HOTEL.formattedAddress));
    expect(ask.text).toContain(`<a href="${escapeHtml(DUTCH_HOTEL.googleMapsUrl)}">`);
    expect(callbackData(ask)).toEqual([`loc_cand:${s.event.id}:0`, `loc_cand:${s.event.id}:keep`]);
    expect(await s.candidateStore.get(s.event.id)).toEqual([DUTCH_HOTEL]);
  });

  test('a city learned from an earlier unconfirmed resolve outside the timezone country is not trusted', async () => {
    const geocoder = scriptedGeocoder({
      places: [DUTCH_HOTEL],
      areas: { 'Zeedorp|RS': COASTAL_VILLAGE_NL, '|RS': SERBIA },
    });
    const s = setup({ timezone: 'Europe/Belgrade', city: 'Zeedorp' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(false);
    expect(geocoder.searches[0]?.bias).toEqual({ countryCode: 'RS', bounds: SERBIA_BOUNDS });
    expect(s.storedEvent().location_verified).toBe(0);
    expect(callbackData(s.sent[0])).toContain(`loc_cand:${s.event.id}:0`);
  });

  test('single result inside the timezone country is resolved and shown with a wrong-place button, without teaching the city or the cache', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(true);
    const event = s.storedEvent();
    expect(event.location_verified).toBe(1);
    expect(event.resolved_address).toBe(BELGRADE_CAFE.formattedAddress);
    expect(event.google_maps_url).toBe(BELGRADE_CAFE.googleMapsUrl);
    expect(s.user().city).toBeNull();
    expect(await s.addressCache.findMapping(USER_ID, RAW_LOCATION)).toBeNull();

    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.text).toContain(
      `<a href="${escapeHtml(BELGRADE_CAFE.googleMapsUrl)}">Kafana Sunce — ${escapeHtml(BELGRADE_CAFE.formattedAddress)}</a>`,
    );
    expect(callbackData(s.sent[0])).toEqual([`loc_cand:${s.event.id}:keep`]);
    expect(buttonLabels(s.sent[0])).toEqual(['❌ Не то место']);
  });

  test('no result tells the user and leaves only the typed text', async () => {
    const geocoder = scriptedGeocoder({ places: [], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(false);
    expect(s.storedEvent().location_verified).toBe(0);
    expect(s.sent.map((m) => m.text)).toEqual([
      '📍 Не удалось определить адрес для «Встреча». Можешь отправить 📍 геолокацию или написать полный адрес.',
    ]);
  });

  test('a place resolved for the previous text is dropped when the new text needs confirmation', async () => {
    const geocoder = scriptedGeocoder({ places: [DUTCH_HOTEL], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.applyResolvedLocation(s.event, BELGRADE_CAFE);

    await s.service.verifyEventLocation(s.storedEvent(), s.user());

    const event = s.storedEvent();
    expect(event.location_verified).toBe(0);
    expect(event.resolved_address).toBeNull();
    expect(event.google_maps_url).toBeNull();
    expect(event.latitude).toBeNull();
  });

  test('explicit profile country wins over the timezone country', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Amsterdam', countryCode: 'RS' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(true);
    expect(geocoder.searches[0]?.bias?.countryCode).toBe('RS');
  });

  test('single result near the confirmed home city is resolved; biased to the city viewport', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { 'Белград|RS': BELGRADE } });
    const s = setup({ timezone: 'Europe/Belgrade', city: 'Белград' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(true);
    expect(geocoder.searches[0]?.bias).toEqual({ countryCode: 'RS', bounds: BELGRADE.bounds });
    expect(s.storedEvent().location_verified).toBe(1);
  });

  test('single result in the home country but far from the home city asks', async () => {
    const geocoder = scriptedGeocoder({ places: [NIS_CAFE], areas: { 'Белград|RS': BELGRADE } });
    const s = setup({ timezone: 'Europe/Belgrade', city: 'Белград' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(false);
    expect(s.storedEvent().location_verified).toBe(0);
    expect(callbackData(s.sent[0])).toEqual([`loc_cand:${s.event.id}:0`, `loc_cand:${s.event.id}:keep`]);
  });

  test('without any known home area a single result is never auto-resolved', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE] });
    const s = setup({ timezone: 'UTC' }, geocoder.service);

    const result = await s.service.verifyEventLocation(s.event, s.user());

    expect(result.resolved).toBe(false);
    expect(geocoder.searches[0]?.bias).toBeUndefined();
    expect(s.storedEvent().location_verified).toBe(0);
    expect(s.sent).toHaveLength(1);
  });

  test('every candidate of an ambiguous result gets a map link and a button named after it, plus none-of-these', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE, NIS_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    await s.service.verifyEventLocation(s.event, s.user());

    const ask = s.sent[0]!;
    for (const candidate of [BELGRADE_CAFE, NIS_CAFE]) {
      expect(ask.text).toContain(`<a href="${escapeHtml(candidate.googleMapsUrl)}">`);
    }
    expect(buttonLabels(ask)).toEqual(['1. Kafana Sunce', `2. ${NIS_CAFE.formattedAddress}`, '🚫 Ничего из этого']);
    expect(callbackData(ask)).toEqual([
      `loc_cand:${s.event.id}:0`,
      `loc_cand:${s.event.id}:1`,
      `loc_cand:${s.event.id}:keep`,
    ]);
  });
});

describe('only an explicit confirmation teaches the address cache and the home city', () => {
  test('choosing a candidate in the home country records the mapping and fills the empty city', async () => {
    const geocoder = scriptedGeocoder({ places: [] });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    const chosen = await s.service.handleLocationChoice(s.event.id, USER_ID, 0, [BELGRADE_CAFE]);

    expect(chosen).toBe(true);
    expect(s.storedEvent().location_verified).toBe(1);
    expect((await s.addressCache.findMapping(USER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      BELGRADE_CAFE.formattedAddress,
    );
    expect(s.user().city).toBe('Белград');
  });

  test('choosing a candidate abroad records the mapping but never makes it the home city', async () => {
    const geocoder = scriptedGeocoder({ places: [] });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    const chosen = await s.service.handleLocationChoice(s.event.id, USER_ID, 0, [DUTCH_HOTEL]);

    expect(chosen).toBe(true);
    expect((await s.addressCache.findMapping(USER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      DUTCH_HOTEL.formattedAddress,
    );
    expect(s.user().city).toBeNull();
  });

  test('choosing a candidate never overwrites an existing city', async () => {
    const geocoder = scriptedGeocoder({ places: [] });
    const s = setup({ timezone: 'Europe/Belgrade', city: 'Нови-Сад' }, geocoder.service);

    await s.service.handleLocationChoice(s.event.id, USER_ID, 0, [BELGRADE_CAFE]);

    expect(s.user().city).toBe('Нови-Сад');
  });

  test('a shared pin for the event is a confirmation too', async () => {
    const geocoder = scriptedGeocoder({ places: [], reverse: BELGRADE_CAFE });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);

    const resolved = await s.service.resolveFromCoordinates(s.event.id, 44.8231, 20.4632, USER_ID);

    expect(resolved).toBe(true);
    expect(s.storedEvent().location_verified).toBe(1);
    expect((await s.addressCache.findMapping(USER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      BELGRADE_CAFE.formattedAddress,
    );
    expect(s.user().city).toBe('Белград');
  });

  test('keeping the typed text leaves the event unverified and drops the offered candidates', async () => {
    const geocoder = scriptedGeocoder({ places: [DUTCH_HOTEL], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());

    const kept = await s.service.keepTypedLocation(s.event.id, USER_ID);

    expect(kept?.location).toBe(RAW_LOCATION);
    expect(s.storedEvent().location_verified).toBe(0);
    expect(await s.candidateStore.get(s.event.id)).toBeNull();
    expect(await s.addressCache.findMapping(USER_ID, RAW_LOCATION)).toBeNull();
    expect(s.user().city).toBeNull();
  });

  test('wrong place on an auto-picked place drops it back to the typed text', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());

    await s.service.keepTypedLocation(s.event.id, USER_ID);

    const event = s.storedEvent();
    expect(event.location).toBe(RAW_LOCATION);
    expect(event.location_verified).toBe(0);
    expect(event.resolved_address).toBeNull();
    expect(event.google_maps_url).toBeNull();
  });

  test('keeping the text of an event the user cannot see changes nothing', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());

    expect(await s.service.keepTypedLocation(s.event.id, USER_ID + 1)).toBeNull();
    expect(s.storedEvent().location_verified).toBe(1);
  });
});

describe('keep-as-typed button', () => {
  test('tapping it drops the auto-picked place and confirms the typed text', async () => {
    const geocoder = scriptedGeocoder({ places: [BELGRADE_CAFE], areas: { '|RS': SERBIA } });
    const s = setup({ timezone: 'Europe/Belgrade' }, geocoder.service);
    await s.service.verifyEventLocation(s.event, s.user());
    const [wrongPlace] = callbackData(s.sent[0]);

    const bot = new Bot('123:test');
    const edits: { text: string; replyMarkup: unknown }[] = [];
    bot.api.answerCallbackQuery = async () => true;
    bot.api.editMessageText = async (params) => {
      edits.push({ text: params.text.toString(), replyMarkup: params.reply_markup });
      return true;
    };
    const user = s.user();
    const ctx = Object.assign(
      new CallbackQueryContext({
        bot,
        update: { update_id: 1 },
        updateId: 1,
        payload: {
          id: 'callback',
          chat_instance: 'test',
          from: { id: USER_ID, is_bot: false, first_name: 'Owner' },
          data: wrongPlace,
          message: { message_id: 10, date: 0, chat: { id: USER_ID, type: 'private' } },
        },
      }),
      { dbUser: user, userTimezone: user.timezone, lang: 'ru' as const, scene: { enter: async () => {} } },
    );
    const eventRepo = new EventRepository(db);
    const handler = createCallbackHandler(
      new EventService({ eventRepo, agendaRepository: new AgendaRepository(db) }),
      new Scene('unused'),
      new HolidayService(new HolidayRepository(db)),
      new NotificationPreferencesService(new NotificationPreferencesRepository(db)),
      { eventRepo, locationVerification: s.service },
    );

    await handler(ctx);

    expect(edits).toEqual([
      { text: t('ru').aiTools.location.keptAsTyped('Встреча', RAW_LOCATION), replyMarkup: undefined },
    ]);
    expect(s.storedEvent().location_verified).toBe(0);
    expect(s.storedEvent().resolved_address).toBeNull();
  });
});
