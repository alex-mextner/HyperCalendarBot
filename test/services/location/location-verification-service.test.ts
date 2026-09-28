// test/services/location/location-verification-service.test.ts
import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import type { InlineKeyboard } from 'gramio';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CalendarEvent, InvitationStatus, User } from '../../../src/database/types.ts';
import type { GeocodedLocation } from '../../../src/services/location/geocoding-service.ts';
import {
  type LocationVerificationDeps,
  LocationVerificationService,
} from '../../../src/services/location/location-verification-service.ts';
import { groupRsvpKeyboard, invitationRsvpKeyboard } from '../../../src/services/sharing/invitation-rsvp-keyboard.ts';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    telegram_id: 100,
    username: 'testuser',
    first_name: 'Test',
    language: 'en',
    timezone: 'UTC',
    country_code: null,
    google_refresh_token_enc: null,
    google_calendar_id: null,
    onboarding_completed: 1,
    timezone_updated_at: null,
    voice_response_enabled: null,
    default_event_duration_minutes: 60,
    city: null,
    connect_telegram_dismissed_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    user_id: 100,
    title: 'Test Event',
    description: null,
    category: null,
    start_at: '2026-04-10T10:00:00Z',
    end_at: '2026-04-10T11:00:00Z',
    all_day: 0,
    timezone: 'UTC',
    location: 'Кофемания',
    recurrence_rule: null,
    recurrence_end_at: null,
    parent_event_id: null,
    original_start_at: null,
    is_cancelled: 0,
    is_deleted: 0,
    reminder_overrides: null,
    google_event_id: null,
    google_calendar_id: null,
    google_etag: null,
    sync_status: 'local_only',
    sync_version: 1,
    owner_type: 'user',
    group_id: null,
    created_by: null,
    resolved_address: null,
    latitude: null,
    longitude: null,
    google_maps_url: null,
    location_verified: 0,
    venue_name: null,
    last_synced_at: null,
    created_at: new Date().toISOString(),
    updated_at: '',
    ...overrides,
  };
}

function makeGeoResult(overrides: Partial<GeocodedLocation> = {}): GeocodedLocation {
  return {
    formattedAddress: 'Кофемания, ул. Большая Никитская, 12, Москва',
    latitude: 55.7558,
    longitude: 37.6173,
    city: 'Москва',
    country: 'Россия',
    placeId: 'ChIJ123',
    googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=55.7558,37.6173',
    venueName: null,
    ...overrides,
  };
}

/** Invitation repository stub: the event's rows and the per-row re-read agree by construction. */
function invitationRepoStub<T extends { id: number }>(invitations: T[]) {
  return {
    getByEvent: mock(() => invitations),
    findById: mock((id: number) => invitations.find((inv) => inv.id === id) ?? null),
  };
}

function makeDeps(overrides: { [key: string]: unknown } = {}) {
  return {
    geocodingService: {
      geocodeAddress: mock(() => Promise.resolve([])),
      reverseGeocode: mock(() => Promise.resolve(null)),
      findPlace: mock(() => Promise.resolve([])),
      locateArea: mock(() => Promise.resolve(null)),
    },
    addressCache: {
      findMapping: mock(() => Promise.resolve(null)),
      recordMapping: mock(() => Promise.resolve()),
      getRecent: mock(() => Promise.resolve([])),
      getFrequent: mock(() => Promise.resolve([])),
      getAddressContext: mock(() => Promise.resolve({ recent: [], frequent: [] })),
    },
    eventRepo: {
      findById: mock(() => makeEvent()),
      findByIdUnfiltered: mock(() => makeEvent()),
      updateLocationFields: mock(() => {}),
    },
    userRepo: {
      findByTelegramId: mock(() => makeUser()),
      update: mock(() => makeUser()),
    },
    invitationRepo: invitationRepoStub([]),
    db: {},
    candidateStore: {
      set: mock(() => Promise.resolve()),
      get: mock(() => Promise.resolve(null)),
      del: mock(() => Promise.resolve()),
    },
    sendMessage: mock(() => Promise.resolve()),
    editMessage: mock(() => Promise.resolve()),
    ...overrides,
  };
}

