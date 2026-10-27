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
 *   bun run scripts/dryrun-tool-selection.ts                    # z.ai only (Claude is paid: DRYRUN_PROVIDERS=claude)
 *   DRYRUN_TOOL_MODE=hybrid bun run scripts/…                   # full|lazy|hybrid: how much of the catalog a request carries;
 *                                                               # lazy/hybrid follow discover_tools rounds and report how many
 *   DRYRUN_PROVIDERS=zai bun run scripts/dryrun-tool-selection.ts
 *   DRYRUN_MODEL_ZAI=glm-5.3 bun run scripts/…                  # override a model
 *   DRYRUN_OUT=before.json bun run scripts/…                     # save for diffing
 *   DRYRUN_ONLY=create-with-invite,agenda-week bun run scripts/…  # just those cases (reruns after provider timeouts)
 *
 * Model ids are read from env so they can follow provider changes without edits.
 */
import { Database } from 'bun:sqlite';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type OpenAI from 'openai';
import { z } from 'zod';
import { loadConfig } from '../src/config/env.ts';
import { migrations } from '../src/database/migrations.ts';
import { ChatHistoryRepository } from '../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../src/database/repositories/user.repository.ts';
import { runMigrations } from '../src/database/schema.ts';
import { claudeClient, hfClient, openrouterClient, zaiClient } from '../src/services/ai/clients.ts';
import type { ProviderId } from '../src/services/ai/provider-ids.ts';
import { acceptsSamplingTemperature, CLAUDE_MAX_OUTPUT_TOKENS } from '../src/services/ai/streaming.ts';
import { assembleSystemPrompt, buildSystemPromptParts } from '../src/services/ai/system-prompt.ts';
import { estimateTokens } from '../src/services/ai/token-estimate.ts';
import { createToolExposure, DISCOVERY_TOOL } from '../src/services/ai/tool-exposure.ts';
import { TOOL_SCHEMA_MODES, type ToolSchemaMode } from '../src/services/ai/tool-schema-mode.ts';
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
 *  truncates the turn and looks like "the model chose no tool" (finishReason `length`). DRYRUN_MAX_TOKENS raises it. */
const MAX_COMPLETION_TOKENS = Number(process.env.DRYRUN_MAX_TOKENS) > 0 ? Number(process.env.DRYRUN_MAX_TOKENS) : 2048;
/** A first move that needs more model rounds than this (discovery or blind retries) is a failed case; production allows six discovery attempts, a first move rarely needs more than one. */
const MAX_ROUNDS = 4;
/** The production client gives up after 15 s; a dry run measures tool choice, not latency, so it waits longer (DRYRUN_TIMEOUT_MS). */
const REQUEST_TIMEOUT_MS = Number(process.env.DRYRUN_TIMEOUT_MS) > 0 ? Number(process.env.DRYRUN_TIMEOUT_MS) : 90_000;
/** The SDK retries 429 with backoff; the production clients disable retries, a dry run must not score a rate limit as a miss. */
const RATE_LIMIT_RETRIES = 4;

function toolMode(): ToolSchemaMode {
  const wanted = process.env.DRYRUN_TOOL_MODE ?? 'full';
  const mode = TOOL_SCHEMA_MODES.find((candidate) => candidate === wanted);
  if (!mode) throw new Error(`DRYRUN_TOOL_MODE must be one of ${TOOL_SCHEMA_MODES.join(', ')}, got ${wanted}`);
  return mode;
}

interface ProviderSpec {
  name: ProviderId;
  model: string;
  client: () => OpenAI;
}

