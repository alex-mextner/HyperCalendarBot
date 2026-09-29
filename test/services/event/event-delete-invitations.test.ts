// test/services/event/event-delete-invitations.test.ts
// Regression for #505: deleting an event must keep its invitation rows as history (open ones become
// cancelled) and turn every delivered open invitation card into a cancelled notice without RSVP buttons.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Queue } from 'bullmq';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { EditProposalRepository } from '../../../src/database/repositories/edit-proposal.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { ParticipantGoogleSyncRepository } from '../../../src/database/repositories/participant-google-sync.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { InvitationStatus } from '../../../src/database/types.ts';
import { EventChangeNotifier } from '../../../src/services/event/event-change-notifier.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import type { GoogleSyncJobData } from '../../../src/services/google/sync-queue.ts';
import { ReminderMaterializer } from '../../../src/services/notification/materializer.ts';

const ORGANIZER = 1001;
const ENGLISH_INVITEE = 2006;
const GROUP_CHAT = -1002003;
const TZ = 'Europe/Belgrade';
/** Sunday 2026-09-27 21:00Z; the lesson is on Tuesday 2026-09-29. */
const NOW = new Date('2026-09-27T21:00:00Z');
const LESSON_START = '2026-09-29T15:00:00Z';

interface EditedCard {
  chatId: number;
  messageId: number;
  text: string;
}

function makeSyncQueue(): Queue<GoogleSyncJobData> {
  return { add: async () => ({}) } as unknown as Queue<GoogleSyncJobData>;
}

interface Fixture {
  db: Database;
  invitations: InvitationRepository;
  participants: ParticipantRepository;
  service: EventService;
  edited: EditedCard[];
  /** Resolves when the change notifier started by the last `EventService.deleteEvent` has finished. */
  notifierDone: () => Promise<void>;
}

function setup(): Fixture {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  for (const id of [ORGANIZER, 2001, 2002, 2003, 2004, 2005]) {
    users.create({ telegram_id: id, timezone: TZ, language: 'ru' });
  }
  users.create({ telegram_id: ENGLISH_INVITEE, timezone: TZ, language: 'en' });
  const eventRepo = new EventRepository(db);
  const invitations = new InvitationRepository(db);
  const participants = new ParticipantRepository(db);
  const edited: EditedCard[] = [];
  const materializer = new ReminderMaterializer(
    new EventReminderRepository(db),
    new NotificationPreferencesRepository(db),
  );
  const changeNotifier = new EventChangeNotifier({
    participantRepo: participants,
    editProposalRepo: new EditProposalRepository(db),
    participantSyncRepo: new ParticipantGoogleSyncRepository(db),
    invitationRepo: invitations,
    materializer,
    syncQueue: makeSyncQueue(),
    notifyUser: async () => {},
    editMessage: async (chatId, messageId, text) => {
      edited.push({ chatId, messageId, text });
    },
    getUserLang: (userId) => (users.findByTelegramId(userId)?.language === 'ru' ? 'ru' : 'en'),
  });
  // EventService fires the notifier without awaiting it; keep its promise so tests await completion.
  let lastDeletion: Promise<void> = Promise.resolve();
  const notifyDeleted = changeNotifier.onEventDeleted.bind(changeNotifier);
  changeNotifier.onEventDeleted = (params) => {
    lastDeletion = notifyDeleted(params);
    return lastDeletion;
  };
  const service = new EventService({ eventRepo, materializer, participantRepo: participants, changeNotifier });
  return { db, invitations, participants, service, edited, notifierDone: () => lastDeletion };
}

/** Creates an invitation in `status`, delivered to the invitee's private chat unless `delivered` is false. */
function invite(fx: Fixture, eventId: number, inviteeId: number, status: InvitationStatus, delivered = true): number {
  const inv = fx.invitations.create({
    event_id: eventId,
    inviter_id: ORGANIZER,
    invitee_id: inviteeId,
    ...(delivered ? { message_id: 500 + inviteeId, chat_id: inviteeId } : {}),
  });
  if (status !== 'pending') {
    expect(fx.invitations.updateStatus(inv.id, status, 'pending')).toBe(true);
  }
  if (status === 'accepted' || status === 'maybe') {
    fx.participants.add(eventId, inviteeId, status);
  }
  return inv.id;
}

