// test/services/location/pending-geo-store.test.ts
import { describe, expect, test } from 'bun:test';
import { InMemoryPendingGeoStore, RedisPendingGeoStore } from '../../../src/services/location/pending-geo-store.ts';

const VENUE = { title: 'Кофемания', address: 'Большая Никитская, 13', googlePlaceId: 'ChIJ-venue' };

describe('InMemoryPendingGeoStore', () => {
  test('set and get returns same coordinates', async () => {
    const store = new InMemoryPendingGeoStore();
    await store.set(100, { latitude: 55.75, longitude: 37.6, venue: null });
    const result = await store.get(100);
    expect(result).toEqual({ latitude: 55.75, longitude: 37.6, venue: null });
  });

  test('get returns null for unknown user', async () => {
    const store = new InMemoryPendingGeoStore();
    expect(await store.get(999)).toBeNull();
  });

  test('delete removes the entry', async () => {
    const store = new InMemoryPendingGeoStore();
    await store.set(100, { latitude: 1, longitude: 2, venue: null });
    await store.delete(100);
    expect(await store.get(100)).toBeNull();
  });

  test('expires after TTL', async () => {
    // Use very short TTL
    const store = new InMemoryPendingGeoStore(0.001); // 1ms
    await store.set(100, { latitude: 1, longitude: 2, venue: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.get(100)).toBeNull();
  });

  test('different users have independent entries', async () => {
    const store = new InMemoryPendingGeoStore();
    await store.set(1, { latitude: 1, longitude: 1, venue: null });
    await store.set(2, { latitude: 2, longitude: 2, venue: VENUE });
    expect((await store.get(1))?.latitude).toBe(1);
    expect((await store.get(2))?.venue).toEqual(VENUE);
  });

  test('overwrites existing entry', async () => {
    const store = new InMemoryPendingGeoStore();
    await store.set(100, { latitude: 1, longitude: 1, venue: VENUE });
    await store.set(100, { latitude: 5, longitude: 5, venue: null });
    expect(await store.get(100)).toEqual({ latitude: 5, longitude: 5, venue: null });
  });
});

describe('RedisPendingGeoStore', () => {
  function memoryRedis() {
    const data = new Map<string, string>();
    return {
      data,
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: string) => {
        data.set(key, value);
        return 'OK';
      },
      del: async (key: string) => (data.delete(key) ? 1 : 0),
    };
  }

  test('a Telegram venue survives the round trip with its name, address and place id', async () => {
    const store = new RedisPendingGeoStore(memoryRedis());
    await store.set(100, { latitude: 44.8, longitude: 20.4, venue: VENUE });
    expect(await store.get(100)).toEqual({ latitude: 44.8, longitude: 20.4, venue: VENUE });
  });

  test('a pin stored before venues were kept reads back as a plain pin', async () => {
    const redis = memoryRedis();
    redis.data.set('pending_geo:100', JSON.stringify({ latitude: 44.8, longitude: 20.4 }));
    const store = new RedisPendingGeoStore(redis);
    expect(await store.get(100)).toEqual({ latitude: 44.8, longitude: 20.4, venue: null });
  });
});
