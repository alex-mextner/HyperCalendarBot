import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { resolveTurnDayReferences } from '../../../src/services/ai/day-reference-guard.ts';
import { timeOnlyToday } from '../../../src/services/ai/day-references.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

const USER = 9103;
const TZ = 'Europe/Belgrade';
// Wednesday 2026-09-16, 11:06 in Belgrade — when "18:30 помочь …" was filed for Thursday.
const WEDNESDAY_MORNING = new Date('2026-09-16T09:06:00Z');
// Same day, 19:00 local: 18:30 has passed.
const WEDNESDAY_EVENING = new Date('2026-09-16T17:00:00Z');
const MESSAGE = '18:30 помочь соне с кошкой Kraljice Natalije 30';

let db: Database;
let history: ChatHistoryRepository;

function context(text: string, now: Date): AgentContext {
  const users = new UserRepository(db);
  const ctx: AgentContext = {
    user: users.findByTelegramId(USER)!,
    chatId: USER,
    messageText: text,
    isGroup: false,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory: history,
    conversationLogger: new ConversationLogger(history),
    userRepo: users,
    eventReminderRepo: new EventReminderRepository(db),
  };
  ctx.dayReferences = resolveTurnDayReferences(text, history.getRecent(USER, 30), now, TZ);
  return ctx;
}

const startsOf = () =>
  db
    .query<{ start_at: string }, []>('SELECT start_at FROM events WHERE is_deleted = 0 ORDER BY id')
    .all()
    .map((row) => row.start_at);

beforeEach(() => {
  _resetToolThrottleForTest();
  db = new Database(':memory:');
  runMigrations(db, migrations);
  new UserRepository(db).create({ telegram_id: USER, timezone: TZ, language: 'ru' });
  history = new ChatHistoryRepository(db);
});

afterEach(() => {
  setSystemTime();
  db.close();
});

