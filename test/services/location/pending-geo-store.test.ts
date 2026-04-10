// test/services/location/pending-geo-store.test.ts
import { describe, expect, test } from 'bun:test';
import { InMemoryPendingGeoStore } from '../../../src/services/location/pending-geo-store.ts';

describe('InMemoryPendingGeoStore', () => {
  test('set and get returns same coordinates', async () => {
    const store = new InMemoryPendingGeoStore();
    await store.set(100, { latitude: 55.75, longitude: 37.6 });
    const result = await store.get(100);
    expect(result).toEqual({ latitude: 55.75, longitude: 37.6 });
  });

  test('get returns null for unknown user', async () => {
    const store = new InMemoryPendingGeoStore();
    expect(await store.get(999)).toBeNull();
  });

  test('delete removes the entry', async () => {
    const store = new InMemoryPendingGeoStore();
    await store.set(100, { latitude: 1, longitude: 2 });
    await store.delete(100);
    expect(await store.get(100)).toBeNull();
  });

  test('expires after TTL', async () => {
    // Use very short TTL
    const store = new InMemoryPendingGeoStore(0.001); // 1ms
    await store.set(100, { latitude: 1, longitude: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.get(100)).toBeNull();
  });

  test('different users have independent entries', async () => {
    const store = new InMemoryPendingGeoStore();
    await store.set(1, { latitude: 1, longitude: 1 });
    await store.set(2, { latitude: 2, longitude: 2 });
    expect((await store.get(1))?.latitude).toBe(1);
    expect((await store.get(2))?.latitude).toBe(2);
  });

  test('overwrites existing entry', async () => {
    const store = new InMemoryPendingGeoStore();
    await store.set(100, { latitude: 1, longitude: 1 });
    await store.set(100, { latitude: 5, longitude: 5 });
    expect(await store.get(100)).toEqual({ latitude: 5, longitude: 5 });
  });
});
