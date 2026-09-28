// test/bot/scenes/edit-value.scene.test.ts
//
// The Location edit button (#395): a new location must drop the old resolved
// place and go through the same verification and clarification flow as the AI
// update_event tool.

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, type Mock, mock, test } from 'bun:test';
import { createUserResolverComposer } from '../../../src/bot/middleware/user-resolver.ts';
import { createEditValueScene } from '../../../src/bot/scenes/edit-value.scene.ts';
import type { DatabaseService } from '../../../src/database/index.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CalendarEvent, User } from '../../../src/database/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { AddressCache } from '../../../src/services/location/address-cache.ts';
import type { GeocodedLocation } from '../../../src/services/location/geocoding-service.ts';
import { InMemoryLocationCandidateStore } from '../../../src/services/location/location-candidate-store.ts';
import { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';

const USER_ID = 502;
const INVITEE_ID = 503;
const CHAT_ID = 502;
const CARD_MESSAGE_ID = 31;
const INVITATION_MESSAGE_ID = 32;

const OLD_PLACE = {
  resolved_address: 'Example Boulevard 7, Sampletown',
  latitude: 52.11,
  longitude: 4.28,
  google_maps_url: 'https://www.google.com/maps/place/?q=place_id:SYNTHETIC_OLD_PLACE',
  location_verified: 1,
  venue_name: 'Seaside Hotel Example',
};

interface EditCtx {
  lang: 'en' | 'ru';
  dbUser: User;
  text: string;
  id: number;
  scene: {
    params: { eventId: number; field: string; chatId: number; messageId: number };
    step: { id: number };
    exit: Mock<() => Promise<void>>;
  };
  send: Mock<(text: string) => Promise<void>>;
  bot: { api: { editMessageText: Mock<(params: { text: string }) => Promise<void>> } };
  is: (type: string) => boolean;
}

type StepFn = (ctx: EditCtx, next: () => Promise<void>) => Promise<void>;

interface SceneInternals {
  '~': { composer: { '~': { middlewares: { fn: StepFn }[] } } };
}

/** The user resolver only reads `users`; boundary cast once here. */
function userOnlyDb(users: UserRepository): DatabaseService {
  return { users } as unknown as DatabaseService;
}

/** The scene's only step: middleware 0 is the user-resolver derive from `.extend()`. */
function getStepFn(scene: unknown): StepFn {
  const step = (scene as SceneInternals)['~'].composer['~'].middlewares[1];
  if (!step) throw new Error('edit_value step not registered');
  return step.fn;
}

describe('edit_value scene: Location button', () => {
  let db: Database;
  let events: EventRepository;
  let user: User;
  let verifyEventLocation: Mock<LocationVerificationService['verifyEventLocation']>;
  let step: StepFn;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    user = users.create({ telegram_id: USER_ID, timezone: 'UTC' });
    events = new EventRepository(db);
    verifyEventLocation = mock(() =>
      Promise.resolve({ resolved: false, geocoded: null, cityExtracted: null, candidates: [] }),
    );
    const composer = createUserResolverComposer(userOnlyDb(users));
    step = getStepFn(
      createEditValueScene(new EventService({ eventRepo: events }), composer, undefined, {
        verifyEventLocation,
        refreshInvitationCards: mock(() => Promise.resolve()),
      }),
    );
  });

  function resolvedEvent(): CalendarEvent {
    const event = events.create({
      user_id: USER_ID,
      title: 'Dinner',
      start_at: '2026-10-05T17:00:00Z',
      end_at: '2026-10-05T18:00:00Z',
      timezone: 'UTC',
      location: 'seaside hotel',
    });
    events.updateLocationFields(event.id, OLD_PLACE);
    return event;
  }

  function makeCtx(eventId: number, field: string, text: string): EditCtx {
    return {
      lang: 'ru',
      dbUser: user,
      text,
      id: 40,
      scene: {
        params: { eventId, field, chatId: CHAT_ID, messageId: CARD_MESSAGE_ID },
        step: { id: 0 },
        exit: mock(() => Promise.resolve()),
      },
      send: mock(() => Promise.resolve()),
      bot: { api: { editMessageText: mock(() => Promise.resolve()) } },
      is: (type) => type === 'message',
    };
  }

  test('new location drops the old place from the card and is verified', async () => {
    const event = resolvedEvent();
    const ctx = makeCtx(event.id, 'location', 'дома');
    await step(ctx, () => Promise.resolve());

    const row = events.findById(event.id, USER_ID);
    expect(row).toMatchObject({
      location: 'дома',
      resolved_address: null,
      latitude: null,
      longitude: null,
      google_maps_url: null,
      location_verified: 0,
      venue_name: null,
    });

    const [card] = ctx.bot.api.editMessageText.mock.calls[0] ?? [];
    expect(card?.text).toContain('дома');
    expect(card?.text).not.toContain(OLD_PLACE.venue_name);
    expect(card?.text).not.toContain('SYNTHETIC_OLD_PLACE');

    expect(verifyEventLocation).toHaveBeenCalledTimes(1);
    const [verifiedEvent, verifiedUser] = verifyEventLocation.mock.calls[0] ?? [];
    expect(verifiedEvent?.id).toBe(event.id);
    expect(verifiedEvent?.location).toBe('дома');
    expect(verifiedUser?.telegram_id).toBe(USER_ID);
  });

  test('"clear" removes the location with its resolved place and verifies nothing', async () => {
    const event = resolvedEvent();
    await step(makeCtx(event.id, 'location', 'clear'), () => Promise.resolve());

    expect(events.findById(event.id, USER_ID)).toMatchObject({
      location: null,
      resolved_address: null,
      google_maps_url: null,
      location_verified: 0,
      venue_name: null,
    });
    expect(verifyEventLocation).not.toHaveBeenCalled();
  });

  test('"clear" drops a place a pin set on an event without typed text', async () => {
    const event = events.create({
      user_id: USER_ID,
      title: 'Dinner',
      start_at: '2026-10-05T17:00:00Z',
      timezone: 'UTC',
    });
    events.updateLocationFields(event.id, OLD_PLACE);

    await step(makeCtx(event.id, 'location', 'clear'), () => Promise.resolve());

    expect(events.findById(event.id, USER_ID)).toMatchObject({
      location: null,
      resolved_address: null,
      latitude: null,
      longitude: null,
      google_maps_url: null,
      location_verified: 0,
      venue_name: null,
    });
    expect(verifyEventLocation).not.toHaveBeenCalled();
  });

  test('editing another field keeps the resolved place and verifies nothing', async () => {
    const event = resolvedEvent();
    await step(makeCtx(event.id, 'title', 'Late dinner'), () => Promise.resolve());

    expect(events.findById(event.id, USER_ID)).toMatchObject({ title: 'Late dinner', ...OLD_PLACE });
    expect(verifyEventLocation).not.toHaveBeenCalled();
  });
});

