/**
 * Reports the size of an outgoing AI request, split into its parts.
 *
 * Run: bun run scripts/measure-ai-payload.ts
 *
 * Token numbers come from estimateTokens() — an approximation, not a tokenizer.
 * See src/services/ai/token-estimate.ts for its calibration and error margin.
 */
import { Database } from 'bun:sqlite';
import { migrations } from '../src/database/migrations.ts';
import { ChatHistoryRepository } from '../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../src/database/repositories/user.repository.ts';
import { runMigrations } from '../src/database/schema.ts';
import { buildSystemPrompt } from '../src/services/ai/system-prompt.ts';
import { estimateTokens } from '../src/services/ai/token-estimate.ts';
import { getToolDefinitions, type UserCapabilities } from '../src/services/ai/tools.ts';
import type { AgentContext } from '../src/services/ai/types.ts';
import { ConversationLogger } from '../src/services/conversation-logger.ts';
import { EventService } from '../src/services/event/event-service.ts';
import { HolidayService } from '../src/services/holiday/holiday-service.ts';

interface Variant {
  label: string;
  ctx: AgentContext;
  caps?: UserCapabilities;
}

function buildBaseContext(): AgentContext {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  const chatHistory = new ChatHistoryRepository(db);
  const user = userRepo.create({
    telegram_id: 1,
    username: 'measure',
    first_name: 'Measure',
    timezone: 'Europe/Belgrade',
    language: 'ru',
  });
  return {
    user,
    chatId: 1,
    messageText: 'что у меня завтра?',
    isGroup: false,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    conversationLogger: new ConversationLogger(chatHistory),
    userRepo,
    eventReminderRepo: new EventReminderRepository(db),
  };
}

function buildVariants(base: AgentContext): Variant[] {
  return [
    { label: 'DM (default)', ctx: { ...base, inputMode: 'text' } },
    { label: 'group', ctx: { ...base, isGroup: true, groupTitle: 'Team', groupChatId: -100 } },
    { label: 'live_call', ctx: { ...base, inputMode: 'live_call' } },
    {
      label: 'supplement',
      ctx: { ...base, supplementMode: true, supplementAutoResponse: 'Событие создано.' },
    },
    { label: 'assistantEnabled', ctx: { ...base, inputMode: 'text' }, caps: { assistantEnabled: true } },
  ];
}

interface Row {
  label: string;
  toolCount: number;
  toolChars: number;
  toolTokens: number;
  promptChars: number;
  promptTokens: number;
  totalTokens: number;
}

function measure({ label, ctx, caps }: Variant): Row {
  const tools = getToolDefinitions(ctx.inputMode, caps, ctx.supplementMode);
  const toolJson = JSON.stringify(tools);
  const prompt = buildSystemPrompt(ctx, caps);
  const toolTokens = estimateTokens(toolJson);
  const promptTokens = estimateTokens(prompt);
  return {
    label,
    toolCount: tools.length,
    toolChars: toolJson.length,
    toolTokens,
    promptChars: prompt.length,
    promptTokens,
    totalTokens: toolTokens + promptTokens,
  };
}

function printTable(rows: Row[]): void {
  const header = ['mode', 'tools', 'tool chars', 'tool tok', 'prompt chars', 'prompt tok', 'total tok'];
  const body = rows.map((r) => [
    r.label,
    String(r.toolCount),
    String(r.toolChars),
    String(r.toolTokens),
    String(r.promptChars),
    String(r.promptTokens),
    String(r.totalTokens),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) console.log(line(row));
}

const base = buildBaseContext();
printTable(buildVariants(base).map(measure));
console.log('\nToken counts are estimates (±20%), not a tokenizer. Groq TPM limit for this account: 8000.');