function statusesOf(db: Database, eventId: number): Record<number, string> {
  const rows = db
    .query<{ invitee_id: number; status: string }, [number]>(
      'SELECT invitee_id, status FROM invitations WHERE event_id = ? ORDER BY invitee_id',
    )
    .all(eventId);
  return Object.fromEntries(rows.map((r) => [r.invitee_id, r.status]));
}

describe('deleting an event keeps its invitations (#505)', () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());

  test('open invitations become cancelled and the declined one stays declined; no row disappears', async () => {
    const fx = setup();
    const lesson = fx.service.createEvent({
      user_id: ORGANIZER,
      title: 'English lesson',
      start_at: LESSON_START,
      timezone: TZ,
    });
    invite(fx, lesson.id, 2001, 'pending');
    invite(fx, lesson.id, 2002, 'maybe');
    invite(fx, lesson.id, 2003, 'accepted');
    invite(fx, lesson.id, 2004, 'declined');

    expect(fx.service.deleteEvent(lesson.id, ORGANIZER)).toBe(true);
    await fx.notifierDone();

    expect(statusesOf(fx.db, lesson.id)).toEqual({
      2001: 'cancelled',
      2002: 'cancelled',
      2003: 'cancelled',
      2004: 'declined',
    });
  });

  test('delivered open cards are edited to the cancelled-by-organizer text; declined and undelivered ones are not', async () => {
    const fx = setup();
    const lesson = fx.service.createEvent({
      user_id: ORGANIZER,
      title: 'English lesson',
      start_at: LESSON_START,
      timezone: TZ,
    });
    invite(fx, lesson.id, 2001, 'pending');
    invite(fx, lesson.id, 2002, 'maybe');
    invite(fx, lesson.id, 2003, 'accepted');
    invite(fx, lesson.id, 2004, 'declined');
    invite(fx, lesson.id, 2005, 'pending', false);

    fx.service.deleteEvent(lesson.id, ORGANIZER);
    await fx.notifierDone();

    const cancelledText = t('ru').sync.eventCancelled('English lesson');
    // editMessage carries no reply_markup, so Telegram drops the RSVP keyboard with the edit.
    expect(fx.edited.toSorted((a, b) => a.chatId - b.chatId)).toEqual([
      { chatId: 2001, messageId: 2501, text: cancelledText },
      { chatId: 2002, messageId: 2502, text: cancelledText },
      { chatId: 2003, messageId: 2503, text: cancelledText },
    ]);
  });

  // A group card's invitee_id is the group chat id, which has no language of its own; the card was
  // written in the organizer's language, so its cancelled notice must be too.
  test("a group invitation card is edited in the organizer's language; a personal card in the invitee's", async () => {
    const fx = setup();
    const lesson = fx.service.createEvent({
      user_id: ORGANIZER,
      title: 'English lesson',
      start_at: LESSON_START,
      timezone: TZ,
    });
    fx.invitations.create({
      event_id: lesson.id,
      inviter_id: ORGANIZER,
      invitee_id: GROUP_CHAT,
      chat_id: GROUP_CHAT,
      message_id: 700,
    });
    invite(fx, lesson.id, ENGLISH_INVITEE, 'pending');

    fx.service.deleteEvent(lesson.id, ORGANIZER);
    await fx.notifierDone();

    expect(fx.edited.toSorted((a, b) => a.chatId - b.chatId)).toEqual([
      { chatId: GROUP_CHAT, messageId: 700, text: t('ru').sync.eventCancelled('English lesson') },
      {
        chatId: ENGLISH_INVITEE,
        messageId: 500 + ENGLISH_INVITEE,
        text: t('en').sync.eventCancelled('English lesson'),
      },
    ]);
  });

  test('deleting a group calendar event also keeps its invitations as history', () => {
    const fx = setup();
    const groupEvent = fx.service.createEvent({
      user_id: ORGANIZER,
      owner_type: 'group',
      group_id: GROUP_CHAT,
      created_by: ORGANIZER,
      title: 'Team English',
      start_at: LESSON_START,
      timezone: TZ,
    });
    invite(fx, groupEvent.id, 2001, 'accepted');
    invite(fx, groupEvent.id, 2004, 'declined');

    expect(fx.service.deleteEventForGroup(groupEvent.id, GROUP_CHAT)).toBe(true);

    expect(statusesOf(fx.db, groupEvent.id)).toEqual({ 2001: 'cancelled', 2004: 'declined' });
  });
});
