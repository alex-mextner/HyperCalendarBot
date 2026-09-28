import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, type Mock, mock, test } from 'bun:test';
import type { Queue } from 'bullmq';
import { OAuth2Client } from 'google-auth-library';
import { migrations } from '../../../src/database/migrations.ts';
import { EditProposalRepository } from '../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { ParticipantGoogleSyncRepository } from '../../../src/database/repositories/participant-google-sync.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { EventChangeNotifier } from '../../../src/services/event/event-change-notifier.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { GoogleCalendarApi } from '../../../src/services/google/calendar-api.ts';
import { createParticipantPushScheduler } from '../../../src/services/google/push-scheduler.ts';
import type { GoogleSyncJobData } from '../../../src/services/google/sync-queue.ts';
import { SyncService } from '../../../src/services/google/sync-service.ts';
import { ReminderMaterializer } from '../../../src/services/notification/materializer.ts';

// Incident 2026-09-27: the organizer deleted an event with an accepted participant whose
// Google Calendar held a copy. Both queued participant delete jobs ran after the event
// delete had already removed the participant_google_sync row, found nothing and never
// called Google, so the participant's copy stayed. Synthetic ids below.
const ORGANIZER = 9001;
const PARTICIPANT = 9002;
const GOOGLE_COPY = 'g-participant-copy';

type DeleteEvent = (calendarId: string, googleEventId: string) => Promise<void>;

/** A real client whose only network call on this path, deleteEvent, is recorded instead. */
function googleApi(): { api: GoogleCalendarApi; deleteEvent: Mock<DeleteEvent> } {
  const api = new GoogleCalendarApi(new OAuth2Client());
  const deleteEvent = mock<DeleteEvent>(() => Promise.resolve());
  api.deleteEvent = deleteEvent;
  return { api, deleteEvent };
}

/** Records jobs instead of talking to Redis; the one cast to the BullMQ queue lives here. */
function recordingQueue(jobs: GoogleSyncJobData[]): Queue<GoogleSyncJobData> {
  const queue = {
    add: async (_name: string, data: GoogleSyncJobData) => {
      jobs.push(data);
      return {};
    },
  };
  return queue as unknown as Queue<GoogleSyncJobData>;
}

describe('organizer delete removes the participant Google copy', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let participantSyncRepo: ParticipantGoogleSyncRepository;
  let syncService: SyncService;
  let eventService: EventService;
  let jobs: GoogleSyncJobData[];
  let queue: Queue<GoogleSyncJobData>;
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
    queue = recordingQueue(jobs);
    const notifier = new EventChangeNotifier({
      participantRepo,
      editProposalRepo: new EditProposalRepository(db),
      participantSyncRepo,
      materializer: new ReminderMaterializer(
        new EventReminderRepository(db),
        new NotificationPreferencesRepository(db),
      ),
      syncQueue: queue,
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

  async function runParticipantJobs(api: GoogleCalendarApi): Promise<void> {
    for (const job of jobs.filter((j) => j.type === 'push-participant-event')) {
      await syncService.pushParticipantEvent(api, job.userId, job.eventId!, job.action!, undefined, job);
    }
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  test('the tool-handler scheduled delete still reaches Google after the event delete removed the sync row', async () => {
    const schedule = createParticipantPushScheduler(new GoogleSyncRepository(db), participantSyncRepo, queue);
    await schedule(PARTICIPANT, eventId, 'delete');
    eventService.deleteEvent(eventId, ORGANIZER);
    await settle();
    expect(participantSyncRepo.getByUserAndEvent(PARTICIPANT, eventId)).toBeNull();

    const { api, deleteEvent } = googleApi();
    await runParticipantJobs(api);

    expect(deleteEvent).toHaveBeenCalledWith('primary', GOOGLE_COPY);
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

    const { api, deleteEvent } = googleApi();
    await runParticipantJobs(api);

    expect(deleteEvent).toHaveBeenCalledWith('primary', GOOGLE_COPY);
  });

  test('a duplicate delete job tolerates Google reporting the copy already gone', async () => {
    const schedule = createParticipantPushScheduler(new GoogleSyncRepository(db), participantSyncRepo, queue);
    await schedule(PARTICIPANT, eventId, 'delete');
    eventService.deleteEvent(eventId, ORGANIZER);
    await settle();

    const { api, deleteEvent } = googleApi();
    let calls = 0;
    deleteEvent.mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.resolve();
      const gone = new Error('Gone') as Error & { code: number };
      gone.code = 410;
      return Promise.reject(gone);
    });

    await runParticipantJobs(api);
    expect(deleteEvent).toHaveBeenCalledTimes(2);
  });
});