function providers(): ProviderSpec[] {
  const cfg = loadConfig();
  const wanted = (process.env.DRYRUN_PROVIDERS ?? 'zai').split(',').map((s) => s.trim());
  const all: ProviderSpec[] = [
    { name: 'zai', model: process.env.DRYRUN_MODEL_ZAI ?? cfg.ZAI_MODEL ?? 'glm-5.3', client: zaiClient },
    { name: 'hf', model: process.env.DRYRUN_MODEL_HF ?? cfg.HF_MODEL ?? '', client: hfClient },
    {
      name: 'claude',
      model: process.env.DRYRUN_MODEL_CLAUDE ?? cfg.CLAUDE_MODEL ?? 'claude-sonnet-5-5',
      client: claudeClient,
    },
    {
      name: 'openrouter',
      model: process.env.DRYRUN_MODEL_OPENROUTER ?? cfg.OPENROUTER_MODEL ?? '',
      client: openrouterClient,
    },
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
    ...(testCase.addressContext ? { preloadedAddressContext: testCase.addressContext } : {}),
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

export interface CaseOutcome {
  id: string;
  provider: string;
  /** What was actually requested, so two saved runs can be compared or reproduced. */
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  tools: string[];
  text: string;
  promptTokens: number | null;
  finishReason: string | null;
  error: string | null;
  /** Rounds that contained a discover_tools call (also when a carried real tool shared the batch); always 0 when the request carries every schema. */
  discoverRounds: number;
  /** Real tools called without a schema in the request; production rejects the call and reveals the schema. */
  blindCalls: number;
  ok: boolean;
}

/** Tools the group prompt allows before [SKIP], because they produce no message. */
const SILENT_TOOLS = ['set_reaction', 'remember_user_fact', 'send_feedback'];

/**
 * Tools that destroy something and that the prompt therefore forbids as an
 * opening move: the model must enumerate what it would affect and get
 * confirmation first. A case may list one anyway, and then it is judged on the
 * allow-list alone — but no case does today.
 */
const DESTRUCTIVE_TOOLS = ['delete_event', 'cancel_invitation', 'remove_trigger'];

export function verdict(testCase: DryRunCase, tools: string[], text: string): boolean {
  if (testCase.expectSilence) {
    return text.trim() === '[SKIP]' && tools.every((name) => SILENT_TOOLS.includes(name));
  }
  const expected = testCase.expectAnyOf;
  // Checked before the allow-list, because models call tools in parallel: a turn
  // of [get_events, delete_event] would otherwise pass on get_events alone, and
  // "deletes without confirming" is exactly the drift these cases exist to catch.
  const forbidden = tools.filter((name) => DESTRUCTIVE_TOOLS.includes(name) && !expected.includes(name));
  if (forbidden.length > 0) return false;
  return tools.some((name) => expected.includes(name));
}

type FunctionCall = OpenAI.ChatCompletionMessageFunctionToolCall;

/** The part of the run's tool exposure a case needs: the schemas a request carries and how a discovery call is answered. */
interface RunExposure {
  schemas(): OpenAI.ChatCompletionTool[];
  snapshot(): ReadonlySet<string>;
  intercept(
    name: string,
    input: unknown,
    exposedThisRound: ReadonlySet<string>,
  ): { output?: string; error?: string } | undefined;
}

/** Everything one case's rounds share: the growing conversation, the catalog it draws on and the discovery tally. */
interface CaseRun {
  provider: ProviderSpec;
  testCase: DryRunCase;
  allowed: OpenAI.ChatCompletionTool[];
  exposure: RunExposure | undefined;
  messages: OpenAI.ChatCompletionMessageParam[];
  /** What was actually requested, so two saved runs can be compared or reproduced. */
  settings: { model: string; temperature: number | null; maxTokens: number };
  discoverRounds: number;
  blindCalls: number;
  firstPromptTokens: number | null;
}

/** What a model round asked for, split into the tools that count as its first move and the ones that do not. */
export interface TurnClassification {
  discovered: boolean;
  /** Real tools called without a schema in the request. */
  blind: string[];
  firstMoves: string[];
  needsAnotherRound: boolean;
}

export function classifyTurn(tools: string[], exposed: ReadonlySet<string> | undefined): TurnClassification {
  const discovered = tools.includes(DISCOVERY_TOOL);
  const blind = exposed ? tools.filter((name) => name !== DISCOVERY_TOOL && !exposed.has(name)) : [];
  // A batch that already holds a real tool the request carried is the model's first move: production runs it in this round.
  const firstMoves = tools.filter((name) => name !== DISCOVERY_TOOL && !blind.includes(name));
  const needsAnotherRound = firstMoves.length === 0 && (blind.length > 0 || discovered);
  return { discovered, blind, firstMoves, needsAnotherRound };
}

interface Turn extends TurnClassification {
  message: OpenAI.ChatCompletionMessage | undefined;
  calls: FunctionCall[];
  text: string;
  finishReason: string | null;
}

function readTurn(res: OpenAI.ChatCompletion, exposed: ReadonlySet<string> | undefined): Turn {
  const message = res.choices[0]?.message;
  const calls = (message?.tool_calls ?? []).flatMap((call) => ('function' in call ? [call] : []));
  const tools = calls.map((call) => call.function.name);
  return {
    message,
    calls,
    text: message?.content ?? '',
    finishReason: res.choices[0]?.finish_reason ?? null,
    ...classifyTurn(tools, exposed),
  };
}

function prepareRun(provider: ProviderSpec, testCase: DryRunCase): CaseRun {
  const mode = toolMode();
  const ctx = buildContext(testCase);
  const allowed = getToolDefinitions(ctx.inputMode, ctx.supplementMode);
  const exposure = mode === 'full' ? undefined : createToolExposure(allowed, mode);
  return {
    provider,
    testCase,
    allowed,
    exposure,
    messages: [
      { role: 'system', content: assembleSystemPrompt(buildSystemPromptParts(ctx), exposure?.prompt) },
      ...buildMessages(testCase),
    ],
    settings: {
      model: provider.model,
      temperature: acceptsSamplingTemperature(provider.name) ? 0 : null,
      maxTokens: provider.name === 'claude' ? CLAUDE_MAX_OUTPUT_TOKENS : MAX_COMPLETION_TOKENS,
    },
    discoverRounds: 0,
    blindCalls: 0,
    firstPromptTokens: null,
  };
}

function requestRound(run: CaseRun): Promise<OpenAI.ChatCompletion> {
  const { provider, exposure, allowed, messages, settings } = run;
  return provider.client().chat.completions.create(
    {
      model: provider.model,
      messages,
      tools: exposure ? exposure.schemas() : allowed,
      max_tokens: settings.maxTokens,
      ...(settings.temperature === null ? {} : { temperature: settings.temperature }),
    },
    { timeout: REQUEST_TIMEOUT_MS, maxRetries: RATE_LIMIT_RETRIES },
  );
}

/** Answers a discovery round the way production would, so the next round can use what it revealed. */
function answerDiscoveryRound(
  run: CaseRun,
  exposure: RunExposure,
  exposed: ReadonlySet<string>,
  message: OpenAI.ChatCompletionMessage,
  calls: FunctionCall[],
): void {
  run.messages.push({ role: 'assistant', content: message.content, tool_calls: calls });
  for (const call of calls) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      // Malformed arguments are the model's miss; the exposure answers the call as it would in production.
    }
    const result = exposure.intercept(call.function.name, input, exposed);
    // Real tools are not executed in a dry run: the first move is what is judged.
    run.messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: result ? (result.output ?? result.error ?? '') : '{"dry_run":"not executed"}',
    });
  }
}

