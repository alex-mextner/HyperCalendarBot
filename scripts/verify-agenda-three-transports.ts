// Actual command and AI handlers deliver the real Chromium artifact through the production sender.
import { Database } from 'bun:sqlite';
import { strict as assert } from 'node:assert';
import { Bot, MessageContext } from 'gramio';
import { handleToday } from '../src/bot/commands/today.ts';
import { migrations } from '../src/database/migrations.ts';
import { ChatHistoryRepository } from '../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../src/database/repositories/user.repository.ts';
import { runMigrations } from '../src/database/schema.ts';
import { createTelegramSender } from '../src/services/ai/telegram-sender.ts';
import { handleRenderDayImage } from '../src/services/ai/tool-handlers/render.ts';
import type { AgentContext } from '../src/services/ai/types.ts';
import { ConversationLogger } from '../src/services/conversation-logger.ts';
import { EventService } from '../src/services/event/event-service.ts';
import { HolidayService } from '../src/services/holiday/holiday-service.ts';

const bytes = Buffer.from(await Bun.file('logs/agenda-three/synthetic100.png').arrayBuffer());
const db = new Database(':memory:');
try {
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  const user = users.create({ telegram_id: 1, timezone: 'UTC', language: 'en' });
  const events = new EventService({ eventRepo: new EventRepository(db) });
  events.createEvent({ user_id: 1, title: 'Transport proof', start_at: new Date().toISOString(), timezone: 'UTC' });
  const bot = new Bot('123:test');
  const payload = { message_id: 42, date: 0, chat: { id: 1, type: 'private' as const } };
  let documents = 0;
  bot.api.sendPhoto = async () => {
    throw new Error('Oversized photo attempted');
  };
  bot.api.sendDocument = async (params) => {
    assert(params.document instanceof File);
    assert.deepEqual(Buffer.from(await params.document.arrayBuffer()), bytes);
    assert(String(params.caption).includes('lossless'));
    documents++;
    return payload;
  };
  bot.api.sendMessage = async () => payload;
  bot.api.pinChatMessage = async () => true;
  const renderer = { renderDirect: async () => bytes };
  const command = Object.assign(new MessageContext({ bot, payload }), {
    dbUser: user,
    userTimezone: 'UTC',
    lang: 'en' as const,
    scene: { enter: async () => {} },
  });
  await handleToday(command, events, undefined, renderer);
  assert.equal(documents, 1);
  const history = new ChatHistoryRepository(db);
  const ctx: AgentContext = {
    holidayService: new HolidayService(new HolidayRepository(db)),
    user,
    chatId: 1,
    isGroup: false,
    messageText: '',
    eventService: events,
    userRepo: users,
    chatHistory: history,
    conversationLogger: new ConversationLogger(history),
    eventReminderRepo: new EventReminderRepository(db),
    sender: createTelegramSender(bot),
    renderService: renderer,
  };
  const result = await handleRenderDayImage(ctx, { date: new Date().toISOString().slice(0, 10) });
  assert.equal(result.success, true);
  assert.equal(documents, 2);
  console.log(
    JSON.stringify({
      actualCommand: 'today',
      actualAI: 'render_day_image',
      actualSender: true,
      realPNGBytes: bytes.length,
      losslessDocuments: documents,
    }),
  );
} finally {
  db.close();
}
