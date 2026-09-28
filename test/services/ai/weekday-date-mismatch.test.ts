import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, type Mock, mock, setSystemTime, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { findWeekdayDateMismatches } from '../../../src/services/ai/day-references.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

// Sunday 2026-09-27, 23:00 in Belgrade.
const NOW = new Date('2026-09-27T21:00:00Z');
const TZ = 'Europe/Belgrade';
const mismatches = (text: string) =>
  findWeekdayDateMismatches(text, NOW, TZ).map(({ date, said, actual }) => ({ date, said, actual }));

describe('a weekday written next to a date on another weekday', () => {
  test('the incident replies are caught', () => {
    // 2026-09-25 confirmation, 2026-09-27 23:01 and 23:12 replies.
    expect(mismatches('- **Понедельник 27 сентября** в 12:30\n- **Среда 29 сентября** в 12:30')).toEqual([
      { date: '2026-09-27', said: 'Monday', actual: 'Sunday' },
      { date: '2026-09-29', said: 'Wednesday', actual: 'Tuesday' },
    ]);
    expect(mismatches('У вас уже есть событие — «Английский с Алексом» в среду, 28 сентября, в 12:30')).toEqual([
      { date: '2026-09-28', said: 'Wednesday', actual: 'Monday' },
    ]);
    expect(mismatches('**Среда, 28 сентября 2026**')).toEqual([
      { date: '2026-09-28', said: 'Wednesday', actual: 'Monday' },
    ]);
  });

  test('other orders and forms', () => {
    expect(mismatches('Wednesday, September 28')).toEqual([
      { date: '2026-09-28', said: 'Wednesday', actual: 'Monday' },
    ]);
    expect(mismatches('28 сентября, среда')).toEqual([{ date: '2026-09-28', said: 'Wednesday', actual: 'Monday' }]);
    expect(mismatches('вт 29.09 и ср 01.10')).toEqual([{ date: '2026-10-01', said: 'Wednesday', actual: 'Thursday' }]);
    expect(mismatches('Sun 2026-09-28')).toEqual([{ date: '2026-09-28', said: 'Sunday', actual: 'Monday' }]);
  });

  test('a weekday alone on its line heads the date on the next line', () => {
    expect(mismatches('Среда\n28 сентября: событий нет')).toEqual([
      { date: '2026-09-28', said: 'Wednesday', actual: 'Monday' },
    ]);
    expect(mismatches('**Понедельник:**\n\n- 27 сентября, 12:30 английский')).toEqual([
      { date: '2026-09-27', said: 'Monday', actual: 'Sunday' },
    ]);
    expect(mismatches('### Понедельник\n28 сентября — английский')).toEqual([]);
    // A weekday that merely ends a line of prose does not head the next line.
    expect(mismatches('Свободна только среда\n28 сентября — английский в 12:30')).toEqual([]);
  });

  test('a dotted number after a weekday is a date only when it cannot be a clock time', () => {
    // Dates: a year, a day past 23, or a text that writes its times with a colon.
    expect(mismatches('ср 10.09.2026')).toEqual([{ date: '2026-09-10', said: 'Wednesday', actual: 'Thursday' }]);
    expect(mismatches('ср 10.09 в 12:30')).toEqual([{ date: '2026-09-10', said: 'Wednesday', actual: 'Thursday' }]);
    expect(mismatches('ср 24.09')).toEqual([{ date: '2026-09-24', said: 'Wednesday', actual: 'Thursday' }]);
    // Times: nothing says the dotted number is a day and a month.
    for (const text of ['ср 10.09', 'ср 9.05 английский', 'Ср 9.10-10.00 английский, 12:30 обед'])
      expect(mismatches(text)).toEqual([]);
  });

  test('correct pairs and unrelated numbers pass', () => {
    for (const text of [
      'понедельник, 28 сентября',
      '28 сентября, понедельник',
      'Wed 30 Sep',
      '**Вторник, 29 сентября 2026** — 13:00 Ветеринар',
      'Понедельник 12 чинить машину',
      'среда 12:30 английский',
      'Понедельник\n28 сентября',
      'Воскресенье 27 сентября 2026',
    ])
      expect(mismatches(text)).toEqual([]);
  });

  test('a date without a year is read in the year nearest to now', () => {
    // 5 January is next year's (2027-01-05, a Tuesday), not 2026's Monday.
    expect(findWeekdayDateMismatches('вторник, 5 января', NOW, TZ)).toEqual([]);
  });
});

describe('ask_user with a mismatched weekday and date', () => {
  const USER = 9102;
  let db: Database;
  let ctx: AgentContext;
  let sendButtons: Mock<() => Promise<{ message_id: number }>>;

  beforeEach(() => {
    _resetToolThrottleForTest();
    setSystemTime(NOW);
    db = new Database(':memory:');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    users.create({ telegram_id: USER, timezone: TZ, language: 'ru' });
    const history = new ChatHistoryRepository(db);
    sendButtons = mock(async () => ({ message_id: 7 }));
    ctx = {
      user: users.findByTelegramId(USER)!,
      chatId: USER,
      messageText: 'понедельник английский 12-30',
      isGroup: false,
      eventService: new EventService({ eventRepo: new EventRepository(db) }),
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: history,
      conversationLogger: new ConversationLogger(history),
      userRepo: users,
      eventReminderRepo: new EventReminderRepository(db),
      sender: { sendMessage: async () => ({ message_id: 1 }), editMessageText: async () => {}, sendButtons },
    };
  });

  afterEach(() => {
    setSystemTime();
    db.close();
  });

  test('is rejected before it is sent, with the real weekday and the nearest named day', async () => {
    const result = await executeTool(ctx, 'ask_user', {
      question: 'Создать занятие:\n- **Понедельник 27 сентября** в 12:30',
      options: ['Создать', 'Отмена'],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('WEEKDAY_DATE_MISMATCH');
    expect(result.error).toContain('2026-09-27 is a Sunday, not a Monday');
    expect(result.error).toContain('the nearest Monday is 2026-09-28');
    expect(sendButtons).not.toHaveBeenCalled();
  });

  test('a weekday heading over a date on another weekday is rejected too', async () => {
    const result = await executeTool(ctx, 'ask_user', {
      question: 'Создать занятие?\n**Понедельник**\n27 сентября, 12:30',
      options: ['Создать', 'Отмена'],
    });
    expect(result.error).toContain('2026-09-27 is a Sunday, not a Monday');
    expect(sendButtons).not.toHaveBeenCalled();
  });

  test('a consistent question is sent', async () => {
    const result = await executeTool(ctx, 'ask_user', {
      question: 'Создать занятие в понедельник, 28 сентября, в 12:30?',
      options: ['Да', 'Нет'],
    });
    expect(result.success).toBe(true);
    expect(sendButtons).toHaveBeenCalledTimes(1);
  });
});
