/**
 * Sends production-shaped user requests to real models and reports which tools
 * each one picks.
 *
 * Purpose: show that shrinking tool descriptions or the system prompt does not
 * change tool selection. Run it before a change and after it, then compare.
 *
 * The request is assembled the way the agent assembles one — the real system
 * prompt, the real tool catalog, and history turns carrying the same local
 * timestamp and group sender prefix the agent adds. It is not a replay of a
 * stored conversation: history here is short and hand-built, so a passing run is
 * evidence about tool choice for a request of this shape, not proof about a long
 * production conversation.
 *
 *   bun run scripts/dryrun-tool-selection.ts                    # all providers
 *   DRYRUN_PROVIDERS=gemini bun run scripts/dryrun-tool-selection.ts
 *   DRYRUN_MODEL_GEMINI=models/gemini-3-flash bun run scripts/…  # override a model
 *   DRYRUN_OUT=before.json bun run scripts/…                     # save for diffing
 *
 * Model ids are read from env so they can follow provider changes without edits.
 */
import { Database } from 'bun:sqlite';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type OpenAI from 'openai';
import { loadConfig } from '../src/config/env.ts';
import { migrations } from '../src/database/migrations.ts';
import { ChatHistoryRepository } from '../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../src/database/repositories/user.repository.ts';
import { runMigrations } from '../src/database/schema.ts';
import { geminiClient, groqClient, hfClient, zaiClient } from '../src/services/ai/clients.ts';
import { buildSystemPrompt } from '../src/services/ai/system-prompt.ts';
import { getToolDefinitions } from '../src/services/ai/tools.ts';
import type { AgentContext } from '../src/services/ai/types.ts';
import { ConversationLogger } from '../src/services/conversation-logger.ts';
import { EventService } from '../src/services/event/event-service.ts';
import { HolidayService } from '../src/services/holiday/holiday-service.ts';
import { DRYRUN_CASES, type DryRunCase } from './dryrun-cases.ts';

const TIMEZONE = 'Europe/Belgrade';
const SENDER_NAME = 'Alex';
const SENDER_ID = 1;
/** Reasoning models spend completion tokens before the tool call; a tight cap
 *  truncates the turn and looks like "the model chose no tool". */
const MAX_COMPLETION_TOKENS = 2048;

interface ProviderSpec {
  name: string;
  model: string;
  client: () => OpenAI;
}

