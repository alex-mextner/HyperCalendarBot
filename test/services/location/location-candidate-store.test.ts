// test/services/location/location-candidate-store.test.ts
import { describe, expect, setSystemTime, test } from 'bun:test';
import type { GeocodedLocation } from '../../../src/services/location/geocoding-service.ts';
import {
  InMemoryLocationCandidateStore,
  type LocationPicker,
  RedisLocationCandidateStore,
} from '../../../src/services/location/location-candidate-store.ts';

function makeGeoResult(overrides: Partial<GeocodedLocation> = {}): GeocodedLocation {
  return {
    formattedAddress: 'Test Address',
    latitude: 55.75,
    longitude: 37.6,
    city: 'Москва',
    country: 'Россия',
    placeId: 'test_id',
    googleMapsUrl: 'https://maps.google.com/test',
    venueName: null,
    ...overrides,
  };
}

/** An open picker of `candidates` for the typed text "Test location". */
function openPicker(id: string, candidates: GeocodedLocation[]): LocationPicker {
  return { id, location: 'Test location', candidates, placeDropped: false };
}

describe('InMemoryLocationCandidateStore', () => {
  test('set and get return the same picker', async () => {
    const store = new InMemoryLocationCandidateStore();
    const candidates = [makeGeoResult({ formattedAddress: 'A' }), makeGeoResult({ formattedAddress: 'B' })];
    await store.set(42, openPicker('abcd1234', candidates));

    expect(await store.get(42)).toEqual(openPicker('abcd1234', candidates));
  });

  test('a new picker replaces the previous one of the event', async () => {
    const store = new InMemoryLocationCandidateStore();
    await store.set(42, openPicker('first000', [makeGeoResult({ formattedAddress: 'A' })]));
    await store.set(42, openPicker('second00', [makeGeoResult({ formattedAddress: 'B' })]));

    expect((await store.get(42))?.id).toBe('second00');
  });

  test('get returns null for unknown event', async () => {
    const store = new InMemoryLocationCandidateStore();
    expect(await store.get(999)).toBeNull();
  });

  test('del removes entry', async () => {
    const store = new InMemoryLocationCandidateStore();
    await store.set(42, openPicker('abcd1234', [makeGeoResult()]));
    await store.del(42);
    expect(await store.get(42)).toBeNull();
  });

  test('expires after TTL', async () => {
    const store = new InMemoryLocationCandidateStore(60);
    await store.set(42, openPicker('abcd1234', [makeGeoResult()]));
    setSystemTime(new Date(Date.now() + 61_000));
    try {
      expect(await store.get(42)).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test('different events independent', async () => {
    const store = new InMemoryLocationCandidateStore();
    await store.set(1, openPicker('one00000', [makeGeoResult({ formattedAddress: 'Event 1' })]));
    await store.set(2, openPicker('two00000', [makeGeoResult({ formattedAddress: 'Event 2' })]));
    expect((await store.get(1))?.candidates[0]?.formattedAddress).toBe('Event 1');
    expect((await store.get(2))?.candidates[0]?.formattedAddress).toBe('Event 2');
  });
});

describe('InMemoryLocationCandidateStore.take', () => {
  test('answers the open picker once, and only with its id', async () => {
    const store = new InMemoryLocationCandidateStore();
    const picker = openPicker('abcd1234', [makeGeoResult()]);
    await store.set(42, picker);

    expect(await store.take(42, 'ffff0000')).toBeNull();
    expect(await store.take(42, 'abcd1234')).toEqual(picker);
    expect(await store.take(42, 'abcd1234')).toBeNull();
  });

  test('of two concurrent takes only one gets the picker', async () => {
    const store = new InMemoryLocationCandidateStore();
    await store.set(42, openPicker('abcd1234', [makeGeoResult()]));

    const results = await Promise.all([store.take(42, 'abcd1234'), store.take(42, 'abcd1234')]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  test('a take for an older picker leaves the newer one open', async () => {
    const store = new InMemoryLocationCandidateStore();
    await store.set(42, openPicker('first000', [makeGeoResult({ formattedAddress: 'A' })]));
    await store.set(42, openPicker('second00', [makeGeoResult({ formattedAddress: 'B' })]));

    expect(await store.take(42, 'first000')).toBeNull();
    expect((await store.get(42))?.id).toBe('second00');
  });
});

describe('RedisLocationCandidateStore', () => {
  test('keeps an open picker for weeks', async () => {
    const writes: { key: string; value: string; ex: number | undefined }[] = [];
    const store = new RedisLocationCandidateStore({
      set: async (key, value, opts) => {
        writes.push({ key, value, ex: opts?.ex });
        return 'OK';
      },
      del: async () => 0,
      eval: async () => null,
    });
    const picker = openPicker('abcd1234', [makeGeoResult()]);

    await store.set(7, picker);

    expect(writes).toHaveLength(1);
    expect(writes[0]!.value).toBe(JSON.stringify(picker));
    expect(writes[0]!.ex).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
  });
});
