// test/services/location/home-area-cache.test.ts
// #415: every location check that misses the address cache located the user's home city and/or
// country with 1-2 paid Geocoding requests, although the answer only changes with users.city,
// country_code or timezone. Real SQLite user and event rows, the real verification service, and a
// geocoder that counts its area requests behind the area cache.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { AddressCache } from '../../../src/services/location/address-cache.ts';
import { withCachedAreas } from '../../../src/services/location/area-cache.ts';
import type { GeocodedArea, GeocodingService } from '../../../src/services/location/geocoding-service.ts';
import { InMemoryLocationCandidateStore } from '../../../src/services/location/location-candidate-store.ts';
import { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';

const USER_ID = 1001;
const BELGRADE: GeocodedArea = {
  latitude: 44.8125,
  longitude: 20.4612,
  countryCode: 'RS',
  bounds: { south: 44.68, west: 20.2, north: 44.94, east: 20.62 },
};
const NOVI_SAD: GeocodedArea = {
  latitude: 45.2671,
  longitude: 19.8335,
  countryCode: 'RS',
  bounds: { south: 45.2, west: 19.7, north: 45.33, east: 19.95 },
};
const SERBIA: GeocodedArea = {
  latitude: 44.02,
  longitude: 21.01,
  countryCode: 'RS',
  bounds: { south: 42.23, west: 18.82, north: 46.19, east: 23.01 },
};
const AREAS: { [cityAndCountry: string]: GeocodedArea } = {
  'Belgrade|RS': BELGRADE,
  'Novi Sad|RS': NOVI_SAD,
  '|RS': SERBIA,
};

/** Redis over a map that honours the expiry `set` asks for. */
function memoryRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    get: async (key: string) => {
      const entry = store.get(key);
      return entry && entry.expiresAt > Date.now() ? entry.value : null;
    },
    set: async (key: string, value: string, opts: { ex: number }) => {
      store.set(key, { value, expiresAt: Date.now() + opts.ex * 1000 });
      return 'OK';
    },
  };
}

/** A geocoder that answers from `AREAS` and records every area it is asked for as `city|country`. */
function countingGeocoder() {
  const located: string[] = [];
  const service: GeocodingService = {
    findPlace: async () => [],
    geocodeAddress: async () => [],
    reverseGeocode: async () => null,
    locateArea: async ({ city, countryCode }) => {
      const key = `${city ?? ''}|${countryCode ?? ''}`;
      located.push(key);
      return AREAS[key] ?? null;
    },
  };
  return { service, located };
}

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  setSystemTime();
});

function setup(profile: { city: string | null; countryCode: string | null; timezone: string }) {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  users.create({
    telegram_id: USER_ID,
    language: 'en',
    timezone: profile.timezone,
    ...(profile.countryCode ? { country_code: profile.countryCode } : {}),
  });
  if (profile.city) users.update(USER_ID, { city: profile.city });
  const events = new EventRepository(db);

  const geocoder = countingGeocoder();
  const addressStore = new Map<string, string>();
  const service = new LocationVerificationService({
    geocodingService: withCachedAreas(geocoder.service, memoryRedis()),
    addressCache: new AddressCache({
      get: async (key) => addressStore.get(key) ?? null,
      compareAndSet: async (key, expected, value) => {
        if ((addressStore.get(key) ?? null) !== expected) return false;
        addressStore.set(key, value);
        return true;
      },
    }),
    eventRepo: events,
    userRepo: users,
    invitationRepo: new InvitationRepository(db),
    agendaRepository: new AgendaRepository(db),
    candidateStore: new InMemoryLocationCandidateStore(),
    sendMessage: async () => {},
  });

  /** One location check for a new event of the user, as after create_event. */
  async function check(text: string) {
    const user = users.findByTelegramId(USER_ID);
    if (!user) throw new Error('user missing');
    const event = events.create({
      user_id: USER_ID,
      title: 'Coffee',
      start_at: '2026-10-05T17:00:00Z',
      timezone: 'Europe/Belgrade',
      location: text,
    });
    await service.verifyEventLocation(event, user);
  }

  return { users, located: geocoder.located, check };
}