/** The outcome of the round that settled the case (no further discovery round to follow). */
function settledOutcome(run: CaseRun, turn: Turn): CaseOutcome {
  const { provider, testCase, settings } = run;
  // Production cuts Claude's visible output at the caller budget on the stream; this
  // non-streaming replay cannot, so an answer past the budget scores as that cut.
  const visible = turn.text + turn.calls.map((call) => call.function.name + call.function.arguments).join('');
  const cut = provider.name === 'claude' && estimateTokens(visible) > MAX_COMPLETION_TOKENS;
  return {
    id: testCase.id,
    provider: provider.name,
    ...settings,
    tools: turn.firstMoves,
    text: turn.text,
    promptTokens: run.firstPromptTokens,
    finishReason: cut ? 'length' : turn.finishReason,
    error: null,
    discoverRounds: run.discoverRounds,
    blindCalls: run.blindCalls,
    // A request still discovering on the last round has not chosen a first move.
    ok: !cut && !turn.needsAnotherRound && verdict(testCase, turn.firstMoves, turn.text),
  };
}

function failedOutcome(run: CaseRun, err: unknown): CaseOutcome {
  const message = err instanceof Error ? err.message : String(err);
  return {
    id: run.testCase.id,
    provider: run.provider.name,
    ...run.settings,
    tools: [],
    text: '',
    promptTokens: null,
    finishReason: null,
    error: message.slice(0, 160).replace(/\s+/g, ' '),
    discoverRounds: run.discoverRounds,
    blindCalls: run.blindCalls,
    ok: false,
  };
}

async function runCase(provider: ProviderSpec, testCase: DryRunCase): Promise<CaseOutcome> {
  const run = prepareRun(provider, testCase);
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const exposed = run.exposure?.snapshot();
      const res = await requestRound(run);
      if (round === 0) run.firstPromptTokens = res.usage?.prompt_tokens ?? null;
      const turn = readTurn(res, exposed);
      if (turn.discovered) run.discoverRounds++;
      run.blindCalls += turn.blind.length;
      if (run.exposure && exposed && turn.message && turn.needsAnotherRound && round < MAX_ROUNDS - 1) {
        answerDiscoveryRound(run, run.exposure, exposed, turn.message, turn.calls);
        continue;
      }
      return settledOutcome(run, turn);
    }
    throw new Error('the last round always returns');
  } catch (err) {
    return failedOutcome(run, err);
  }
}

