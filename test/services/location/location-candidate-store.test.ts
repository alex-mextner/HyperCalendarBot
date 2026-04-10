// test/services/location/location-candidate-store.test.ts
import { describe, expect, test } from 'bun:test';
import type { GeocodedLocation } from '../../../src/services/location/geocoding-service.ts';
import { InMemoryLocationCandidateStore } from '../../../src/services/location/location-candidate-store.ts';

function makeGeoResult(overrides: Partial<GeocodedLocation> = {}): GeocodedLocation {
  return {
    formattedAddress: 'Test Address',
    latitude: 55.75,
    longitude: 37.6,
    city: 'Москва',
    country: 'Россия',
    placeId: 'test_id',
    googleMapsUrl: 'https://maps.google.com/test',
    ...overrides,
  };
}

describe('InMemoryLocationCandidateStore', () => {
  test('set and get returns same candidates', async () => {
    const store = new InMemoryLocationCandidateStore();
    const candidates = [makeGeoResult({ formattedAddress: 'A' }), makeGeoResult({ formattedAddress: 'B' })];
    await store.set(42, candidates);

    const result = await store.get(42);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0]!.formattedAddress).toBe('A');
    expect(result![1]!.formattedAddress).toBe('B');
  });

  test('get returns null for unknown event', async () => {
    const store = new InMemoryLocationCandidateStore();
    expect(await store.get(999)).toBeNull();
  });

  test('del removes entry', async () => {
    const store = new InMemoryLocationCandidateStore();
    await store.set(42, [makeGeoResult()]);
    await store.del(42);
    expect(await store.get(42)).toBeNull();
  });

  test('expires after TTL', async () => {
    const store = new InMemoryLocationCandidateStore(0.001);
    await store.set(42, [makeGeoResult()]);
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.get(42)).toBeNull();
  });

  test('different events independent', async () => {
    const store = new InMemoryLocationCandidateStore();
    await store.set(1, [makeGeoResult({ formattedAddress: 'Event 1' })]);
    await store.set(2, [makeGeoResult({ formattedAddress: 'Event 2' })]);
    expect((await store.get(1))![0]!.formattedAddress).toBe('Event 1');
    expect((await store.get(2))![0]!.formattedAddress).toBe('Event 2');
  });
});
