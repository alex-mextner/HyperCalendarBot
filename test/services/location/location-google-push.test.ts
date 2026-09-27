// test/services/location/location-google-push.test.ts
// Google Calendar copies are pushed when an event is saved, before the creator answers the location
// question, so the answer itself must re-push them (#411). Real SQLite repositories, the real push
// schedulers over a recording queue, and the real SyncService pushing to a recording Google API.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Queue } from 'bullmq';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { ParticipantGoogleSyncRepository } from '../../../src/database/repositories/participant-google-sync.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { GoogleCalendarApi } from '../../../src/services/google/calendar-api.ts';
import type { GoogleEvent } from '../../../src/services/google/event-mapper.ts';
import {
  createEventCopiesPushScheduler,
  createParticipantPushScheduler,
  createPushScheduler,
} from '../../../src/services/google/push-scheduler.ts';
import type { GoogleSyncJobData } from '../../../src/services/google/sync-queue.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';
import { AddressCache } from '../../../src/services/location/address-cache.ts';
import type { GeocodedLocation, GeocodingService } from '../../../src/services/location/geocoding-service.ts';
import { InMemoryLocationCandidateStore } from '../../../src/services/location/location-candidate-store.ts';
import { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';

const OWNER_ID = 1001;
const INVITEE_ID = 2002;
const TYPED = 'Kafana Sunce';

const CAFE: GeocodedLocation = {
  formattedAddress: 'Dunavska 1, Belgrade, Serbia',
  latitude: 44.8231,
  longitude: 20.4632,
  city: 'Belgrade',
  country: 'Serbia',
  countryCode: 'RS',
  placeId: 'place-cafe',
  googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=44.8231,20.4632&query_place_id=place-cafe',
  venueName: 'Kafana Sunce',
};
const CAFE_SHOWN = 'Kafana Sunce — Dunavska 1, Belgrade, Serbia';
const PIN: GeocodedLocation = {
  formattedAddress: 'Knez Mihailova 5, Belgrade, Serbia',
  latitude: 44.8176,
  longitude: 20.4569,
  city: 'Belgrade',
  country: 'Serbia',
  countryCode: 'RS',
  placeId: 'place-pin',
  googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=44.8176,20.4569&query_place_id=place-pin',
  venueName: null,
};

/** A Google Calendar update: which copy was written and the location it now shows. */
interface GoogleWrite {
  copy: string;
  location: string | null | undefined;
}

let db: Database;
afterEach(() => db.close());

function setup(options: { ownerSynced?: boolean; groupEvent?: boolean } = {}) {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  userRepo.create({ telegram_id: OWNER_ID, language: 'en', timezone: 'Europe/Belgrade' });
  userRepo.create({ telegram_id: INVITEE_ID, language: 'en', timezone: 'Europe/Belgrade' });
  const syncRepo = new GoogleSyncRepository(db);
  if (options.ownerSynced !== false) syncRepo.upsertSyncState(OWNER_ID, 'calendar');
  syncRepo.upsertSyncState(INVITEE_ID, 'calendar');

  const eventRepo = new EventRepository(db);
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const event = eventRepo.create({
    user_id: OWNER_ID,
    title: 'Dinner',
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
    timezone: 'Europe/Belgrade',
    location: TYPED,
    ...(options.groupEvent ? { owner_type: 'group' as const, group_id: -100500, created_by: OWNER_ID } : {}),
  });
  // Both Google copies were pushed right after the event was saved, with the typed text
  if (options.ownerSynced !== false && !options.groupEvent) {
    eventRepo.updateSyncFields(event.id, { google_event_id: 'g-owner', sync_status: 'synced' });
  }
  const participantRepo = new ParticipantRepository(db);
  participantRepo.add(event.id, INVITEE_ID, 'accepted');
  const participantSyncRepo = new ParticipantGoogleSyncRepository(db);
  participantSyncRepo.upsert(INVITEE_ID, event.id, { google_event_id: 'g-invitee', sync_status: 'synced' });

  const jobs: GoogleSyncJobData[] = [];
  const recordingQueue = {
    add: async (_name: string, data: GoogleSyncJobData) => {
      jobs.push(data);
    },
  };
  // The schedulers only call `add`; the one cast in this file
  const queue = recordingQueue as unknown as Queue<GoogleSyncJobData>;
  const pushGoogleCopies = createEventCopiesPushScheduler(
    createPushScheduler(syncRepo, eventRepo, queue),
    createParticipantPushScheduler(syncRepo, participantSyncRepo, queue),
    participantSyncRepo,
    participantRepo,
  );

  const geocodingService: GeocodingService = {
    findPlace: async () => [CAFE],
    geocodeAddress: async () => [],
    reverseGeocode: async () => PIN,
    locateArea: async () => null,
  };
  const store = new Map<string, string>();
  const candidateStore = new InMemoryLocationCandidateStore();
  const service = new LocationVerificationService({
    geocodingService,
    addressCache: new AddressCache({
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value);
        return 'OK';
      },
    }),
    eventRepo,
    userRepo,
    invitationRepo: new InvitationRepository(db),
    agendaRepository: new AgendaRepository(db),
    candidateStore,
    sendMessage: async () => {},
    pushGoogleCopies,
  });

  const sync = new SyncService(db, eventRepo, syncRepo, new GoogleCalendarRepository(db));

  /** Run the queued push jobs through the real sync service; returns what Google received. */
  async function runPushJobs(): Promise<GoogleWrite[]> {
    const writes: GoogleWrite[] = [];
    const api = {
      insertEvent: async (_calendarId: string, body: GoogleEvent) => {
        writes.push({ copy: 'new', location: body.location });
        return { id: 'g-new', etag: '"e"' };
      },
      updateEvent: async (_calendarId: string, googleEventId: string, body: GoogleEvent) => {
        writes.push({ copy: googleEventId, location: body.location });
        return { id: googleEventId, etag: '"e"' };
      },
    };
    const google = api as unknown as GoogleCalendarApi;
    for (const job of jobs.splice(0)) {
      if (job.eventId === undefined || !job.action) throw new Error(`incomplete job ${job.type}`);
      if (job.type === 'push-event') await sync.pushEvent(google, job.userId, job.eventId, job.action);
      if (job.type === 'push-participant-event') {
        await sync.pushParticipantEvent(google, job.userId, job.eventId, job.action, participantSyncRepo);
      }
    }
    return writes;
  }

  /** The creator was asked about the typed text: the open picker offers `candidates`. */
  async function askedWith(candidates: GeocodedLocation[]): Promise<string> {
    await candidateStore.set(event.id, { id: 'a1b2c3d4', location: TYPED, candidates, remembered: false });
    return 'a1b2c3d4';
  }

  const owner = () => {
    const row = userRepo.findByTelegramId(OWNER_ID);
    if (!row) throw new Error('owner missing');
    return row;
  };

  return { service, event, eventRepo, participantRepo, owner, jobs, runPushJobs, askedWith };
}

