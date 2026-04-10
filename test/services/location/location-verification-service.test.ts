// test/services/location/location-verification-service.test.ts
import { describe, expect, mock, test } from 'bun:test';
import type { CalendarEvent, User } from '../../../src/database/types.ts';
import type { GeocodedLocation } from '../../../src/services/location/geocoding-service.ts';
import { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';

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
    assistant_enabled: 0,
    city: null,
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

function makeDeps(overrides: { [key: string]: unknown } = {}) {
  return {
    geocodingService: {
      geocodeAddress: mock(() => Promise.resolve([])),
      reverseGeocode: mock(() => Promise.resolve(null)),
      findPlace: mock(() => Promise.resolve([])),
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
      updateLocationFields: mock(() => {}),
    },
    userRepo: {
      findByTelegramId: mock(() => makeUser()),
      update: mock(() => makeUser()),
    },
    invitationRepo: {
      getPendingForEvent: mock(() => []),
      getAcceptedForEvent: mock(() => []),
    },
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

describe('LocationVerificationService', () => {
  test('returns early for events without location', async () => {
    const deps = makeDeps();
    const svc = new LocationVerificationService(deps as never);
    const result = await svc.verifyEventLocation(makeEvent({ location: null }), makeUser());

    expect(result.resolved).toBe(false);
    expect(deps.geocodingService.findPlace).not.toHaveBeenCalled();
  });

  test('uses cached mapping when available', async () => {
    const cached = {
      input: 'Кофемания',
      resolvedAddress: 'Cached Address',
      googleMapsUrl: 'https://cached',
      latitude: 55.0,
      longitude: 37.0,
      placeId: 'cached_id',
      timestamp: Date.now(),
    };
    const deps = makeDeps({
      addressCache: {
        findMapping: mock(() => Promise.resolve(cached)),
        recordMapping: mock(() => Promise.resolve()),
        getRecent: mock(() => Promise.resolve([])),
        getFrequent: mock(() => Promise.resolve([])),
        getAddressContext: mock(() => Promise.resolve({ recent: [], frequent: [] })),
      },
    });
    const svc = new LocationVerificationService(deps as never);
    const result = await svc.verifyEventLocation(makeEvent(), makeUser());

    expect(result.resolved).toBe(true);
    expect(result.geocoded!.formattedAddress).toBe('Cached Address');
    expect(deps.eventRepo.updateLocationFields).toHaveBeenCalledTimes(1);
    // Should NOT call geocoding API when cache hit
    expect(deps.geocodingService.findPlace).not.toHaveBeenCalled();
  });

  test('auto-resolves single geocoding result', async () => {
    const geo = makeGeoResult();
    const deps = makeDeps({
      geocodingService: {
        findPlace: mock(() => Promise.resolve([geo])),
        geocodeAddress: mock(() => Promise.resolve([geo])),
        reverseGeocode: mock(() => Promise.resolve(geo)),
      },
    });
    const svc = new LocationVerificationService(deps as never);
    const result = await svc.verifyEventLocation(makeEvent(), makeUser());

    expect(result.resolved).toBe(true);
    expect(result.geocoded!.city).toBe('Москва');
    expect(deps.eventRepo.updateLocationFields).toHaveBeenCalledTimes(1);
    expect(deps.addressCache.recordMapping).toHaveBeenCalledTimes(1);
  });

  test('sets user city when not already set', async () => {
    const geo = makeGeoResult({ city: 'Москва' });
    const deps = makeDeps({
      geocodingService: {
        findPlace: mock(() => Promise.resolve([geo])),
        geocodeAddress: mock(() => Promise.resolve([])),
        reverseGeocode: mock(() => Promise.resolve(null)),
      },
    });
    const svc = new LocationVerificationService(deps as never);
    await svc.verifyEventLocation(makeEvent(), makeUser({ city: null }));

    expect(deps.userRepo.update).toHaveBeenCalledWith(100, { city: 'Москва' });
  });

  test('does NOT overwrite existing user city', async () => {
    const geo = makeGeoResult({ city: 'Санкт-Петербург' });
    const deps = makeDeps({
      geocodingService: {
        findPlace: mock(() => Promise.resolve([geo])),
        geocodeAddress: mock(() => Promise.resolve([])),
        reverseGeocode: mock(() => Promise.resolve(null)),
      },
    });
    const svc = new LocationVerificationService(deps as never);
    await svc.verifyEventLocation(makeEvent(), makeUser({ city: 'Москва' }));

    expect(deps.userRepo.update).not.toHaveBeenCalled();
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
    const svc = new LocationVerificationService(deps as never);
    const result = await svc.verifyEventLocation(makeEvent(), makeUser());

    expect(result.resolved).toBe(false);
    expect(result.candidates.length).toBe(2);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.candidateStore.set).toHaveBeenCalledTimes(1);
  });

  test('handleLocationChoice applies chosen candidate', async () => {
    const candidates = [makeGeoResult({ formattedAddress: 'Chosen' })];
    const deps = makeDeps();
    const svc = new LocationVerificationService(deps as never);
    const success = await svc.handleLocationChoice(1, 100, 0, candidates);

    expect(success).toBe(true);
    expect(deps.eventRepo.updateLocationFields).toHaveBeenCalledTimes(1);
    expect(deps.candidateStore.del).toHaveBeenCalledTimes(1);
  });

  test('handleLocationChoice returns false for invalid index', async () => {
    const deps = makeDeps();
    const svc = new LocationVerificationService(deps as never);
    const success = await svc.handleLocationChoice(1, 100, 5, [makeGeoResult()]);

    expect(success).toBe(false);
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
    const svc = new LocationVerificationService(deps as never);
    const success = await svc.resolveFromCoordinates(1, 55.7558, 37.6173, 100);

    expect(success).toBe(true);
    expect(deps.eventRepo.updateLocationFields).toHaveBeenCalledTimes(1);
  });

  test('resolveFromCoordinates returns false when reverse geocode fails', async () => {
    const deps = makeDeps();
    const svc = new LocationVerificationService(deps as never);
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
    const svc = new LocationVerificationService(deps as never);
    const result = await svc.reverseGeocodeForCity(44.8, 20.45);

    expect(result).toEqual({ city: 'Белград' });
  });

  test('reverseGeocodeForCity returns null when no city', async () => {
    const deps = makeDeps();
    const svc = new LocationVerificationService(deps as never);
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

    test('edits both pending and accepted invitation messages', async () => {
      const pendingInv = makeInvitation({ id: 1, status: 'pending', message_id: 111, chat_id: 200 });
      const acceptedInv = makeInvitation({ id: 2, status: 'accepted', message_id: 222, chat_id: 300 });
      const deps = makeDeps({
        invitationRepo: {
          getPendingForEvent: mock(() => [pendingInv]),
          getAcceptedForEvent: mock(() => [acceptedInv]),
        },
      });
      const svc = new LocationVerificationService(deps as never);

      await svc.applyResolvedLocation(makeEvent(), makeGeoResult());

      expect(deps.editMessage).toHaveBeenCalledTimes(2);
      // First call: pending invitation
      const firstCall = deps.editMessage.mock.calls[0] as unknown[];
      expect(firstCall[0]).toBe(200); // chat_id
      expect(firstCall[1]).toBe(111); // message_id
      expect(firstCall[3]).toBe('HTML'); // parse mode
      // Second call: accepted invitation
      const secondCall = deps.editMessage.mock.calls[1] as unknown[];
      expect(secondCall[0]).toBe(300);
      expect(secondCall[1]).toBe(222);
    });

    test('skips invitations with no message_id (not yet delivered)', async () => {
      const undelivered = makeInvitation({ id: 1, message_id: null, chat_id: null });
      const delivered = makeInvitation({ id: 2, message_id: 999, chat_id: 200 });
      const deps = makeDeps({
        invitationRepo: {
          getPendingForEvent: mock(() => [undelivered, delivered]),
          getAcceptedForEvent: mock(() => []),
        },
      });
      const svc = new LocationVerificationService(deps as never);

      await svc.applyResolvedLocation(makeEvent(), makeGeoResult());

      expect(deps.editMessage).toHaveBeenCalledTimes(1);
      expect((deps.editMessage.mock.calls[0] as unknown[])[1]).toBe(999);
    });

    test('does nothing when editMessage callback is not provided', async () => {
      const pendingInv = makeInvitation({ message_id: 555, chat_id: 200 });
      const deps = makeDeps({
        editMessage: undefined,
        invitationRepo: {
          getPendingForEvent: mock(() => [pendingInv]),
          getAcceptedForEvent: mock(() => []),
        },
      });
      const svc = new LocationVerificationService(deps as never);

      await svc.applyResolvedLocation(makeEvent(), makeGeoResult());

      // No editMessage to call — getPendingForEvent should not even be queried
      expect(deps.invitationRepo.getPendingForEvent).not.toHaveBeenCalled();
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
        invitationRepo: {
          getPendingForEvent: mock(() => [inv1, inv2]),
          getAcceptedForEvent: mock(() => []),
        },
      });
      const svc = new LocationVerificationService(deps as never);

      await svc.applyResolvedLocation(makeEvent(), makeGeoResult());

      // Both attempted despite first failure
      expect(deps.editMessage).toHaveBeenCalledTimes(2);
    });

    test('uses invitee language for the formatted invitation', async () => {
      const inv = makeInvitation({ id: 1, message_id: 111, chat_id: 200 });
      const ruInvitee = makeUser({ telegram_id: 200, language: 'ru' });
      const inviter = makeUser({ telegram_id: 100, first_name: 'Alice' });
      const deps = makeDeps({
        invitationRepo: {
          getPendingForEvent: mock(() => [inv]),
          getAcceptedForEvent: mock(() => []),
        },
        userRepo: {
          findByTelegramId: mock((id: number) => (id === 200 ? ruInvitee : inviter)),
          update: mock(() => makeUser()),
        },
      });
      const svc = new LocationVerificationService(deps as never);

      await svc.applyResolvedLocation(makeEvent({ title: 'Встреча' }), makeGeoResult());

      const call = deps.editMessage.mock.calls[0] as unknown[];
      const text = call[2] as string;
      // Russian invitation header
      expect(text).toContain('Приглашение');
    });

    test('updated event passed to formatter has the new resolved address', async () => {
      const inv = makeInvitation({ id: 1, message_id: 111, chat_id: 200 });
      const deps = makeDeps({
        invitationRepo: {
          getPendingForEvent: mock(() => [inv]),
          getAcceptedForEvent: mock(() => []),
        },
      });
      const svc = new LocationVerificationService(deps as never);

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
  });
});
