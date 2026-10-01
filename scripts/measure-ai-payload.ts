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
import { createToolExposure } from '../src/services/ai/tool-exposure.ts';
import { getToolDefinitions } from '../src/services/ai/tools.ts';
import type { AgentContext } from '../src/services/ai/types.ts';
import { ConversationLogger } from '../src/services/conversation-logger.ts';
import { EventService } from '../src/services/event/event-service.ts';
import { HolidayService } from '../src/services/holiday/holiday-service.ts';

interface Variant {
  label: string;
  ctx: AgentContext;
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
    { label: 'group', ctx: { ...base, inputMode: 'text', isGroup: true, groupTitle: 'Team', groupChatId: -100 } },
    { label: 'live_call', ctx: { ...base, inputMode: 'live_call' } },
    {
      label: 'supplement',
      ctx: { ...base, inputMode: 'text', supplementMode: true, supplementAutoResponse: 'Событие создано.' },
    },
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

function measure({ label, ctx }: Variant, schemas: 'full' | 'lazy_initial' | 'lazy_read' = 'full'): Row {
  const allTools = getToolDefinitions(ctx.inputMode, ctx.supplementMode);
  const exposure = schemas === 'full' ? undefined : createToolExposure(allTools);
  if (exposure && schemas === 'lazy_read') {
    const result = exposure.intercept(
      'discover_tools',
      { groups: ['calendar.read'], tools: ['calculate'] },
      exposure.snapshot(),
    );
    if (!result?.success || !result.output) throw new Error('Invalid payload fixture');
  }
  const tools = exposure?.schemas() ?? allTools;
  const toolJson = JSON.stringify(tools);
  const prompt = buildSystemPrompt(ctx) + (exposure ? `\n\n${exposure.prompt}` : '');
  const toolTokens = estimateTokens(toolJson);
  const promptTokens = estimateTokens(prompt);
  return {
    label: `${label} ${schemas}`,
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
const rows = buildVariants(base).flatMap((variant) =>
  (['full', 'lazy_initial', 'lazy_read'] as const).map((mode) => measure(variant, mode)),
);
if (Bun.argv.includes('--json')) {
  console.log(
    `PAYLOAD_JSON ${JSON.stringify({ measuredAt: new Date().toISOString(), kind: 'synthetic_payload_estimate', estimator: 'estimateTokens ±20%; no history/data/HTTP latency', rows })}`,
  );
} else {
  printTable(rows);
  console.log('\nIncludes the discovery schema and short index. Token counts are estimates (±20%), not billed usage.');
  console.log(
    'No history, retrieved user data or extra discovery-round latency is included. Account rate limits must be read from the provider, not this script.',
  );
}
