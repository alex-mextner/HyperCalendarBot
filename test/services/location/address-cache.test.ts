// test/services/location/address-cache.test.ts
import { describe, expect, test } from 'bun:test';
import { AddressCache } from '../../../src/services/location/address-cache.ts';

/** The store the cache needs, over a map; `compareAndSet` is atomic because nothing awaits inside it. */
function makeInMemoryRedis(store = new Map<string, string>()) {
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    compareAndSet: async (key: string, expected: string | null, value: string) => {
      if ((store.get(key) ?? null) !== expected) return false;
      store.set(key, value);
      return true;
    },
  };
}

/**
 * The in-memory store, except that the first two reads of each of `racedKeys` are released
 * together: two concurrent read-modify-writes of the key both read before either writes, the
 * interleaving that lost one of them. Later reads go through at once.
 */
function makeRacingRedis(store: Map<string, string>, racedKeys: string[]) {
  const base = makeInMemoryRedis(store);
  const firstReader = new Map<string, () => void>();
  const raced = new Set(racedKeys);
  return {
    ...base,
    get: async (key: string) => {
      if (raced.has(key)) {
        const release = firstReader.get(key);
        if (release) {
          raced.delete(key);
          release();
        } else {
          await new Promise<void>((resolve) => firstReader.set(key, resolve));
        }
      }
      return base.get(key);
    },
  };
}

const MAPPINGS = 'addr:1:confirmed_mappings';
const FREQUENCIES = 'addr:1:confirmed_freq';
const PLACE = { googleMapsUrl: 'https://maps.google.com/?q=1,2', latitude: 1, longitude: 2, placeId: null };

describe('AddressCache: concurrent writes of one user all take effect', () => {
  test('forgetting one input while recording another keeps both changes', async () => {
    const store = new Map<string, string>();
    await new AddressCache(makeInMemoryRedis(store)).recordMapping(1, 'Kafana Sunce', {
      ...PLACE,
      resolvedAddress: 'Rejected place',
    });
    const cache = new AddressCache(makeRacingRedis(store, [MAPPINGS]));

    await Promise.all([
      cache.forgetMapping(1, 'Kafana Sunce', {
        resolvedAddress: 'Rejected place',
        placeId: null,
        latitude: 1,
        longitude: 2,
      }),
      cache.recordMapping(1, 'Office', { ...PLACE, resolvedAddress: 'Office address' }),
    ]);

    expect(await cache.findMapping(1, 'Kafana Sunce')).toBeNull();
    expect((await cache.findMapping(1, 'Office'))?.resolvedAddress).toBe('Office address');
  });

  test('recording two inputs at once keeps both mappings and both frequency counts', async () => {
    const cache = new AddressCache(makeRacingRedis(new Map(), [MAPPINGS, FREQUENCIES]));

    await Promise.all([
      cache.recordMapping(1, 'Office', { ...PLACE, resolvedAddress: 'Office address' }),
      cache.recordMapping(1, 'Gym', { ...PLACE, resolvedAddress: 'Gym address' }),
    ]);

    expect((await cache.findMapping(1, 'Office'))?.resolvedAddress).toBe('Office address');
    expect((await cache.findMapping(1, 'Gym'))?.resolvedAddress).toBe('Gym address');
    const counts = (await cache.getFrequent(1)).map((f) => [f.resolvedAddress, f.count]);
    expect(counts).toEqual(
      expect.arrayContaining([
        ['Office address', 1],
        ['Gym address', 1],
      ]),
    );
    expect(counts).toHaveLength(2);
  });

  test('two inputs confirmed for the same place at once count it twice', async () => {
    const cache = new AddressCache(makeRacingRedis(new Map(), [MAPPINGS, FREQUENCIES]));

    await Promise.all([
      cache.recordMapping(1, 'Office', { ...PLACE, resolvedAddress: 'Office address' }),
      cache.recordMapping(1, 'Work', { ...PLACE, resolvedAddress: 'Office address' }),
    ]);

    expect(await cache.getFrequent(1)).toMatchObject([{ resolvedAddress: 'Office address', count: 2 }]);
  });
});

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

  test('forgetMapping drops only the mapping the input resolves to', async () => {
    const cache = new AddressCache(makeInMemoryRedis());
    const place = { googleMapsUrl: 'https://maps.google.com/?q=1,2', latitude: 1, longitude: 2, placeId: null };
    await cache.recordMapping(1, 'Kafana Sunce Dorcol', { ...place, resolvedAddress: 'Wrong place' });
    await cache.recordMapping(1, 'Office', { ...place, resolvedAddress: 'Office address' });

    // Forgets through the same fuzzy match that offered it.
    await cache.forgetMapping(1, 'kafana sunce', {
      resolvedAddress: 'Wrong place',
      placeId: null,
      latitude: 1,
      longitude: 2,
    });

    expect(await cache.findMapping(1, 'Kafana Sunce Dorcol')).toBeNull();
    expect((await cache.findMapping(1, 'Office'))?.resolvedAddress).toBe('Office address');
  });

  test('forgetMapping keeps a place that replaced the rejected one for the input', async () => {
    const cache = new AddressCache(makeInMemoryRedis());
    const rejected = { resolvedAddress: 'Main Street 1', placeId: 'place-a', latitude: 1, longitude: 2 };
    // Each replacement differs from the rejected place in one identifying field
    const replacements = [
      { ...rejected, resolvedAddress: 'Confirmed later' },
      { ...rejected, placeId: 'place-b' },
      { ...rejected, latitude: 1.5 },
      { ...rejected, longitude: 2.5 },
    ];
    for (const replacement of replacements) {
      await cache.recordMapping(1, 'Kafana Sunce', { ...replacement, googleMapsUrl: 'https://maps.google.com/?q=1,2' });

      await cache.forgetMapping(1, 'Kafana Sunce', rejected);

      expect(await cache.findMapping(1, 'Kafana Sunce')).toMatchObject(replacement);
    }
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
