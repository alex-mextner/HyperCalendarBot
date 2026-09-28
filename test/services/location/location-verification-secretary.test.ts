// test/services/location/location-verification-secretary.test.ts
// GH-421: a secretary with active write access sets a location on the owner's personal event. The
// real production call path — create_event/update_event(owner_id) -> LocationVerificationService ->
// the LOCATION_CANDIDATE callback -> the displayed confirmation — must let the secretary answer the
// picker sent to them, bias/cache/learn against the owner's profile (never the secretary's), and
// refuse a tap whose write access is revoked, read-only, for a different owner, or answers a
// stale/replayed picker. Real SQLite repositories, a real address cache over an in-memory Redis, a
// scripted geocoder, the real create/update tool handlers and the real callback handler for taps.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { Scene } from '@gramio/scenes';
import { Bot, CallbackQueryContext, type TelegramInlineKeyboardMarkup, type TelegramReplyKeyboardMarkup } from 'gramio';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { CalendarProposalRepository } from '../../../src/database/repositories/calendar-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { SecretaryRepository } from '../../../src/database/repositories/secretary.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { SecretaryPermission, SecretaryStatus } from '../../../src/database/types.ts';
import { handleCreateEvent, handleUpdateEvent } from '../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { AddressCache } from '../../../src/services/location/address-cache.ts';
import type {
  GeocodedLocation,
  GeocodingBias,
  GeocodingService,
} from '../../../src/services/location/geocoding-service.ts';
import { InMemoryLocationCandidateStore } from '../../../src/services/location/location-candidate-store.ts';
import { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';
import { InMemoryPendingGeoStore } from '../../../src/services/location/pending-geo-store.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';

const OWNER_ID = 5001;
const SECRETARY_ID = 5002;
const OTHER_OWNER_ID = 5003;
const RAW_LOCATION = 'Kafana Sunce';
const futureStart = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

const BELGRADE_BOUNDS = { south: 44.68, west: 20.2, north: 44.94, east: 20.62 };
const SERBIA_BOUNDS = { south: 42.23, west: 18.82, north: 46.19, east: 23.01 };

function place(overrides: Partial<GeocodedLocation> = {}): GeocodedLocation {
  return {
    formattedAddress: 'Dunavska 1, Белград, Сербия',
    latitude: 44.8231,
    longitude: 20.4632,
    city: 'Белград',
    country: 'Сербия',
    countryCode: 'RS',
    placeId: 'place-bg',
    venueName: 'Kafana Sunce',
    googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=44.8231,20.4632&query_place_id=place-bg',
    ...overrides,
  };
}

interface GeocoderCall {
  query: string;
  bias: GeocodingBias | undefined;
}

/** Ignores `bias` for ranking (a real bias never hard-filters, see geocoding-service.test.ts) but records it for assertions. */
function scriptedGeocoder(places: GeocodedLocation[], findPlace?: () => Promise<GeocodedLocation[]>) {
  const calls: GeocoderCall[] = [];
  const service: GeocodingService = {
    findPlace: async (query, bias) => {
      calls.push({ query, bias });
      return findPlace ? findPlace() : places;
    },
    geocodeAddress: async (query, bias) => {
      calls.push({ query, bias });
      return [];
    },
    reverseGeocode: async () => null,
    locateArea: async ({ city, countryCode }) => {
      if (city === 'Белград' && countryCode === 'RS') {
        return { latitude: 44.8125, longitude: 20.4612, countryCode: 'RS', bounds: BELGRADE_BOUNDS };
      }
      if (!city && countryCode === 'RS') {
        return { latitude: 44.02, longitude: 21.01, countryCode: 'RS', bounds: SERBIA_BOUNDS };
      }
      return null;
    },
  };
  return { service, calls };
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

interface SentMessage {
  userId: number;
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup | undefined;
}

function callbackData(message: SentMessage | undefined): string[] {
  const markup = message?.replyMarkup;
  if (!markup || !('inline_keyboard' in markup)) return [];
  return markup.inline_keyboard.flat().flatMap((b) => (b.callback_data ? [b.callback_data] : []));
}

function button(message: SentMessage | undefined, choice: string): string {
  const data = callbackData(message).find((d) => d.endsWith(`:${choice}`));
  if (!data) throw new Error(`no ${choice} button`);
  return data;
}

interface EditedMessage {
  text: string;
  replyMarkup: unknown;
}

let db: Database;
afterEach(() => db.close());

function setup(opts: {
  geocoder: GeocodingService;
  secretaryPermission?: SecretaryPermission;
  secretaryStatus?: SecretaryStatus;
  grantOwnerId?: number;
}) {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  // The owner lives in Belgrade; the secretary lives somewhere else entirely, so a test that
  // accidentally biases, caches or learns against the secretary instead of the owner is caught.
  userRepo.create({ telegram_id: OWNER_ID, language: 'ru', timezone: 'Europe/Belgrade', country_code: 'RS' });
  userRepo.create({ telegram_id: SECRETARY_ID, language: 'ru', timezone: 'Asia/Novosibirsk' });
  userRepo.create({ telegram_id: OTHER_OWNER_ID, language: 'ru', timezone: 'Europe/Belgrade', country_code: 'RS' });

  const secretaryRepo = new SecretaryRepository(db);
  const grant = secretaryRepo.upsert({
    owner_id: opts.grantOwnerId ?? OWNER_ID,
    secretary_id: SECRETARY_ID,
    permission: opts.secretaryPermission ?? 'write',
  });
  secretaryRepo.updateStatus(grant.id, opts.secretaryStatus ?? 'active');

  const eventRepo = new EventRepository(db);
  const invitationRepo = new InvitationRepository(db);
  const addressCache = new AddressCache(memoryRedis());
  const candidateStore = new InMemoryLocationCandidateStore();
  const pendingGeoStore = new InMemoryPendingGeoStore();
  const sent: SentMessage[] = [];
  const edits: { chatId: number; messageId: number; text: string; options: unknown }[] = [];

  const service = new LocationVerificationService({
    geocodingService: opts.geocoder,
    addressCache,
    eventRepo,
    userRepo,
    invitationRepo,
    agendaRepository: new AgendaRepository(db),
    candidateStore,
    secretaryRepo,
    sendMessage: async (userId, text, options) => {
      sent.push({ userId, text, replyMarkup: options?.reply_markup });
    },
    editMessage: async (chatId, messageId, text, options) => {
      edits.push({ chatId, messageId, text, options });
    },
  });

  // The tool handlers fire verifyEventLocation without awaiting it — capture the promise so the
  // test can wait for it to settle before asserting on `sent`/the stored event.
  const pending: Promise<unknown>[] = [];
  const realVerify = service.verifyEventLocation.bind(service);
  service.verifyEventLocation = (event, user) => {
    const p = realVerify(event, user);
    pending.push(p.catch(() => undefined));
    return p;
  };
  async function flush(): Promise<void> {
    await Promise.all(pending.splice(0));
  }

  const eventService = new EventService({ eventRepo, agendaRepository: new AgendaRepository(db) });

  function ctxFor(actorId: number): AgentContext {
    const user = userRepo.findByTelegramId(actorId);
    if (!user) throw new Error(`missing user ${actorId}`);
    return {
      user,
      chatId: actorId,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: null as never,
      userRepo,
      eventReminderRepo: null as never,
      conversationLogger: null as never,
      locationVerification: service,
      secretary: {
        secretaryRepo,
        secretaryForLine: undefined,
        calendarProposalRepo: new CalendarProposalRepository(db),
      },
    };
  }

  /** Press an inline button as `actorId`, through the real callback handler. */
  async function tap(data: string, actorId: number): Promise<EditedMessage[]> {
    const bot = new Bot('123:test');
    const edited: EditedMessage[] = [];
    bot.api.answerCallbackQuery = async () => true;
    bot.api.editMessageText = async (params) => {
      edited.push({ text: params.text.toString(), replyMarkup: params.reply_markup });
      return true;
    };
    const dbUser = userRepo.findByTelegramId(actorId);
    if (!dbUser) throw new Error(`missing user ${actorId}`);
    const ctx = Object.assign(
      new CallbackQueryContext({
        bot,
        update: { update_id: 1 },
        updateId: 1,
        payload: {
          id: 'callback',
          chat_instance: 'test',
          from: { id: actorId, is_bot: false, first_name: 'Actor' },
          data,
          message: { message_id: 10, date: 0, chat: { id: actorId, type: 'private' } },
        },
      }),
      { dbUser, userTimezone: dbUser.timezone, lang: 'ru' as const, scene: { enter: async () => {} } },
    );
    const handler = createCallbackHandler(
      eventService,
      new Scene('unused'),
      new HolidayService(new HolidayRepository(db)),
      new NotificationPreferencesService(new NotificationPreferencesRepository(db)),
      { eventRepo, userRepo, locationVerification: service, pendingGeoStore },
    );
    await handler(ctx);
    return edited;
  }

  function revokeSecretary(): void {
    secretaryRepo.updateStatus(grant.id, 'revoked');
  }

  return {
    eventRepo,
    userRepo,
    secretaryRepo,
    grant,
    addressCache,
    candidateStore,
    service,
    sent,
    edits,
    flush,
    ctxFor,
    tap,
    revokeSecretary,
  };
}

describe("a write secretary completes the place picker for the owner's personal calendar", () => {
  test("create_event: the picker is sent to the secretary and tapping it resolves the owner's event with a useful confirmation", async () => {
    const geocoder = scriptedGeocoder([place()]);
    const s = setup({ geocoder: geocoder.service });

    const result = await handleCreateEvent(s.ctxFor(SECRETARY_ID), {
      title: 'Coffee with Ira',
      start_at: futureStart(),
      location: RAW_LOCATION,
      owner_id: OWNER_ID,
    });
    expect(result.success).toBe(true);
    const data = result.data;
    if (!data || !('id' in data)) throw new Error('expected an event summary');
    const eventId = data.id;
    await s.flush();

    // Sent to the secretary — the person interacting with the bot — not the owner.
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.userId).toBe(SECRETARY_ID);

    const edits = await s.tap(button(s.sent[0], '0'), SECRETARY_ID);

    expect(edits).toHaveLength(1);
    // Useful confirmation text: the real event title and the resolved address, not blank.
    expect(edits[0]!.text).toContain('Coffee with Ira');
    expect(edits[0]!.text).toContain(place().formattedAddress);

    const stored = s.eventRepo.findById(eventId, OWNER_ID);
    expect(stored?.location_verified).toBe(1);
    expect(stored?.resolved_address).toBe(place().formattedAddress);
  });

  test('update_event: a secretary can set and confirm a location on an existing owner event', async () => {
    const geocoder = scriptedGeocoder([place()]);
    const s = setup({ geocoder: geocoder.service });
    const created = s.eventRepo.create({
      user_id: OWNER_ID,
      title: 'Планёрка',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
    });

    const result = await handleUpdateEvent(s.ctxFor(SECRETARY_ID), {
      event_id: created.id,
      location: RAW_LOCATION,
      owner_id: OWNER_ID,
    });
    expect(result.success).toBe(true);
    await s.flush();

    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.userId).toBe(SECRETARY_ID);

    await s.tap(button(s.sent[0], '0'), SECRETARY_ID);

    expect(s.eventRepo.findById(created.id, OWNER_ID)?.resolved_address).toBe(place().formattedAddress);
  });

  test('a write secretary whose access is revoked after the picker was sent cannot change the event with a tap', async () => {
    const geocoder = scriptedGeocoder([place()]);
    const s = setup({ geocoder: geocoder.service });
    const created = s.eventRepo.create({
      user_id: OWNER_ID,
      title: 'Планёрка',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });
    await s.service.verifyEventLocation(created, s.ctxFor(SECRETARY_ID).user);
    expect(s.sent).toHaveLength(1);

    s.revokeSecretary();
    const edits = await s.tap(button(s.sent[0], '0'), SECRETARY_ID);

    expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);
    const stored = s.eventRepo.findById(created.id, OWNER_ID);
    expect(stored?.location_verified).toBe(0);
    expect(stored?.resolved_address).toBeNull();
  });

  test('a read-only secretary is refused before any location tool runs — no picker is ever sent', async () => {
    const geocoder = scriptedGeocoder([place()]);
    const s = setup({ geocoder: geocoder.service, secretaryPermission: 'read' });

    const result = await handleCreateEvent(s.ctxFor(SECRETARY_ID), {
      title: 'Coffee',
      start_at: futureStart(),
      location: RAW_LOCATION,
      owner_id: OWNER_ID,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('SECRETARY_ACCESS_DENIED');
    await s.flush();
    expect(s.sent).toEqual([]);
  });

  test("a write secretary of a different owner cannot answer this owner's picker even by replaying its callback data", async () => {
    const geocoder = scriptedGeocoder([place()]);
    // SECRETARY_ID is a write secretary of OTHER_OWNER_ID, not of OWNER_ID.
    const s = setup({ geocoder: geocoder.service, grantOwnerId: OTHER_OWNER_ID });
    const created = s.eventRepo.create({
      user_id: OWNER_ID,
      title: 'Планёрка',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });
    const ownerUser = s.ctxFor(OWNER_ID).user;
    await s.service.verifyEventLocation(created, ownerUser);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.userId).toBe(OWNER_ID);

    const edits = await s.tap(button(s.sent[0], '0'), SECRETARY_ID);

    expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);
    const stored = s.eventRepo.findById(created.id, OWNER_ID);
    expect(stored?.location_verified).toBe(0);
  });

  test('write access revoked while the candidate search is in flight: no picker is sent and nothing is written', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const geocoder = scriptedGeocoder([place()], async () => {
      await gate;
      return [place()];
    });
    const s = setup({ geocoder: geocoder.service });
    const created = s.eventRepo.create({
      user_id: OWNER_ID,
      title: 'Планёрка',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });

    const verification = s.service.verifyEventLocation(created, s.ctxFor(SECRETARY_ID).user);
    s.revokeSecretary();
    release();
    await verification;

    expect(s.sent).toEqual([]);
    const stored = s.eventRepo.findById(created.id, OWNER_ID);
    expect(stored?.location_verified).toBe(0);
    expect(stored?.resolved_address).toBeNull();
  });

  test('write access revoked while the picker is being taken: the tap changes nothing', async () => {
    const geocoder = scriptedGeocoder([place()]);
    const s = setup({ geocoder: geocoder.service });
    const created = s.eventRepo.create({
      user_id: OWNER_ID,
      title: 'Планёрка',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });
    await s.service.verifyEventLocation(created, s.ctxFor(SECRETARY_ID).user);
    const take = s.candidateStore.take.bind(s.candidateStore);
    s.candidateStore.take = async (eventId, pickerId) => {
      const picker = await take(eventId, pickerId);
      s.revokeSecretary();
      return picker;
    };

    const edits = await s.tap(button(s.sent[0], '0'), SECRETARY_ID);

    expect(edits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);
    expect(s.eventRepo.findById(created.id, OWNER_ID)?.location_verified).toBe(0);
  });

  test('a stale picker replaced by a newer one cannot be answered by the secretary; the current one can', async () => {
    const script = { places: [place()] };
    const geocoder = scriptedGeocoder(script.places);
    geocoder.service.findPlace = async (query, bias) => {
      geocoder.calls.push({ query, bias });
      return script.places;
    };
    const s = setup({ geocoder: geocoder.service });
    const created = s.eventRepo.create({
      user_id: OWNER_ID,
      title: 'Планёрка',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });
    await s.service.verifyEventLocation(created, s.ctxFor(SECRETARY_ID).user);
    script.places = [place({ formattedAddress: 'Other place', placeId: 'other' })];
    await s.service.verifyEventLocation(s.eventRepo.findById(created.id, OWNER_ID)!, s.ctxFor(SECRETARY_ID).user);
    expect(s.sent).toHaveLength(2);

    const staleEdits = await s.tap(button(s.sent[0], '0'), SECRETARY_ID);
    expect(staleEdits.map((e) => e.text)).toEqual([t('ru').aiTools.location.locationChoiceOutdated]);

    await s.tap(button(s.sent[1], '0'), SECRETARY_ID);
    expect(s.eventRepo.findById(created.id, OWNER_ID)?.resolved_address).toBe('Other place');
  });

  test("the search is biased to the owner's home area, never the secretary's", async () => {
    const geocoder = scriptedGeocoder([place()]);
    const s = setup({ geocoder: geocoder.service });
    s.userRepo.update(OWNER_ID, { city: 'Белград' });
    const created = s.eventRepo.create({
      user_id: OWNER_ID,
      title: 'Планёрка',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });

    await s.service.verifyEventLocation(created, s.ctxFor(SECRETARY_ID).user);

    expect(geocoder.calls[0]?.bias).toEqual({ countryCode: 'RS', bounds: BELGRADE_BOUNDS });
  });

  test('the address cache and any city fill are scoped to the owner, never the secretary', async () => {
    const geocoder = scriptedGeocoder([place()]);
    const s = setup({ geocoder: geocoder.service });
    const created = s.eventRepo.create({
      user_id: OWNER_ID,
      title: 'Планёрка',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });
    await s.service.verifyEventLocation(created, s.ctxFor(SECRETARY_ID).user);

    await s.tap(button(s.sent[0], '0'), SECRETARY_ID);

    expect((await s.addressCache.findMapping(OWNER_ID, RAW_LOCATION))?.resolvedAddress).toBe(place().formattedAddress);
    expect(await s.addressCache.findMapping(SECRETARY_ID, RAW_LOCATION)).toBeNull();
    // A delegated confirmation never auto-fills any profile city — neither the owner's nor the
    // delegate's — even though the candidate's city (Белград) lies in the owner's home region.
    expect(s.userRepo.findByTelegramId(OWNER_ID)?.city).toBeNull();
    expect(s.userRepo.findByTelegramId(SECRETARY_ID)?.city).toBeNull();
  });

  test('for contrast: the owner confirming their own picker still learns their home city', async () => {
    const geocoder = scriptedGeocoder([place()]);
    const s = setup({ geocoder: geocoder.service });
    const created = s.eventRepo.create({
      user_id: OWNER_ID,
      title: 'Планёрка',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });
    await s.service.verifyEventLocation(created, s.ctxFor(OWNER_ID).user);

    await s.tap(button(s.sent[0], '0'), OWNER_ID);

    expect(s.userRepo.findByTelegramId(OWNER_ID)?.city).toBe('Белград');
  });

  test("keep as typed via the secretary: nothing is applied, and a remembered place is forgotten from the owner's cache only", async () => {
    const geocoder = scriptedGeocoder([]);
    const s = setup({ geocoder: geocoder.service });
    await s.addressCache.recordMapping(OWNER_ID, RAW_LOCATION, {
      resolvedAddress: place().formattedAddress,
      googleMapsUrl: place().googleMapsUrl,
      latitude: place().latitude,
      longitude: place().longitude,
      placeId: place().placeId,
      venueName: place().venueName,
    });
    const created = s.eventRepo.create({
      user_id: OWNER_ID,
      title: 'Планёрка',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
    });
    await s.service.verifyEventLocation(created, s.ctxFor(SECRETARY_ID).user);

    const edits = await s.tap(button(s.sent[0], 'keep'), SECRETARY_ID);

    expect(edits).toEqual([
      { text: t('ru').aiTools.location.keptAsTyped('Планёрка', RAW_LOCATION), replyMarkup: undefined },
    ]);
    const stored = s.eventRepo.findById(created.id, OWNER_ID);
    expect(stored?.location_verified).toBe(0);
    expect(stored?.resolved_address).toBeNull();
    expect(await s.addressCache.findMapping(OWNER_ID, RAW_LOCATION)).toBeNull();
  });
});

