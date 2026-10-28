// One simulated case's world: a fresh copy of the migrated in-memory database, the requesting user,
// their synthetic calendar, the agent context the tool handlers receive, and a Telegram transport
// that never leaves the process. A real GramIO Bot is built with an `onApiCall` hook that answers
// every Bot API call locally, so the real matcher layer talks to a real MessageContext; every text
// it would have sent to the requester is captured. The tool sender refuses any other chat.
import { Database } from 'bun:sqlite';
import { Bot, MessageContext } from 'gramio';
import type { BotCommandContext } from '../../../bot/types.ts';
import { ActionLogRepository } from '../../../database/repositories/action-log.repository.ts';
import { ChatHistoryRepository } from '../../../database/repositories/chat-history.repository.ts';
import { ContactRepository } from '../../../database/repositories/contact.repository.ts';
import { EventRepository } from '../../../database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../database/repositories/holiday.repository.ts';
import { ParticipantRepository } from '../../../database/repositories/participant.repository.ts';
import { UserRepository } from '../../../database/repositories/user.repository.ts';
import type { User } from '../../../database/types.ts';
import type { AgentContext, TelegramSender } from '../../ai/types.ts';
import { ConversationLogger } from '../../conversation-logger.ts';
import { EventService } from '../../event/event-service.ts';
import { HolidayService } from '../../holiday/holiday-service.ts';
import type { SimulationCase } from './simulator.ts';

export interface CaseWorld {
  db: Database;
  user: User;
  agentCtx: AgentContext;
  /** Texts delivered to the requester since the last `takeDelivered()`. */
  takeDelivered(): string[];
  turn(text: string): BotCommandContext;
  /** Chats other than the requester's that a tool tried to message. */
  foreignChats: number[];
}

const unescapeHtml = (text: string) =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');

function localBot(chatId: number, delivered: string[]): Bot {
  let messageId = 1000;
  return new Bot('0:simulation').onApiCall(async (call) => {
    const params = call.params;
    if (call.method === 'sendMessage' && params && 'text' in params && typeof params.text === 'string')
      delivered.push(unescapeHtml(params.text));
    messageId += 1;
    return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' as const } };
  });
}

function captureSender(chatId: number, delivered: string[], foreignChats: number[]): TelegramSender {
  let messageId = 2000;
  const deliver = (target: number, text: string) => {
    if (target !== chatId) {
      foreignChats.push(target);
      throw new Error('simulation_blocked: message to another chat');
    }
    delivered.push(text);
    messageId += 1;
    return { message_id: messageId };
  };
  return {
    sendMessage: async (target, text) => deliver(target, text),
    editMessageText: async (target, _messageId, text) => {
      deliver(target, text);
    },
  };
}

function seedWorld(db: Database, simulationCase: SimulationCase, userId: number): User {
  const user = new UserRepository(db).create({
    telegram_id: userId,
    timezone: simulationCase.timezone,
    language: simulationCase.language,
    first_name: 'Sim',
  });
  const events = new EventRepository(db);
  for (const event of simulationCase.calendar)
    events.create({
      user_id: userId,
      title: event.title,
      start_at: event.start,
      end_at: event.end,
      timezone: simulationCase.timezone,
    });
  return user;
}

export function openCaseWorld(template: Uint8Array, simulationCase: SimulationCase, userId: number): CaseWorld {
  const db = Database.deserialize(template);
  db.exec('PRAGMA foreign_keys=ON');
  const user = seedWorld(db, simulationCase, userId);
  const delivered: string[] = [];
  const foreignChats: number[] = [];
  const history = new ChatHistoryRepository(db);
  const participantRepo = new ParticipantRepository(db);
  const agentCtx: AgentContext = {
    user,
    chatId: userId,
    messageText: simulationCase.request,
    isGroup: false,
    userRepo: new UserRepository(db),
    eventService: new EventService({ eventRepo: new EventRepository(db), participantRepo }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory: history,
    conversationLogger: new ConversationLogger(history),
    eventReminderRepo: new EventReminderRepository(db),
    contactRepo: new ContactRepository(db),
    participantRepo,
    actionLogRepo: new ActionLogRepository(db),
    sender: captureSender(userId, delivered, foreignChats),
    // As in the bot's intent path (message.handler.ts): seeded write workflows ask their own
    // confirmation before any write step, so delete_event needs no tapped bot-rendered list.
    toolOrigin: 'intent_workflow',
  };
  const bot = localBot(userId, delivered);
  let updateId = 0;
  const turn = (text: string): BotCommandContext => {
    updateId += 1;
    const chat = { id: userId, type: 'private' as const };
    const payload = {
      message_id: updateId,
      date: 0,
      chat,
      from: { id: userId, is_bot: false, first_name: 'Sim' },
      text,
    };
    const context = new MessageContext({ bot, update: { update_id: updateId, message: payload }, payload, updateId });
    return Object.assign(context, {
      dbUser: user,
      userTimezone: user.timezone,
      lang: simulationCase.language,
      scene: { enter: async () => {} },
    });
  };
  return { db, user, agentCtx, turn, foreignChats, takeDelivered: () => delivered.splice(0) };
}