function providers(): ProviderSpec[] {
  const cfg = loadConfig();
  const wanted = (process.env.DRYRUN_PROVIDERS ?? 'gemini,groq').split(',').map((s) => s.trim());
  const all: ProviderSpec[] = [
    { name: 'zai', model: process.env.DRYRUN_MODEL_ZAI ?? cfg.ZAI_MODEL ?? 'glm-5.1', client: zaiClient },
    {
      name: 'groq',
      model: process.env.DRYRUN_MODEL_GROQ ?? cfg.GROQ_MODEL ?? 'openai/gpt-oss-120b',
      client: groqClient,
    },
    {
      name: 'gemini',
      model: process.env.DRYRUN_MODEL_GEMINI ?? cfg.GEMINI_MODEL ?? 'models/gemini-2.5-flash',
      client: geminiClient,
    },
    { name: 'hf', model: process.env.DRYRUN_MODEL_HF ?? cfg.HF_MODEL ?? '', client: hfClient },
  ];
  const unknown = wanted.filter((name) => !all.some((p) => p.name === name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown provider(s) in DRYRUN_PROVIDERS: ${unknown.join(', ')}. Known: ${all.map((p) => p.name).join(', ')}`,
    );
  }
  return all.filter((p) => wanted.includes(p.name));
}

function buildContext(testCase: DryRunCase): AgentContext {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  const chatHistory = new ChatHistoryRepository(db);
  const user = userRepo.create({
    telegram_id: SENDER_ID,
    username: 'dryrun',
    first_name: SENDER_NAME,
    timezone: TIMEZONE,
    language: 'ru',
  });
  const base: AgentContext = {
    user,
    chatId: 1,
    messageText: testCase.message,
    isGroup: false,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    conversationLogger: new ConversationLogger(chatHistory),
    userRepo,
    eventReminderRepo: new EventReminderRepository(db),
    inputMode: 'text',
  };
  if (!testCase.group) return base;
  return { ...base, isGroup: true, groupTitle: 'Друзья', groupChatId: -1001 };
}

/** Same prefixes the agent puts on a turn: local timestamp, then group sender. */
function tagTurn(text: string, role: 'user' | 'assistant', group: boolean, minutesAgo: number): string {
  const at = new TZDate(new Date(Date.now() - minutesAgo * 60_000), TIMEZONE);
  const stamp = format(at, 'yyyy-MM-dd HH:mm:ss');
  const sender = group && role === 'user' ? `[From: ${SENDER_NAME} (id:${SENDER_ID})] ` : '';
  return `[${stamp}] ${sender}${text}`;
}

function buildMessages(testCase: DryRunCase): OpenAI.ChatCompletionMessageParam[] {
  const history = testCase.history ?? [];
  const turns = history.map((turn, i): OpenAI.ChatCompletionMessageParam => {
    const minutesAgo = (history.length - i) * 2;
    return { role: turn.role, content: tagTurn(turn.content, turn.role, testCase.group === true, minutesAgo) };
  });
  return [...turns, { role: 'user', content: tagTurn(testCase.message, 'user', testCase.group === true, 0) }];
}

interface CaseOutcome {
  id: string;
  provider: string;
  tools: string[];
  promptTokens: number | null;
  finishReason: string | null;
  error: string | null;
  ok: boolean;
}

function verdict(testCase: DryRunCase, tools: string[]): boolean {
  if (testCase.expectNoTools) return tools.length === 0;
  return tools.some((name) => testCase.expectAnyOf.includes(name));
}

/**
 * Groq's tier caps tokens per minute; its 429 says how long to wait. Waiting only
 * helps when the request would fit on its own — a request larger than the whole
 * per-minute allowance never becomes servable, so that case fails immediately.
 */
function retryDelayMs(message: string): number | null {
  if (!message.includes('rate_limit') && !message.includes('Rate limit')) return null;
  const requested = message.match(/Requested (\d+)/);
  const limit = message.match(/Limit (\d+)/);
  if (requested && limit && Number(requested[1]) > Number(limit[1])) return null;
  const seconds = message.match(/try again in ([\d.]+)s/);
  return seconds ? Math.ceil(Number(seconds[1]) * 1000) + 500 : 20_000;
}

async function completeWithRetry(
  provider: ProviderSpec,
  request: OpenAI.ChatCompletionCreateParamsNonStreaming,
): Promise<OpenAI.ChatCompletion> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.client().chat.completions.create(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const delay = attempt < 3 ? retryDelayMs(message) : null;
      if (delay === null) throw err;
      console.log(`  … ${provider.name} rate-limited, waiting ${Math.round(delay / 1000)}s`);
      await Bun.sleep(delay);
    }
  }
}

async function runCase(provider: ProviderSpec, testCase: DryRunCase): Promise<CaseOutcome> {
  const ctx = buildContext(testCase);
  const request: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model: provider.model,
    messages: [{ role: 'system', content: buildSystemPrompt(ctx) }, ...buildMessages(testCase)],
    tools: getToolDefinitions(ctx.inputMode, undefined, ctx.supplementMode),
    max_tokens: MAX_COMPLETION_TOKENS,
    temperature: 0,
  };
  try {
    const res = await completeWithRetry(provider, request);
    const calls = res.choices[0]?.message.tool_calls ?? [];
    const tools = calls.map((c) => ('function' in c ? c.function.name : c.type));
    return {
      id: testCase.id,
      provider: provider.name,
      tools,
      promptTokens: res.usage?.prompt_tokens ?? null,
      finishReason: res.choices[0]?.finish_reason ?? null,
      error: null,
      ok: verdict(testCase, tools),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: testCase.id,
      provider: provider.name,
      tools: [],
      promptTokens: null,
      finishReason: null,
      error: message.slice(0, 160).replace(/\s+/g, ' '),
      ok: false,
    };
  }
}

function report(outcomes: CaseOutcome[]): void {
  for (const o of outcomes) {
    const mark = o.ok ? 'ok  ' : 'FAIL';
    const reason = o.finishReason && o.finishReason !== 'tool_calls' ? ` [${o.finishReason}]` : '';
    const detail = o.error ? `ERROR ${o.error}` : `${o.tools.join(',') || '(no tool calls)'}${reason}`;
    console.log(`${mark} ${o.provider.padEnd(7)} ${o.id.padEnd(22)} ${detail}`);
  }
  const byProvider = new Map<string, { pass: number; total: number; tokens: number[] }>();
  for (const o of outcomes) {
    const agg = byProvider.get(o.provider) ?? { pass: 0, total: 0, tokens: [] };
    agg.total++;
    if (o.ok) agg.pass++;
    if (o.promptTokens !== null) agg.tokens.push(o.promptTokens);
    byProvider.set(o.provider, agg);
  }
  console.log('');
  for (const [name, agg] of byProvider) {
    const avg = agg.tokens.length > 0 ? Math.round(agg.tokens.reduce((a, b) => a + b, 0) / agg.tokens.length) : null;
    console.log(`${name}: ${agg.pass}/${agg.total} cases matched; prompt_tokens avg ${avg ?? 'n/a'}`);
  }
}

async function main(): Promise<void> {
  const outcomes: CaseOutcome[] = [];
  for (const provider of providers()) {
    for (const testCase of DRYRUN_CASES) {
      outcomes.push(await runCase(provider, testCase));
    }
  }
  report(outcomes);
  const out = process.env.DRYRUN_OUT;
  if (out) {
    await Bun.write(out, JSON.stringify(outcomes, null, 2));
    console.log(`\nwrote ${out}`);
  }
}

await main();