/** Partial repository mocks stand in for the real deps — the one centralized test cast. */
function makeService(deps: { [key: string]: unknown }): LocationVerificationService {
  return new LocationVerificationService(deps as unknown as LocationVerificationDeps);
}

type EditCall = [
  chatId: number,
  messageId: number,
  text: string,
  options: { parse_mode?: string; reply_markup?: InlineKeyboard },
];

function editCall(editMessage: { mock: { calls: unknown[][] } }, index: number): EditCall {
  return editMessage.mock.calls[index] as unknown as EditCall;
}

describe('LocationVerificationService', () => {
  test('returns early for events without location', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const result = await svc.verifyEventLocation(makeEvent({ location: null }), makeUser());

    expect(result.resolved).toBe(false);
    expect(deps.geocodingService.findPlace).not.toHaveBeenCalled();
  });

  test('asks user to choose when multiple candidates found', async () => {
    const candidates = [
      makeGeoResult({ formattedAddress: 'Option A' }),
      makeGeoResult({ formattedAddress: 'Option B' }),
    ];
    const deps = makeDeps({
      geocodingService: {
        findPlace: mock(() => Promise.resolve(candidates)),
        geocodeAddress: mock(() => Promise.resolve([])),
        reverseGeocode: mock(() => Promise.resolve(null)),
      },
    });
    const svc = makeService(deps);
    const result = await svc.verifyEventLocation(makeEvent(), makeUser());

    expect(result.resolved).toBe(false);
    expect(result.candidates.length).toBe(2);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.candidateStore.set).toHaveBeenCalledTimes(1);
  });

  test('resolveFromCoordinates applies reverse geocoded result', async () => {
    const geo = makeGeoResult();
    const deps = makeDeps({
      geocodingService: {
        reverseGeocode: mock(() => Promise.resolve(geo)),
        findPlace: mock(() => Promise.resolve([])),
        geocodeAddress: mock(() => Promise.resolve([])),
      },
    });
    const svc = makeService(deps);
    const success = await svc.resolveFromCoordinates(1, 55.7558, 37.6173, 100);

    expect(success).toBe(true);
    expect(deps.eventRepo.updateLocationFields).toHaveBeenCalledTimes(1);
  });

  test('resolveFromCoordinates returns false when reverse geocode fails', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const success = await svc.resolveFromCoordinates(1, 0, 0, 100);

    expect(success).toBe(false);
  });

  test('reverseGeocodeForCity delegates to geocoding service', async () => {
    const geo = makeGeoResult({ city: 'Белград' });
    const deps = makeDeps({
      geocodingService: {
        reverseGeocode: mock(() => Promise.resolve(geo)),
        findPlace: mock(() => Promise.resolve([])),
        geocodeAddress: mock(() => Promise.resolve([])),
      },
    });
    const svc = makeService(deps);
    const result = await svc.reverseGeocodeForCity(44.8, 20.45);

    expect(result).toEqual({ city: 'Белград' });
  });

  test('reverseGeocodeForCity returns null when no city', async () => {
    const deps = makeDeps();
    const svc = makeService(deps);
    const result = await svc.reverseGeocodeForCity(0, 0);

    expect(result).toBeNull();
  });

  describe('updateInvitationMessages (via applyResolvedLocation)', () => {
    function makeInvitation(overrides: { [key: string]: unknown } = {}) {
      return {
        id: 1,
        event_id: 1,
        inviter_id: 100,
        invitee_id: 200,
        status: 'pending',
        message_id: 555,
        chat_id: 200,
        deep_link_code: null,
        invitee_username: null,
        created_at: '',
        updated_at: '',
        responded_at: null,
        proposed_time: null,
        ...overrides,
      };
    }

    test('pending invitation edit keeps the RSVP keyboard in the invitee language', async () => {
      const pendingInv = makeInvitation({ id: 128, status: 'pending', message_id: 111, chat_id: 200 });
      const ruInvitee = makeUser({ telegram_id: 200, language: 'ru' });
      const deps = makeDeps({
        invitationRepo: invitationRepoStub([pendingInv]),
        userRepo: {
          findByTelegramId: mock((id: number) => (id === 200 ? ruInvitee : makeUser())),
          update: mock(() => makeUser()),
        },
      });

      await makeService(deps).applyResolvedLocation(makeEvent(), makeGeoResult());

      expect(deps.editMessage).toHaveBeenCalledTimes(1);
      const [chatId, messageId, , options] = editCall(deps.editMessage, 0);
      expect(chatId).toBe(200);
      expect(messageId).toBe(111);
      expect(options.parse_mode).toBe('HTML');
      expect(options.reply_markup?.toJSON()).toEqual(invitationRsvpKeyboard(128, 'ru').toJSON());
    });

    /** Real repositories on an in-memory DB: inviter 100, an event, and delivered invitations. */
    function seedDeliveredInvitations() {
      const db = new Database(':memory:');
      runMigrations(db, migrations);
      const userRepo = new UserRepository(db);
      const eventRepo = new EventRepository(db);
      const invitationRepo = new InvitationRepository(db);
      for (const telegramId of [100, 201, 202, 203, 204, 205]) userRepo.create({ telegram_id: telegramId });
      const event = eventRepo.create({
        user_id: 100,
        title: 'Meeting',
        start_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        timezone: 'Europe/Belgrade',
        location: 'Cafe',
      });
      const deliver = (inviteeId: number, messageId: number, status: InvitationStatus) => {
        const inv = invitationRepo.create({ event_id: event.id, inviter_id: 100, invitee_id: inviteeId });
        invitationRepo.setMessageInfo(inv.id, messageId, inviteeId);
        if (status !== 'pending') invitationRepo.updateStatus(inv.id, status, 'pending');
        return inv.id;
      };
      const deps = makeDeps({ userRepo, eventRepo, invitationRepo, agendaRepository: new AgendaRepository(db) });
      return { event, eventRepo, invitationRepo, deliver, deps };
    }

    function editsByMessageId(editMessage: { mock: { calls: unknown[][] } }): Map<number, EditCall> {
      return new Map(
        editMessage.mock.calls.map((_call, i): [number, EditCall] => {
          const call = editCall(editMessage, i);
          return [call[1], call];
        }),
      );
    }

    const RESOLVED_ADDRESS = 'Кофемания, ул. Большая Никитская, 12';

    test('answered cards keep their answer and show the resolved location, without buttons', async () => {
      const { event, eventRepo, deliver, deps } = seedDeliveredInvitations();
      const pendingId = deliver(201, 111, 'pending');
      deliver(202, 222, 'maybe');
      deliver(203, 333, 'accepted');
      deliver(204, 444, 'declined');
      deliver(205, 666, 'cancelled');

      await makeService(deps).applyResolvedLocation(event, makeGeoResult());

      const edits = editsByMessageId(deps.editMessage);
      expect([...edits.keys()].sort()).toEqual([111, 222, 333, 444]);
      const [, , pendingText, pendingOptions] = edits.get(111)!;
      expect(pendingText).toContain(RESOLVED_ADDRESS);
      expect(pendingOptions.reply_markup?.toJSON()).toEqual(invitationRsvpKeyboard(pendingId, 'en').toJSON());
      for (const [messageId, chatId, label] of [
        [222, 202, t('en').invitation_maybe],
        [333, 203, t('en').invitation_accepted],
        [444, 204, t('en').invitation_declined],
      ] as const) {
        const [editedChatId, , text, options] = edits.get(messageId)!;
        expect(editedChatId).toBe(chatId);
        expect(text.startsWith(`${label}\n\n📌 <b>Meeting</b>`)).toBe(true);
        expect(text).toContain(RESOLVED_ADDRESS);
        expect(options).toEqual({ parse_mode: 'HTML' });
      }
      expect(eventRepo.findById(event.id, 100)?.location_verified).toBe(1);
    });

    test('a group invitation keeps its Going/Not going keyboard; revoked group cards stay untouched', async () => {
      const { event, deliver, deps } = seedDeliveredInvitations();
      const groupChatId = -1001234567890;
      deliver(groupChatId, 555, 'pending');
      deliver(-1001, 777, 'cancelled');
      deliver(-1002, 888, 'expired');

      await makeService(deps).applyResolvedLocation(event, makeGeoResult());

      expect(deps.editMessage).toHaveBeenCalledTimes(1);
      const [chatId, messageId, text, options] = editCall(deps.editMessage, 0);
      expect([chatId, messageId]).toEqual([groupChatId, 555]);
      expect(text).toContain(RESOLVED_ADDRESS);
      expect(options.reply_markup?.toJSON()).toEqual(groupRsvpKeyboard(event.id, 'en').toJSON());
    });

    test('an invitation answered while earlier cards are being edited keeps the answered card', async () => {
      const { event, invitationRepo, deliver, deps } = seedDeliveredInvitations();
      deliver(201, 111, 'pending');
      const answeredMeanwhile = deliver(202, 222, 'pending');
      // The invitee taps Accept while the first card's edit is in flight; the RSVP callback has
      // already rewritten their card, so the location edit must not restore the invite + buttons.
      deps.editMessage.mockImplementationOnce(async () => {
        invitationRepo.updateStatus(answeredMeanwhile, 'accepted', 'pending');
      });

      await makeService(deps).applyResolvedLocation(event, makeGeoResult());

      expect([...editsByMessageId(deps.editMessage).keys()]).toEqual([111]);
    });

    test('a pending invitee who proposed another time keeps their card, also when proposing mid-edit', async () => {
      const { event, invitationRepo, deliver, deps } = seedDeliveredInvitations();
      deliver(201, 111, 'pending');
      // A free-text proposal replaced this card with "proposal sent" and no buttons; the inviter's
      // reschedule/keep answer is what settles it, so the location edit must not hand back RSVP buttons.
      invitationRepo.setProposedTime(deliver(202, 222, 'pending'), '2026-10-01T18:00:00Z');
      const proposesMeanwhile = deliver(203, 333, 'pending');
      deps.editMessage.mockImplementationOnce(async () => {
        invitationRepo.setProposedTime(proposesMeanwhile, '2026-10-01T19:00:00Z');
      });

      await makeService(deps).applyResolvedLocation(event, makeGeoResult());

      expect([...editsByMessageId(deps.editMessage).keys()]).toEqual([111]);
    });

    test('skips invitations with no message_id (not yet delivered)', async () => {
      const undelivered = makeInvitation({ id: 1, message_id: null, chat_id: null });
      const delivered = makeInvitation({ id: 2, message_id: 999, chat_id: 200 });
      const deps = makeDeps({
        invitationRepo: invitationRepoStub([undelivered, delivered]),
      });
      const svc = makeService(deps);

      await svc.applyResolvedLocation(makeEvent(), makeGeoResult());

      expect(deps.editMessage).toHaveBeenCalledTimes(1);
      expect((deps.editMessage.mock.calls[0] as unknown[])[1]).toBe(999);
    });

    test('does nothing when editMessage callback is not provided', async () => {
      const pendingInv = makeInvitation({ message_id: 555, chat_id: 200 });
      const deps = makeDeps({
        editMessage: undefined,
        invitationRepo: invitationRepoStub([pendingInv]),
      });
      const svc = makeService(deps);

      await svc.applyResolvedLocation(makeEvent(), makeGeoResult());

      // No editMessage to call — the invitations should not even be queried
      expect(deps.invitationRepo.getByEvent).not.toHaveBeenCalled();
    });

    test('continues processing other invitations when one edit fails', async () => {
      const inv1 = makeInvitation({ id: 1, message_id: 111, chat_id: 200 });
      const inv2 = makeInvitation({ id: 2, message_id: 222, chat_id: 300 });
      const editMessage = mock((chatId: number) => {
        if (chatId === 200) throw new Error('Telegram API error');
        return Promise.resolve();
      });
      const deps = makeDeps({
        editMessage,
        invitationRepo: invitationRepoStub([inv1, inv2]),
      });
      const svc = makeService(deps);

      await svc.applyResolvedLocation(makeEvent(), makeGeoResult());

      // Both attempted despite first failure
      expect(deps.editMessage).toHaveBeenCalledTimes(2);
    });

    test('uses invitee language for the formatted invitation', async () => {
      const inv = makeInvitation({ id: 1, message_id: 111, chat_id: 200 });
      const ruInvitee = makeUser({ telegram_id: 200, language: 'ru' });
      const inviter = makeUser({ telegram_id: 100, first_name: 'Alice' });
      const deps = makeDeps({
        invitationRepo: invitationRepoStub([inv]),
        userRepo: {
          findByTelegramId: mock((id: number) => (id === 200 ? ruInvitee : inviter)),
          update: mock(() => makeUser()),
        },
      });
      const svc = makeService(deps);

      await svc.applyResolvedLocation(makeEvent({ title: 'Встреча' }), makeGeoResult());

      const call = deps.editMessage.mock.calls[0] as unknown[];
      const text = call[2] as string;
      // Russian invitation header with front-loaded event title
      expect(text).toContain('приглашение от');
      expect(text).toContain('Встреча');
    });

    test('updated event passed to formatter has the new resolved address', async () => {
      const inv = makeInvitation({ id: 1, message_id: 111, chat_id: 200 });
      const deps = makeDeps({
        invitationRepo: invitationRepoStub([inv]),
      });
      const svc = makeService(deps);

      const geo = makeGeoResult({
        formattedAddress: 'Кофемания, ул. Большая Никитская, 12',
        googleMapsUrl: 'https://maps.google.com/?q=55.75,37.6',
      });
      await svc.applyResolvedLocation(makeEvent({ location: 'кофемания' }), geo);

      const call = deps.editMessage.mock.calls[0] as unknown[];
      const text = call[2] as string;
      // The formatted invitation should embed the resolved address as a link
      expect(text).toContain('Кофемания, ул. Большая Никитская, 12');
      expect(text).toContain('https://maps.google.com');
    });

    test('re-rendered invitation keeps the full time range in both zones', async () => {
      const inv = makeInvitation({ id: 1, message_id: 111, chat_id: 200 });
      const invitee = makeUser({ telegram_id: 200, timezone: 'Europe/London' });
      const inviter = makeUser({ telegram_id: 100, first_name: 'Alice' });
      const deps = makeDeps({
        invitationRepo: invitationRepoStub([inv]),
        userRepo: {
          findByTelegramId: mock((id: number) => (id === 200 ? invitee : inviter)),
          update: mock(() => makeUser()),
        },
      });
      const svc = makeService(deps);

      const event = makeEvent({
        start_at: '2026-09-27T13:00:00Z',
        end_at: '2026-09-27T14:00:00Z',
        timezone: 'Europe/Belgrade',
      });
      await svc.applyResolvedLocation(event, makeGeoResult());

      const text = (deps.editMessage.mock.calls[0] as unknown[])[2] as string;
      expect(text).toContain('🕐 Sun 27, 15:00–16:00 (Europe/Belgrade) / 14:00–15:00 (Europe/London) (1h)');
    });
  });
});