describe('a message with only a clock time', () => {
  test('is today while the time is ahead: tomorrow is rejected, today is created', async () => {
    setSystemTime(WEDNESDAY_MORNING);
    history.save(USER, 'user', MESSAGE);
    const ctx = context(MESSAGE, WEDNESDAY_MORNING);

    const tomorrow = await executeTool(ctx, 'create_event', {
      title: 'Помочь Соне с кошкой',
      start_at: '2026-09-17T16:30:00Z',
    });
    expect(tomorrow.success).toBe(false);
    expect(tomorrow.error).toContain('WRONG_DAY');
    expect(tomorrow.error).toContain('Wednesday 2026-09-16');
    expect(startsOf()).toEqual([]);

    const today = await executeTool(ctx, 'create_event', {
      title: 'Помочь Соне с кошкой',
      start_at: '2026-09-16T16:30:00Z',
    });
    expect(today.success).toBe(true);
    expect(startsOf()).toEqual(['2026-09-16T16:30:00Z']);
  });

  test('imposes nothing once the time has passed (the past-event flow asks instead)', () => {
    history.save(USER, 'user', MESSAGE);
    expect(resolveTurnDayReferences(MESSAGE, history.getRecent(USER, 30), WEDNESDAY_EVENING, TZ)).toBeNull();
  });

  test('imposes nothing when one of several times has passed', () => {
    expect(timeOnlyToday('09:00 зал, 18:30 кошка', WEDNESDAY_MORNING, TZ)).toBeNull();
  });

  test('user spellings of a time are read', () => {
    for (const text of [
      '12-30 английский',
      'в 20.30 отвезти клетку',
      'в 7 вечера ужин',
      'Созвон в 15',
      'забери ребёнка 17:00-18:00',
    ])
      expect(timeOnlyToday(text, WEDNESDAY_MORNING, TZ)?.allowedDates).toEqual(new Set(['2026-09-16']));
    // 7 in the morning has passed at 11:06.
    expect(timeOnlyToday('в 7 утра пробежка', WEDNESDAY_MORNING, TZ)).toBeNull();
  });

  test('a dotted time is one time; one that could also be a date imposes nothing', () => {
    // 18:10 local: "в 18.30" is still ahead. "в 12.05" may be 12:05 or 12 May, "в 07.12"
    // 07:12 or 7 December: neither is read as today, nor as a date.
    const sixTen = new Date('2026-09-16T16:10:00Z');
    expect(timeOnlyToday('в 18.30 ужин', sixTen, TZ)?.allowedDates).toEqual(new Set(['2026-09-16']));
    expect(timeOnlyToday('в 12.05 английский', WEDNESDAY_MORNING, TZ)).toBeNull();
    const six = new Date('2026-09-16T04:00:00Z');
    expect(timeOnlyToday('напомни про день рождения Марины в 07.12', six, TZ)).toBeNull();
  });

  test('evening and night hours: "в 11 ночи" is 23:00 today, midnight is not today', () => {
    expect(timeOnlyToday('в 11 ночи созвон', WEDNESDAY_MORNING, TZ)?.allowedDates).toEqual(new Set(['2026-09-16']));
    const eight = new Date('2026-09-16T06:00:00Z');
    expect(timeOnlyToday('напомни в 12 ночи', eight, TZ)).toBeNull();
    expect(timeOnlyToday('в 12 вечера фильм', eight, TZ)).toBeNull();
    // An hour word may stand between the hour and the part of the day.
    expect(timeOnlyToday('поезд в 12 часов ночи', eight, TZ)).toBeNull();
    expect(timeOnlyToday('ужин в 7 часов вечера', eight, TZ)?.allowedDates).toEqual(new Set(['2026-09-16']));
    // The part of the day applies to a time with minutes too.
    expect(timeOnlyToday('в 7:30 вечера ужин', WEDNESDAY_MORNING, TZ)?.allowedDates).toEqual(new Set(['2026-09-16']));
    expect(timeOnlyToday('в 12:30 ночи созвон', WEDNESDAY_MORNING, TZ)).toBeNull();
  });

  test('counts and other zones are no clock time for today', () => {
    expect(timeOnlyToday('поливай цветы раз в 3 дня', WEDNESDAY_MORNING, TZ)).toBeNull();
    const halfPastMidnight = new Date('2026-09-15T22:30:00Z');
    expect(timeOnlyToday('в 2 раза больше воды', halfPastMidnight, TZ)).toBeNull();
    expect(timeOnlyToday('жим в 3 подхода по 10', halfPastMidnight, TZ)).toBeNull();
    const eight = new Date('2026-09-16T18:00:00Z');
    expect(timeOnlyToday('созвон в 23:30 по Токио', eight, TZ)).toBeNull();
    expect(timeOnlyToday('созвон в 23:30 мск', eight, TZ)).toBeNull();
    // A place written in lower case at the end of the time, and zone abbreviations beyond МСК.
    expect(timeOnlyToday('созвон в 23:30 по нью-йорку', eight, TZ)).toBeNull();
    expect(timeOnlyToday('созвон в 22:00 PST', eight, TZ)).toBeNull();
    expect(timeOnlyToday('созвон в 23:30 HST', eight, TZ)).toBeNull();
  });

  test('"по" after a time is a zone only when a place ends the phrase', () => {
    expect(timeOnlyToday('напомни в 18:30 по работе позвонить', WEDNESDAY_MORNING, TZ)?.allowedDates).toEqual(
      new Set(['2026-09-16']),
    );
    // A named day is not widened to its neighbours by an ordinary "по".
    const turn = resolveTurnDayReferences('созвон завтра в 9 утра по дороге домой', [], WEDNESDAY_MORNING, TZ);
    expect(turn && [...turn.allowedDates]).toEqual(['2026-09-17']);
  });

  test('the phrase quoted back to the model is the time itself', () => {
    const set = timeOnlyToday('ужин.в 7 вечера', WEDNESDAY_MORNING, TZ);
    expect(set?.references.map((reference) => reference.phrase)).toEqual(['в 7 вечера']);
  });

  test('a message with its own day word follows that day, not this rule', () => {
    const set = timeOnlyToday('завтра 18:30 кошка', WEDNESDAY_MORNING, TZ);
    expect(set).toBeNull();
    history.save(USER, 'user', 'завтра 18:30 кошка');
    const turn = resolveTurnDayReferences('завтра 18:30 кошка', history.getRecent(USER, 30), WEDNESDAY_MORNING, TZ);
    expect(turn && [...turn.allowedDates]).toEqual(['2026-09-17']);
  });

  test('an answer to a pending question is not constrained by this rule', () => {
    history.save(USER, 'user', 'Запиши встречу с Леной');
    history.save(
      USER,
      'assistant',
      JSON.stringify({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'q1',
            type: 'function',
            function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Когда?', options: ['Завтра'] }) },
          },
        ],
      }),
    );
    history.save(USER, 'tool', JSON.stringify([{ role: 'tool', tool_call_id: 'q1', content: 'Вопрос отправлен.' }]));
    history.save(USER, 'user', 'в 18:30');
    expect(resolveTurnDayReferences('в 18:30', history.getRecent(USER, 30), WEDNESDAY_MORNING, TZ)).toBeNull();
  });
});