describe('the answer to the location question re-pushes the Google copies', () => {
  test('a candidate tap pushes the chosen place to the owner copy and the participant copy', async () => {
    const s = setup();
    const pickerId = await s.askedWith([CAFE]);

    expect(await s.service.handleLocationChoice(s.event.id, OWNER_ID, pickerId, 0)).toBe(true);

    expect(await s.runPushJobs()).toEqual([
      { copy: 'g-owner', location: CAFE_SHOWN },
      { copy: 'g-invitee', location: CAFE_SHOWN },
    ]);
  });

  test('a pin shared for the event pushes the pinned place', async () => {
    const s = setup();

    expect(await s.service.resolveFromCoordinates(s.event.id, PIN.latitude, PIN.longitude, OWNER_ID)).toBe(true);

    expect(await s.runPushJobs()).toEqual([
      { copy: 'g-owner', location: PIN.formattedAddress },
      { copy: 'g-invitee', location: PIN.formattedAddress },
    ]);
  });

  test('re-picking another place pushes the new one; confirming the same place again pushes nothing', async () => {
    const s = setup();
    expect(await s.service.handleLocationChoice(s.event.id, OWNER_ID, await s.askedWith([CAFE]), 0)).toBe(true);
    await s.runPushJobs();

    expect(await s.service.resolveFromCoordinates(s.event.id, PIN.latitude, PIN.longitude, OWNER_ID)).toBe(true);
    expect(await s.runPushJobs()).toEqual([
      { copy: 'g-owner', location: PIN.formattedAddress },
      { copy: 'g-invitee', location: PIN.formattedAddress },
    ]);

    expect(await s.service.resolveFromCoordinates(s.event.id, PIN.latitude, PIN.longitude, OWNER_ID)).toBe(true);
    expect(s.jobs).toEqual([]);
  });

  test('keeping the typed text after a confirmed place pushes exactly the typed text', async () => {
    const s = setup();
    expect(await s.service.handleLocationChoice(s.event.id, OWNER_ID, await s.askedWith([CAFE]), 0)).toBe(true);
    await s.runPushJobs();

    expect(await s.service.keepTypedLocation(s.event.id, OWNER_ID, await s.askedWith([PIN]))).not.toBeNull();

    expect(await s.runPushJobs()).toEqual([
      { copy: 'g-owner', location: TYPED },
      { copy: 'g-invitee', location: TYPED },
    ]);
  });

  test('keeping the typed text when no place was confirmed pushes nothing: the copies already show it', async () => {
    const s = setup();

    expect(await s.service.keepTypedLocation(s.event.id, OWNER_ID, await s.askedWith([CAFE]))).not.toBeNull();

    expect(s.jobs).toEqual([]);
  });

  test('a new question for the same text drops the confirmed place and pushes the typed text', async () => {
    const s = setup();
    expect(await s.service.handleLocationChoice(s.event.id, OWNER_ID, await s.askedWith([CAFE]), 0)).toBe(true);
    await s.runPushJobs();
    const confirmed = s.eventRepo.findById(s.event.id, OWNER_ID);
    if (!confirmed) throw new Error('event missing');

    await s.service.verifyEventLocation(confirmed, s.owner());

    expect(await s.runPushJobs()).toEqual([
      { copy: 'g-owner', location: TYPED },
      { copy: 'g-invitee', location: TYPED },
    ]);
  });

  test('a group event lives in its members calendars: only their copies are pushed, not a copy for the creator', async () => {
    const s = setup({ groupEvent: true });

    await s.service.applyResolvedLocation(s.event, CAFE);

    expect(await s.runPushJobs()).toEqual([{ copy: 'g-invitee', location: CAFE_SHOWN }]);
  });

  test('a participant who just declined keeps their copy removed: only the owner copy is pushed', async () => {
    const s = setup();
    // The decline queued the removal of their copy; its sync row lives until that job runs
    s.participantRepo.updateStatus(s.event.id, INVITEE_ID, 'declined');

    expect(await s.service.handleLocationChoice(s.event.id, OWNER_ID, await s.askedWith([CAFE]), 0)).toBe(true);

    expect(await s.runPushJobs()).toEqual([{ copy: 'g-owner', location: CAFE_SHOWN }]);
  });

  test('without active Google sync nothing is queued', async () => {
    const s = setup({ ownerSynced: false });
    db.run('DELETE FROM google_sync_state');

    expect(await s.service.handleLocationChoice(s.event.id, OWNER_ID, await s.askedWith([CAFE]), 0)).toBe(true);

    expect(s.jobs).toEqual([]);
  });
});
