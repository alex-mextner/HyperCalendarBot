// A day picture sent after calendar changes must show a changed upcoming day, not a past one (#506).
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { approveDeletes } from '../../../../src/services/ai/delete-confirmation.ts';
import {
  handleCreateEvent,
  handleDeleteEvent,
  handleUpdateEvent,
} from '../../../../src/services/ai/tool-handlers/events.ts';
import { handleRenderDayImage } from '../../../../src/services/ai/tool-handlers/render.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../../src/services/conversation-logger.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import type { ImageRenderJob } from '../../../../src/worker/image-render.queue.ts';
import { png } from '../../../fixtures/png.ts';

const USER_ID = 1001;
const TIMEZONE = 'Europe/Belgrade';

let db: Database;
beforeEach(() => {
  // Sunday 2026-09-27 23:12 in Belgrade: Tuesday 2026-09-29 is upcoming, Tuesday 2026-09-01 is past.
  setSystemTime(new Date('2026-09-27T21:12:00Z'));
  db = new Database(':memory:');
  runMigrations(db, migrations);
});
afterEach(() => {
  db.close();
  setSystemTime();
});

function setup() {
  const users = new UserRepository(db);
  users.create({ telegram_id: USER_ID, first_name: 'Learner', timezone: TIMEZONE, language: 'en' });
  const eventService = new EventService({ eventRepo: new EventRepository(db) });
  const lesson = (startAt: string) =>
    eventService.createEvent({ user_id: USER_ID, title: 'English lesson', start_at: startAt, timezone: TIMEZONE });
  const renderedDates: string[] = [];
  const chatHistory = new ChatHistoryRepository(db);
  const ctx: AgentContext = {
    user: users.findByTelegramId(USER_ID)!,
    chatId: USER_ID,
    isGroup: false,
    messageText: 'cancel all English on Tuesday',
    eventService,
    userRepo: users,
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    conversationLogger: new ConversationLogger(chatHistory),
    eventReminderRepo: new EventReminderRepository(db),
    sender: {
      editMessageText: async () => {},
      sendMessage: async () => ({ message_id: 1 }),
      sendPhoto: async () => ({ message_id: 2 }),
    },
    renderService: {
      renderDirect: async (job: ImageRenderJob) => {
        if (job.type === 'daily-agenda') renderedDates.push(job.data.date);
        return png();
      },
    },
  };
  return { ctx, lesson, renderedDates };
}

/** delete_event as it runs after the user tapped the bot's delete list for this event. */
function deleteApproved(ctx: AgentContext, eventId: number) {
  approveDeletes(ctx.user.telegram_id, ctx.chatId, [eventId]);
  return handleDeleteEvent(ctx, { event_id: eventId });
}

test('after deleting a past and an upcoming lesson, a past-day picture shows the upcoming changed day', async () => {
  const { ctx, lesson, renderedDates } = setup();
  const pastTuesday = lesson('2026-09-01T16:00:00Z');
  const nextTuesday = lesson('2026-09-29T16:00:00Z');
  expect((await deleteApproved(ctx, pastTuesday.id)).success).toBe(true);
  expect((await deleteApproved(ctx, nextTuesday.id)).success).toBe(true);

  const result = await handleRenderDayImage(ctx, { date: '2026-09-01' });

  expect(result.success).toBe(true);
  expect(renderedDates).toEqual(['2026-09-29']);
  expect(result.output).toContain('2026-09-29');
  expect(result.output).toContain('instead of the past day 2026-09-01');
});

test('create and update in the same run steer a past-day picture to the earliest upcoming changed day', async () => {
  const { ctx, lesson, renderedDates } = setup();
  const moved = lesson('2026-09-01T16:00:00Z');
  const created = await handleCreateEvent(ctx, { title: 'Speaking club', start_at: '2026-10-02T16:00:00Z' });
  expect(created.success).toBe(true);
  expect((await handleUpdateEvent(ctx, { event_id: moved.id, start_at: '2026-09-30T16:00:00Z' })).success).toBe(true);

  const result = await handleRenderDayImage(ctx, { date: '2026-09-01' });

  expect(renderedDates).toEqual(['2026-09-30']);
  expect(result.output).toContain('2026-09-30');
});

test('a past-day picture in a run without changes renders the requested day', async () => {
  const { ctx, renderedDates } = setup();

  const result = await handleRenderDayImage(ctx, { date: '2026-09-01' });

  expect(result.success).toBe(true);
  expect(renderedDates).toEqual(['2026-09-01']);
  expect(result.output).toBe('Day calendar image for 2026-09-01 has been sent to the chat.');
});

test('a past-day picture after changes only on past days renders the requested day', async () => {
  const { ctx, lesson, renderedDates } = setup();
  const pastTuesday = lesson('2026-09-01T16:00:00Z');
  const earlierTuesday = lesson('2026-08-25T16:00:00Z');
  expect((await deleteApproved(ctx, pastTuesday.id)).success).toBe(true);
  expect((await deleteApproved(ctx, earlierTuesday.id)).success).toBe(true);

  const result = await handleRenderDayImage(ctx, { date: '2026-09-01' });

  expect(renderedDates).toEqual(['2026-09-01']);
  expect(result.output).toBe('Day calendar image for 2026-09-01 has been sent to the chat.');
});

test('an upcoming-day picture is never redirected by other changed days', async () => {
  const { ctx, lesson, renderedDates } = setup();
  const nextTuesday = lesson('2026-09-29T16:00:00Z');
  expect((await deleteApproved(ctx, nextTuesday.id)).success).toBe(true);

  await handleRenderDayImage(ctx, { date: '2026-10-05' });

  expect(renderedDates).toEqual(['2026-10-05']);
});
