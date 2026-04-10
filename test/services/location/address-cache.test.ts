// test/services/location/address-cache.test.ts
import { describe, expect, test } from 'bun:test';
import { AddressCache } from '../../../src/services/location/address-cache.ts';

function makeInMemoryRedis(): {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
} {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('AddressCache', () => {
  test('recordMapping and findMapping — exact match', async () => {
    const cache = new AddressCache(makeInMemoryRedis());
    await cache.recordMapping(1, 'Кофемания', {
      resolvedAddress: 'Кофемания, ул. Большая Никитская, 12, Москва',
      googleMapsUrl: 'https://maps.google.com/?q=1,2',
      latitude: 55.75,
      longitude: 37.6,
      placeId: 'abc123',
    });

    const result = await cache.findMapping(1, 'Кофемания');
    expect(result).not.toBeNull();
    expect(result!.resolvedAddress).toBe('Кофемания, ул. Большая Никитская, 12, Москва');
    expect(result!.latitude).toBe(55.75);
  });

  test('findMapping — case insensitive', async () => {
    const cache = new AddressCache(makeInMemoryRedis());
    await cache.recordMapping(1, 'Coffee Shop', {
      resolvedAddress: 'Coffee Shop, Main St',
      googleMapsUrl: 'https://maps.google.com/?q=1,2',
      latitude: 40.0,
      longitude: -74.0,
      placeId: null,
    });

    const result = await cache.findMapping(1, 'coffee shop');
    expect(result).not.toBeNull();
    expect(result!.resolvedAddress).toBe('Coffee Shop, Main St');
  });

  test('findMapping — returns null for no match', async () => {
    const cache = new AddressCache(makeInMemoryRedis());
    const result = await cache.findMapping(1, 'nonexistent');
    expect(result).toBeNull();
  });

  test('findMapping — fuzzy word match', async () => {
    const cache = new AddressCache(makeInMemoryRedis());
    await cache.recordMapping(1, 'Красная Площадь Москва', {
      resolvedAddress: 'Red Square, Moscow, Russia',
      googleMapsUrl: 'https://maps.google.com/?q=1,2',
      latitude: 55.7539,
      longitude: 37.6208,
      placeId: null,
    });

    // Should match on word overlap
    const result = await cache.findMapping(1, 'площадь Москва');
    expect(result).not.toBeNull();
    expect(result!.resolvedAddress).toBe('Red Square, Moscow, Russia');
  });

  test('getRecent returns most recent first', async () => {
    const cache = new AddressCache(makeInMemoryRedis());

    await cache.recordMapping(1, 'Place A', {
      resolvedAddress: 'A Addr',
      googleMapsUrl: 'https://a',
      latitude: 1,
      longitude: 1,
      placeId: null,
    });

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    await cache.recordMapping(1, 'Place B', {
      resolvedAddress: 'B Addr',
      googleMapsUrl: 'https://b',
      latitude: 2,
      longitude: 2,
      placeId: null,
    });

    const recent = await cache.getRecent(1, 10);
    expect(recent.length).toBe(2);
    expect(recent[0]!.resolvedAddress).toBe('B Addr');
    expect(recent[1]!.resolvedAddress).toBe('A Addr');
  });

  test('getFrequent counts multiple usages', async () => {
    const cache = new AddressCache(makeInMemoryRedis());
    const mapping = {
      resolvedAddress: 'Office',
      googleMapsUrl: 'https://office',
      latitude: 1,
      longitude: 1,
      placeId: null,
    };

    await cache.recordMapping(1, 'офис', mapping);
    await cache.recordMapping(1, 'office', mapping);
    await cache.recordMapping(1, 'Офис!', mapping);

    const frequent = await cache.getFrequent(1, 10);
    expect(frequent.length).toBe(1);
    expect(frequent[0]!.resolvedAddress).toBe('Office');
    expect(frequent[0]!.count).toBe(3);
  });

  test('different users have separate caches', async () => {
    const cache = new AddressCache(makeInMemoryRedis());
    await cache.recordMapping(1, 'Place', {
      resolvedAddress: 'User 1 Place',
      googleMapsUrl: 'https://1',
      latitude: 1,
      longitude: 1,
      placeId: null,
    });

    const resultUser1 = await cache.findMapping(1, 'Place');
    const resultUser2 = await cache.findMapping(2, 'Place');

    expect(resultUser1).not.toBeNull();
    expect(resultUser2).toBeNull();
  });

  test('getAddressContext returns both recent and frequent', async () => {
    const cache = new AddressCache(makeInMemoryRedis());
    await cache.recordMapping(1, 'Office', {
      resolvedAddress: 'Main Office',
      googleMapsUrl: 'https://office',
      latitude: 1,
      longitude: 1,
      placeId: null,
    });

    const ctx = await cache.getAddressContext(1);
    expect(ctx.recent.length).toBe(1);
    expect(ctx.frequent.length).toBe(1);
  });
});
