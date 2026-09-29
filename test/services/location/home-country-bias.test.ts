// test/services/location/home-country-bias.test.ts
// #406: without a profile country, the location search is biased toward the country of the user's
// timezone. The country used to come from a hand-written list of ~40 zones, so a user in any other
// zone (Europe/Podgorica, Europe/Sarajevo, …) got no bias and Find Place ranked by the server's IP.
// Real SQLite user and event rows, the real verification service, and a geocoder recording the bias.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { AddressCache } from '../../../src/services/location/address-cache.ts';
import type { GeocodingBias, GeocodingService } from '../../../src/services/location/geocoding-service.ts';
import { InMemoryLocationCandidateStore } from '../../../src/services/location/location-candidate-store.ts';
import { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';

const USER_ID = 1001;

let db: Database;
afterEach(() => db.close());

/** The country the search for a new event's location is biased toward, for a user in `timezone`. */
async function biasCountryFor(timezone: string): Promise<{ located: (string | null)[]; searched: (string | null)[] }> {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  const user = users.create({ telegram_id: USER_ID, language: 'en', timezone });
  const events = new EventRepository(db);
  const event = events.create({
    user_id: USER_ID,
    title: 'Coffee',
    start_at: '2026-10-05T17:00:00Z',
    timezone,
    location: 'Kafana Sunce',
  });

  const located: (string | null)[] = [];
  const biases: (GeocodingBias | undefined)[] = [];
  const geocoder: GeocodingService = {
    findPlace: async (_query, bias) => {
      biases.push(bias);
      return [];
    },
    geocodeAddress: async (_query, bias) => {
      biases.push(bias);
      return [];
    },
    reverseGeocode: async () => null,
    locateArea: async ({ countryCode }) => {
      located.push(countryCode);
      return null;
    },
  };
  const addressStore = new Map<string, string>();
  const service = new LocationVerificationService({
    geocodingService: geocoder,
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

  await service.verifyEventLocation(event, user);
  return { located, searched: biases.map((bias) => bias?.countryCode ?? null) };
}

describe('the home country of a user without a profile country comes from the timezone', () => {
  test('a zone the old list lacked (Europe/Podgorica) biases the search toward its country', async () => {
    expect(await biasCountryFor('Europe/Podgorica')).toEqual({ located: ['ME'], searched: ['ME', 'ME'] });
  });

  test('a zone the old list had (Europe/Belgrade) keeps its country', async () => {
    expect(await biasCountryFor('Europe/Belgrade')).toEqual({ located: ['RS'], searched: ['RS', 'RS'] });
  });

  test('a zone of no country gives no bias', async () => {
    expect(await biasCountryFor('UTC')).toEqual({ located: [], searched: [null, null] });
  });
});
