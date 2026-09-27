import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, type Mock, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EditProposalRepository } from '../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { ParticipantGoogleSyncRepository } from '../../../src/database/repositories/participant-google-sync.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { EventChangeNotifier } from '../../../src/services/event/event-change-notifier.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { createParticipantPushScheduler } from '../../../src/services/google/push-scheduler.ts';
import type { GoogleSyncJobData } from '../../../src/services/google/sync-queue.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';

// Incident 2026-09-27: the organizer deleted an event with an accepted participant whose
// Google Calendar held a copy. Both queued participant delete jobs ran after the event
// delete had already removed the participant_google_sync row, found nothing and never
// called Google, so the participant's copy stayed. Synthetic ids below.
const ORGANIZER = 9001;
const PARTICIPANT = 9002;
const GOOGLE_COPY = 'g-participant-copy';

type DeleteEvent = (calendarId: string, googleEventId: string) => Promise<void>;
interface FakeGoogleApi {
  listEvents: Mock<() => Promise<{ events: never[]; nextSyncToken: string }>>;
  insertEvent: Mock<() => Promise<{ id: string; etag: string }>>;
  updateEvent: Mock<() => Promise<{ id: string; etag: string }>>;
  deleteEvent: Mock<DeleteEvent>;
}

function googleApi(): FakeGoogleApi {
  return {
    listEvents: mock(() => Promise.resolve({ events: [], nextSyncToken: 'tok' })),
    insertEvent: mock(() => Promise.resolve({ id: 'unexpected', etag: '"e"' })),
    updateEvent: mock(() => Promise.resolve({ id: 'unexpected', etag: '"e"' })),
    deleteEvent: mock<DeleteEvent>(() => Promise.resolve()),
  };
}

describe('organizer delete removes the participant Google copy', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantSyncRepo: ParticipantGoogleSyncRepository;
  let syncService: SyncService;
  let eventService: EventService;
  let jobs: GoogleSyncJobData[];
  let queue: { add: (name: string, data: GoogleSyncJobData) => Promise<object> };
  let eventId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    db.run(`INSERT INTO users (telegram_id, username) VALUES (${ORGANIZER}, 'organizer'), (${PARTICIPANT}, 'guest')`);
    eventRepo = new EventRepository(db);
    const syncRepo = new GoogleSyncRepository(db);
    syncRepo.upsertSyncState(PARTICIPANT, 'calendar');
    participantSyncRepo = new ParticipantGoogleSyncRepository(db);
    const participantRepo = new ParticipantRepository(db);
    syncService = new SyncService(
      db,
      eventRepo,
      syncRepo,
      new GoogleCalendarRepository(db),
      undefined,
      undefined,
      participantSyncRepo,
    );

    jobs = [];
    queue = {
      add: async (_name, data) => {
        jobs.push(data);
        return {};
      },
    };
    const notifier = new EventChangeNotifier({
      participantRepo,
      editProposalRepo: new EditProposalRepository(db),
      participantSyncRepo,
      materializer: { deleteForEvent: () => {}, materialize: () => {} } as never,
      syncQueue: queue as never,
      notifyUser: async () => {},
      editMessage: async () => {},
      getUserLang: () => 'ru',
    });
    eventService = new EventService({ eventRepo, participantRepo, changeNotifier: notifier });

    eventId = eventRepo.create({
      user_id: ORGANIZER,
      title: 'Lesson',
      start_at: '2026-09-29T10:30:00.000Z',
      end_at: '2026-09-29T11:30:00.000Z',
      timezone: 'Europe/Belgrade',
    }).id;
    participantRepo.add(eventId, PARTICIPANT, 'accepted');
    participantSyncRepo.upsert(PARTICIPANT, eventId, {
      google_event_id: GOOGLE_COPY,
      google_calendar_id: 'primary',
      sync_status: 'synced',
    });
  });

  async function runParticipantJobs(api: FakeGoogleApi): Promise<void> {
    for (const job of jobs.filter((j) => j.type === 'push-participant-event')) {
      await syncService.pushParticipantEvent(api as never, job.userId, job.eventId!, job.action!, undefined, job);
    }
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  test('the tool-handler scheduled delete still reaches Google after the event delete removed the sync row', async () => {
    const schedule = createParticipantPushScheduler(new GoogleSyncRepository(db), participantSyncRepo, queue as never);
    await schedule(PARTICIPANT, eventId, 'delete');
    eventService.deleteEvent(eventId, ORGANIZER);
    await settle();
    expect(participantSyncRepo.getByUserAndEvent(PARTICIPANT, eventId)).toBeNull();

    const api = googleApi();
    await runParticipantJobs(api);

    expect(api.deleteEvent).toHaveBeenCalledWith('primary', GOOGLE_COPY);
    const logged = db
      .prepare("SELECT google_event_id FROM sync_log WHERE user_id = ? AND direction = 'push' AND action = 'delete'")
      .all(PARTICIPANT) as { google_event_id: string }[];
    expect(logged.map((r) => r.google_event_id)).toContain(GOOGLE_COPY);
  });

  test('the change-notifier delete job carries the copy captured before the cascade', async () => {
    eventService.deleteEvent(eventId, ORGANIZER);
    await settle();
    const participantJobs = jobs.filter((j) => j.type === 'push-participant-event');
    expect(participantJobs).toHaveLength(1);

    const api = googleApi();
    await runParticipantJobs(api);

    expect(api.deleteEvent).toHaveBeenCalledWith('primary', GOOGLE_COPY);
  });

  test('a duplicate delete job tolerates Google reporting the copy already gone', async () => {
    const schedule = createParticipantPushScheduler(new GoogleSyncRepository(db), participantSyncRepo, queue as never);
    await schedule(PARTICIPANT, eventId, 'delete');
    eventService.deleteEvent(eventId, ORGANIZER);
    await settle();

    const api = googleApi();
    let calls = 0;
    api.deleteEvent.mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.resolve();
      const gone = new Error('Gone') as Error & { code: number };
      gone.code = 410;
      return Promise.reject(gone);
    });

    await runParticipantJobs(api);
    expect(api.deleteEvent).toHaveBeenCalledTimes(2);
  });
});