describe('a group event is never treated as secretary-delegated', () => {
  test("a non-creator group member's own bias and cache are used when they edit the location — never the creator's", async () => {
    const geocoder = scriptedGeocoder([place()]);
    const s = setup({ geocoder: geocoder.service });
    const GROUP_MEMBER_ID = 5004;
    const GROUP_CHAT_ID = -1009999;
    // No city/country and a timezone with no known country mapping, so a bias leaking from the
    // creator's Belgrade profile would be immediately visible as a defined bias here.
    s.userRepo.create({ telegram_id: GROUP_MEMBER_ID, language: 'ru', timezone: 'Asia/Novosibirsk' });
    const groupMemberRepo = new GroupMemberRepository(db);
    groupMemberRepo.upsert(GROUP_CHAT_ID, OWNER_ID);
    groupMemberRepo.upsert(GROUP_CHAT_ID, GROUP_MEMBER_ID);
    const created = s.eventRepo.create({
      user_id: OWNER_ID, // the event's creator — not necessarily who edits its location later
      title: 'Групповая встреча',
      start_at: futureStart(),
      timezone: 'Europe/Belgrade',
      location: RAW_LOCATION,
      owner_type: 'group',
      group_id: GROUP_CHAT_ID,
      created_by: OWNER_ID,
    });
    const memberUser = s.userRepo.findByTelegramId(GROUP_MEMBER_ID);
    if (!memberUser) throw new Error('missing group member user');

    await s.service.verifyEventLocation(created, memberUser);

    expect(geocoder.calls[0]?.bias).toBeUndefined();
    expect(s.sent[0]?.userId).toBe(GROUP_MEMBER_ID);

    await s.tap(button(s.sent[0], '0'), GROUP_MEMBER_ID);

    // The confirmed place is cached under the editing member, not the event's creator.
    expect((await s.addressCache.findMapping(GROUP_MEMBER_ID, RAW_LOCATION))?.resolvedAddress).toBe(
      place().formattedAddress,
    );
    expect(await s.addressCache.findMapping(OWNER_ID, RAW_LOCATION)).toBeNull();
  });
});