/** One result line: pass mark, provider, case id and what the model chose (or why there is no choice). */
export function formatOutcomeRow(o: CaseOutcome): string {
  const mark = o.ok ? 'ok  ' : 'FAIL';
  const reason = o.finishReason && o.finishReason !== 'tool_calls' ? ` [${o.finishReason}]` : '';
  const said = o.tools.length === 0 ? `"${o.text.trim().slice(0, 40)}"` : '';
  const detail = o.error ? `ERROR ${o.error}` : `${o.tools.join(',') || said || '(no tool calls)'}${reason}`;
  const discovery =
    o.discoverRounds + o.blindCalls > 0 ? ` (discover rounds ${o.discoverRounds}, blind ${o.blindCalls})` : '';
  return `${mark} ${o.provider.padEnd(7)} ${o.id.padEnd(22)} ${detail}${discovery}`;
}

interface ProviderTotals {
  pass: number;
  total: number;
  tokens: number[];
  rounds: number;
  blind: number;
}

export function totalsByProvider(outcomes: CaseOutcome[]): Map<string, ProviderTotals> {
  const byProvider = new Map<string, ProviderTotals>();
  for (const o of outcomes) {
    const agg = byProvider.get(o.provider) ?? { pass: 0, total: 0, tokens: [], rounds: 0, blind: 0 };
    agg.total++;
    if (o.ok) agg.pass++;
    if (o.promptTokens !== null) agg.tokens.push(o.promptTokens);
    agg.rounds += o.discoverRounds;
    agg.blind += o.blindCalls;
    byProvider.set(o.provider, agg);
  }
  return byProvider;
}

function report(outcomes: CaseOutcome[]): void {
  for (const o of outcomes) console.log(formatOutcomeRow(o));
  console.log('');
  for (const [name, agg] of totalsByProvider(outcomes)) {
    const avg = agg.tokens.length > 0 ? Math.round(agg.tokens.reduce((a, b) => a + b, 0) / agg.tokens.length) : null;
    console.log(
      `${name}: ${agg.pass}/${agg.total} cases matched; first-request prompt_tokens avg ${avg ?? 'n/a'}; ` +
        `discover_tools rounds ${agg.rounds}, blind calls ${agg.blind} (tool mode ${toolMode()})`,
    );
  }
}

const corpusCaseBase = {
  id: z.string(),
  message: z.string(),
  group: z.boolean().optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).optional(),
  addressContext: z.string().optional(),
};
const corpusSchema = z.array(
  z.union([
    z.object({
      ...corpusCaseBase,
      expectAnyOf: z.tuple([z.string()], z.string()),
      expectSilence: z.literal(false).optional(),
    }),
    z.object({ ...corpusCaseBase, expectSilence: z.literal(true), expectAnyOf: z.undefined().optional() }),
  ]),
);

/**
 * DRYRUN_CORPUS=path.json replaces the built-in cases with a (scrubbed) historical corpus of the same shape.
 * DRYRUN_ONLY=id,id reruns just those cases, e.g. the ones a provider timed out on.
 */
async function selectedCases(): Promise<DryRunCase[]> {
  const corpus = process.env.DRYRUN_CORPUS;
  const cases: DryRunCase[] = corpus ? corpusSchema.parse(await Bun.file(corpus).json()) : DRYRUN_CASES;
  const only = process.env.DRYRUN_ONLY?.split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (!only || only.length === 0) return cases;
  const unknown = only.filter((id) => !cases.some((testCase) => testCase.id === id));
  if (unknown.length > 0) throw new Error(`Unknown case id(s) in DRYRUN_ONLY: ${unknown.join(', ')}`);
  return cases.filter((testCase) => only.includes(testCase.id));
}

/** DRYRUN_CONCURRENCY=n cases in flight at once (default 1); order of the saved outcomes stays the case order. */
async function runAll(provider: ProviderSpec, cases: DryRunCase[]): Promise<CaseOutcome[]> {
  const workers = Math.max(1, Number(process.env.DRYRUN_CONCURRENCY ?? 1) || 1);
  const results: CaseOutcome[] = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, cases.length) }, async () => {
      for (let index = next++; index < cases.length; index = next++) {
        const testCase = cases[index];
        if (testCase) results[index] = await runCase(provider, testCase);
      }
    }),
  );
  return results;
}

async function main(): Promise<void> {
  const outcomes: CaseOutcome[] = [];
  const cases = await selectedCases();
  for (const provider of providers()) outcomes.push(...(await runAll(provider, cases)));
  report(outcomes);
  const out = process.env.DRYRUN_OUT;
  if (out) {
    await Bun.write(out, JSON.stringify(outcomes, null, 2));
    console.log(`\nwrote ${out}`);
  }
  // A before/after comparison is usually scripted, and a run where every case
  // failed printed its FAIL rows and then exited 0 — reported as a pass by
  // anything reading the status rather than the output.
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} of ${outcomes.length} case runs failed`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