describe('the home area is located once, not on every location check', () => {
  test('a second check with unchanged city, country and timezone makes no area request', async () => {
    const s = setup({ city: 'Belgrade', countryCode: 'RS', timezone: 'Europe/Belgrade' });

    await s.check('Kafana Sunce');
    expect(s.located).toEqual(['Belgrade|RS']);

    await s.check('Sonder Dorcol');
    expect(s.located).toEqual(['Belgrade|RS']);
  });

  test('a user with only a country locates it once too', async () => {
    const s = setup({ city: null, countryCode: 'RS', timezone: 'Europe/Belgrade' });

    await s.check('Kafana Sunce');
    await s.check('Sonder Dorcol');

    expect(s.located).toEqual(['|RS']);
  });

  test('a changed home city is located on the next check', async () => {
    const s = setup({ city: 'Belgrade', countryCode: 'RS', timezone: 'Europe/Belgrade' });
    await s.check('Kafana Sunce');

    s.users.update(USER_ID, { city: 'Novi Sad' });
    await s.check('Kafana Sunce');

    expect(s.located).toEqual(['Belgrade|RS', 'Novi Sad|RS']);
  });

  test('a changed timezone that implies another country locates that country', async () => {
    const s = setup({ city: null, countryCode: null, timezone: 'Europe/Belgrade' });
    await s.check('Kafana Sunce');

    s.users.update(USER_ID, { timezone: 'Europe/Berlin' });
    await s.check('Kafana Sunce');

    expect(s.located).toEqual(['|RS', '|DE']);
  });

  test('a located area is located again once its cache entry expires', async () => {
    setSystemTime(new Date('2026-09-27T12:00:00Z'));
    const s = setup({ city: 'Belgrade', countryCode: 'RS', timezone: 'Europe/Belgrade' });
    await s.check('Kafana Sunce');

    setSystemTime(new Date('2026-12-27T12:00:00Z'));
    await s.check('Kafana Sunce');

    expect(s.located).toEqual(['Belgrade|RS', 'Belgrade|RS']);
  });

  test('an area that was not found is asked again on the next check, not remembered as missing', async () => {
    const s = setup({ city: 'Atlantis', countryCode: 'RS', timezone: 'Europe/Belgrade' });

    await s.check('Kafana Sunce');
    await s.check('Kafana Sunce');

    // The unknown city and then the country each time; only the found country is cached
    expect(s.located).toEqual(['Atlantis|RS', '|RS', 'Atlantis|RS']);
  });
});

describe('a broken area cache never stops the area from being located', () => {
  const belgradeQuery = { city: 'Belgrade', countryCode: 'RS' };

  test('a cache that can be neither read nor written answers from the geocoder', async () => {
    const geocoder = countingGeocoder();
    const areas = withCachedAreas(geocoder.service, {
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
      set: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    expect(await areas.locateArea(belgradeQuery)).toEqual(BELGRADE);
    expect(await areas.locateArea(belgradeQuery)).toEqual(BELGRADE);
    expect(geocoder.located).toEqual(['Belgrade|RS', 'Belgrade|RS']);
  });

  test('an unreadable cached area is located again and replaced by the located one', async () => {
    const geocoder = countingGeocoder();
    const redis = memoryRedis();
    let firstRead = true;
    const areas = withCachedAreas(geocoder.service, {
      get: async (key) => {
        if (!firstRead) return redis.get(key);
        firstRead = false;
        return '{"latitude":"not a number"}';
      },
      set: redis.set,
    });

    expect(await areas.locateArea(belgradeQuery)).toEqual(BELGRADE);
    expect(await areas.locateArea(belgradeQuery)).toEqual(BELGRADE);
    expect(geocoder.located).toEqual(['Belgrade|RS']);
  });
});

describe('location checks that start together share one area request (#489)', () => {
  const belgradeQuery = { city: 'Belgrade', countryCode: 'RS' };

  test('two concurrent location checks for one uncached home area make one area request', async () => {
    const s = setup({ city: 'Belgrade', countryCode: 'RS', timezone: 'Europe/Belgrade' });

    await Promise.all([s.check('Kafana Sunce'), s.check('Sonder Dorcol')]);

    expect(s.located).toEqual(['Belgrade|RS']);
  });

  test('a city asked in another letter case joins the running request', async () => {
    const geocoder = countingGeocoder();
    const areas = withCachedAreas(geocoder.service, memoryRedis());

    const answers = await Promise.all([
      areas.locateArea(belgradeQuery),
      areas.locateArea({ city: ' belgrade ', countryCode: 'RS' }),
    ]);

    expect(answers).toEqual([BELGRADE, BELGRADE]);
    expect(geocoder.located).toEqual(['Belgrade|RS']);
  });

  test('a failed shared lookup is not remembered: the next check asks Google again', async () => {
    const located: string[] = [];
    let fail = true;
    const areas = withCachedAreas(
      {
        ...countingGeocoder().service,
        // `locateArea` answers null when the request fails
        locateArea: async () => {
          located.push('Belgrade|RS');
          return fail ? null : BELGRADE;
        },
      },
      memoryRedis(),
    );

    expect(await Promise.all([areas.locateArea(belgradeQuery), areas.locateArea(belgradeQuery)])).toEqual([null, null]);
    expect(located).toEqual(['Belgrade|RS']);

    fail = false;
    expect(await areas.locateArea(belgradeQuery)).toEqual(BELGRADE);
    expect(located).toEqual(['Belgrade|RS', 'Belgrade|RS']);
  });

  test('a shared lookup that throws rejects every caller and is asked again next time', async () => {
    const located: string[] = [];
    let fail = true;
    const areas = withCachedAreas(
      {
        ...countingGeocoder().service,
        locateArea: async () => {
          located.push('Belgrade|RS');
          if (fail) throw new Error('ETIMEDOUT');
          return BELGRADE;
        },
      },
      memoryRedis(),
    );

    const results = await Promise.allSettled([areas.locateArea(belgradeQuery), areas.locateArea(belgradeQuery)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(located).toEqual(['Belgrade|RS']);

    fail = false;
    expect(await areas.locateArea(belgradeQuery)).toEqual(BELGRADE);
    expect(located).toEqual(['Belgrade|RS', 'Belgrade|RS']);
  });
});
