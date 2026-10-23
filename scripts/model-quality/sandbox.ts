import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { migrations } from '../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { buildSystemPrompt } from '../../src/services/ai/system-prompt.ts';
import { handleCalculate } from '../../src/services/ai/tool-handlers/calculate.ts';
import { toolSchemas } from '../../src/services/ai/tool-schemas.ts';
import { getToolDefinitions } from '../../src/services/ai/tools.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { HolidayService } from '../../src/services/holiday/holiday-service.ts';
import { type Args, type Call, type Fixture, isWrite, type Json } from './core.ts';
import { CLOCK } from './fixtures.ts';

const argumentsSchema = z.record(z.string(), z.json());
const db = new Database(':memory:');
runMigrations(db, migrations);
const userRepo = new UserRepository(db),
  eventRepo = new EventRepository(db),
  chatHistory = new ChatHistoryRepository(db);
const user = userRepo.create({
  telegram_id: 123,
  first_name: 'Тестовый пользователь',
  timezone: 'Europe/Belgrade',
  language: 'ru',
});
const context: AgentContext = {
  user,
  chatId: 123,
  messageText: '',
  isGroup: false,
  userRepo,
  eventService: new EventService({ eventRepo }),
  holidayService: new HolidayService(new HolidayRepository(db)),
  eventReminderRepo: new EventReminderRepository(db),
  chatHistory,
  conversationLogger: new ConversationLogger(chatHistory),
};
context.user.timezone_updated_at = '2026-09-27 08:00:00';
context.user.city = 'Belgrade';
export const tools = getToolDefinitions('text');
const validators = new Map(Object.entries(toolSchemas));
export function promptFor(fixture: Fixture): string {
  const c = {
    ...context,
    user: { ...context.user, language: fixture.language ?? 'ru' },
    isGroup: fixture.group ?? false,
    groupChatId: fixture.group ? -100123 : undefined,
    groupTitle: fixture.group ? 'Тестовая группа' : undefined,
  };
  const raw = buildSystemPrompt(c);
  if ((raw.match(/- Current local time:/g) ?? []).length !== 1) throw new Error('Prompt clock contract drift');
  return (
    raw.replace(/- Current local time:.*\n/, `- Current local time: ${CLOCK}\n`) +
    (fixture.context ? `\n\n## Recent conversation state\n${fixture.context}` : '')
  );
}
export function createSandbox(fixture: Fixture) {
  const events = structuredClone(fixture.events ?? []);
  const contacts = structuredClone(fixture.contacts ?? []);
  let nextId = 1000;
  return {
    events,
    execute(name: string, raw: unknown): { call: Call; result: Json; wait: boolean } {
      const object = argumentsSchema.safeParse(raw);
      let args: Args = object.success ? object.data : {};
      const validation = validators.get(name)?.safeParse(raw);
      const fail = (error: string) => ({
        call: { name, args, success: false, error },
        result: { success: false, error },
        wait: false,
      });
      if (!validation?.success) return fail('SCHEMA_INVALID');
      args = argumentsSchema.parse(validation.data);
      if (fixture.responses?.[name] !== undefined) {
        const result = fixture.responses[name]!;
        return {
          call: {
            name,
            args,
            success: !(result && typeof result === 'object' && !Array.isArray(result) && result.success === false),
          },
          result,
          wait: false,
        };
      }
      let result: Json = { success: true };
      let wait = false;
      const id = Number(args.event_id);
      if (isWrite({ name, args }) && !fixture.allowedWrites.includes(name))
        return fail('UNREQUESTED_MUTATION_BLOCKED_IN_SANDBOX');
      switch (name) {
        case 'calculate': {
          const r = handleCalculate(z.object({ expression: z.string() }).parse(args));
          result = { success: r.success, output: r.output ?? null, error: r.error ?? null };
          break;
        }
        case 'get_events': {
          const a = Date.parse(String(args.start_date)),
            b = Date.parse(String(args.end_date));
          result = {
            success: true,
            events: events.filter((e) => Date.parse(String(e.start_at)) >= a && Date.parse(String(e.start_at)) <= b),
          };
          break;
        }
        case 'get_event':
          result = { success: events.some((e) => e.id === id), event: events.find((e) => e.id === id) ?? null };
          break;
        case 'search_events':
          result = {
            success: true,
            events: events.filter(
              (e) => !args.query || String(e.title).toLowerCase().includes(String(args.query).toLowerCase()),
            ),
          };
          break;
        case 'get_upcoming':
          result = { success: true, events };
          break;
        case 'get_free_slots':
          result = {
            success: true,
            free_slots: [
              { start: '10:00', end: '12:00' },
              { start: '15:00', end: '19:00' },
            ],
          };
          break;
        case 'create_event': {
          const event = { ...args, id: nextId++ };
          events.push(event);
          result = { success: true, output: `Created event ${event.id}`, event };
          break;
        }
        case 'update_event': {
          const event = events.find((e) => e.id === id);
          if (!event) return fail('EVENT_NOT_FOUND');
          Object.assign(event, args);
          result = { success: true, event };
          break;
        }
        case 'delete_event': {
          const i = events.findIndex((e) => e.id === id);
          if (i < 0) return fail('EVENT_NOT_FOUND');
          events.splice(i, 1);
          result = { success: true, event_id: id, deleted: true };
          break;
        }
        case 'get_contacts':
        case 'find_contact':
          result = { success: true, contacts };
          break;
        case 'find_user':
          result = { success: false, error: 'NOT_FOUND' };
          break;
        case 'send_invitation':
          result = {
            success: true,
            invitation: {
              id: 301,
              event_id: id,
              invitee_id: args.invitee_id ?? null,
              status: 'pending',
              delivery_status: 'queued',
            },
            output: 'Invitation created; delivery pending, not delivered.',
          };
          break;
        case 'get_invitation_status':
          result = { success: true, invitations: [] };
          break;
        case 'get_action_log':
          result = {
            success: true,
            actions: events.map((e) => ({ action: 'create_event', success: true, event_id: e.id ?? null })),
          };
          break;
        case 'get_history':
          result = { success: true, history: fixture.context };
          break;
        case 'get_timezone_info':
          result = {
            success: true,
            timezone: args.timezone ?? 'Europe/Belgrade',
            offset: args.timezone === 'Europe/Moscow' ? '+03:00' : '+02:00',
            date: '2026-09-27',
          };
          break;
        case 'manage_settings':
          result = {
            success: true,
            settings: args.updates ?? { timezone: 'Europe/Belgrade', language: fixture.language ?? 'ru' },
          };
          break;
        case 'set_reminder':
          result = { success: true, event_id: id, minutes_before: args.minutes_before ?? [] };
          break;
        case 'ask_user':
        case 'pick_users':
          wait = true;
          result = { success: true, awaitingInput: true };
          break;
        case 'end_conversation':
          wait = true;
          break;
        default:
          if (name.startsWith('render_'))
            result = {
              success: true,
              output: 'Synthetic image rendered and delivered by the sandbox (no Telegram network).',
            };
          else if (name.startsWith('get_') || name.startsWith('list_'))
            result = { success: true, output: 'No additional records in this synthetic fixture.' };
          else return fail('UNIMPLEMENTED_SANDBOX_TOOL');
      }
      const ok = !(typeof result === 'object' && result !== null && !Array.isArray(result) && result.success === false);
      return { call: { name, args, success: ok }, result, wait };
    },
  };
}