// The Location button goes through the real verification: nothing is applied before the user
// answers the picker. The edit itself re-renders a delivered invitation card that showed the dropped
// place, and answering "keep as typed" refreshes it again.
describe('edit_value scene: Location button with real verification', () => {
  const LONE_MATCH: GeocodedLocation = {
    formattedAddress: 'Doma Bistro, Example Street 3, Sampletown',
    latitude: 44.81,
    longitude: 20.46,
    city: 'Sampletown',
    country: 'Exampleland',
    placeId: 'SYNTHETIC_DOMA_BISTRO',
    googleMapsUrl: 'https://www.google.com/maps/place/?q=place_id:SYNTHETIC_DOMA_BISTRO',
    venueName: 'Doma Bistro',
  };

  interface Offer {
    userId: number;
    text: string;
    callbacks: string[];
  }

  let events: EventRepository;
  let user: User;
  let addressCache: AddressCache;
  let candidates: InMemoryLocationCandidateStore;
  let verification: LocationVerificationService;
  let invitations: InvitationRepository;
  let invitationCards: string[];
  let offered: Promise<Offer>;
  let step: StepFn;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    user = users.create({ telegram_id: USER_ID, timezone: 'UTC' });
    users.create({ telegram_id: INVITEE_ID, timezone: 'UTC' });
    events = new EventRepository(db);
    const redis = new Map<string, string>();
    addressCache = new AddressCache({
      get: async (key) => redis.get(key) ?? null,
      set: async (key, value) => redis.set(key, value),
    });
    candidates = new InMemoryLocationCandidateStore();
    invitationCards = [];
    const offer = Promise.withResolvers<Offer>();
    offered = offer.promise;
    invitations = new InvitationRepository(db);
    verification = new LocationVerificationService({
      geocodingService: {
        findPlace: async () => [LONE_MATCH],
        geocodeAddress: async () => [],
        reverseGeocode: async () => null,
        locateArea: async () => null,
      },
      addressCache,
      eventRepo: events,
      userRepo: users,
      invitationRepo: invitations,
      agendaRepository: new AgendaRepository(db),
      candidateStore: candidates,
      sendMessage: async (userId, text, options) => {
        const markup = options?.reply_markup;
        const rows = markup && 'inline_keyboard' in markup ? markup.inline_keyboard : [];
        const callbacks = rows.flat().flatMap((button) => (button.callback_data ? [button.callback_data] : []));
        offer.resolve({ userId, text, callbacks });
      },
      editMessage: async (_chatId, _messageId, text) => {
        invitationCards.push(text);
      },
    });
    step = getStepFn(
      createEditValueScene(
        new EventService({ eventRepo: events }),
        createUserResolverComposer(userOnlyDb(users)),
        undefined,
        verification,
      ),
    );
  });

  /** An event whose place the user confirmed, with an invitation card delivered to the invitee. */
  function resolvedInvitedEvent(): CalendarEvent {
    const event = events.create({
      user_id: USER_ID,
      title: 'Dinner',
      start_at: '2026-10-05T17:00:00Z',
      end_at: '2026-10-05T18:00:00Z',
      timezone: 'UTC',
      location: 'seaside hotel',
    });
    events.updateLocationFields(event.id, OLD_PLACE);
    invitations.create({
      event_id: event.id,
      inviter_id: USER_ID,
      invitee_id: INVITEE_ID,
      message_id: INVITATION_MESSAGE_ID,
      chat_id: INVITEE_ID,
    });
    return event;
  }

  function locationCtx(eventId: number, text: string): EditCtx {
    return {
      lang: 'ru',
      dbUser: user,
      text,
      id: 40,
      scene: {
        params: { eventId, field: 'location', chatId: CHAT_ID, messageId: CARD_MESSAGE_ID },
        step: { id: 0 },
        exit: mock(() => Promise.resolve()),
      },
      send: mock(() => Promise.resolve()),
      bot: { api: { editMessageText: mock(() => Promise.resolve()) } },
      is: (type) => type === 'message',
    };
  }

  /** The `index|keep` choices of the picker, after checking they all answer one picker of the event. */
  function pickerChoices(offer: Offer, eventId: number): { pickerId: string; choices: string[] } {
    const parts = offer.callbacks.map((data) => data.split(':'));
    for (const [prefix, id] of parts) {
      expect(prefix).toBe('loc_cand');
      expect(id).toBe(String(eventId));
    }
    const pickerIds = new Set(parts.map((p) => p[2]));
    expect(pickerIds.size).toBe(1);
    return { pickerId: parts[0]?.[2] ?? '', choices: parts.map((p) => p[3] ?? '') };
  }

  const UNRESOLVED = {
    resolved_address: null,
    latitude: null,
    longitude: null,
    google_maps_url: null,
    location_verified: 0,
    venue_name: null,
  };

  test('a lone geocoding match is offered for confirmation, not applied', async () => {
    const event = resolvedInvitedEvent();
    await step(locationCtx(event.id, 'дома'), () => Promise.resolve());

    const offer = await offered;
    expect(offer.userId).toBe(USER_ID);
    expect(offer.text).toContain(LONE_MATCH.formattedAddress);
    expect(pickerChoices(offer, event.id).choices).toEqual(['0', 'keep']);
    expect((await candidates.get(event.id))?.candidates).toEqual([LONE_MATCH]);
    expect(events.findById(event.id, USER_ID)).toMatchObject({ location: 'дома', ...UNRESOLVED });
    expect(await addressCache.findMapping(USER_ID, 'дома')).toBeNull();
    // The invitation card shows the new text only: neither the dropped place nor the offered one
    expect(invitationCards).toHaveLength(1);
    expect(invitationCards[0]).toContain('дома');
    expect(invitationCards[0]).not.toContain(OLD_PLACE.venue_name);
    expect(invitationCards[0]).not.toContain(LONE_MATCH.formattedAddress);
  });

  test('a remembered place for the typed text is offered, not applied', async () => {
    await addressCache.recordMapping(USER_ID, 'дома', {
      resolvedAddress: LONE_MATCH.formattedAddress,
      googleMapsUrl: LONE_MATCH.googleMapsUrl,
      latitude: LONE_MATCH.latitude,
      longitude: LONE_MATCH.longitude,
      placeId: LONE_MATCH.placeId,
      venueName: LONE_MATCH.venueName,
    });
    const event = resolvedInvitedEvent();
    await step(locationCtx(event.id, 'дома'), () => Promise.resolve());

    const offer = await offered;
    expect(offer.text).toContain(LONE_MATCH.formattedAddress);
    expect(pickerChoices(offer, event.id).choices).toEqual(['0', 'keep']);
    expect(events.findById(event.id, USER_ID)).toMatchObject({ location: 'дома', ...UNRESOLVED });
    expect(invitationCards.every((card) => !card.includes(LONE_MATCH.formattedAddress))).toBe(true);
  });

  test('keeping the new text as typed leaves the invitation card on the new text, never on the old place', async () => {
    const event = resolvedInvitedEvent();
    await step(locationCtx(event.id, 'harbour cafe'), () => Promise.resolve());
    const { pickerId } = pickerChoices(await offered, event.id);

    expect(await verification.keepTypedLocation(event.id, USER_ID, pickerId)).not.toBeNull();

    expect(events.findById(event.id, USER_ID)).toMatchObject({ location: 'harbour cafe', ...UNRESOLVED });
    expect(invitationCards).toHaveLength(2);
    for (const card of invitationCards) {
      expect(card).toContain('harbour cafe');
      expect(card).not.toContain(OLD_PLACE.venue_name);
      expect(card).not.toContain('SYNTHETIC_OLD_PLACE');
    }
  });
});
