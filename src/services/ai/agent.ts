import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import OpenAI from 'openai';
import { z } from 'zod';
import { type Lang, t, toLang } from '../../config/constants.ts';
import type { ChatHistoryMessage } from '../../database/types.ts';
import { isBalanceExhausted } from '../../utils/ai-provider-alert.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { logger } from '../../utils/logger.ts';
import { type ActivityEvent, formatActivityEvent } from './activity-event.ts';
import type { AiDebugLogger, AiDebugRunContext } from './debug-logger.ts';
import type { HistorySummarizer } from './history-summarizer.ts';
import { validateResponse } from './response-validator.ts';
import { AllProvidersFailedError, aiStreamRound, type StreamCallbacks } from './streaming.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { TelegramStreamWriter } from './telegram-stream.ts';
import { executeTool, SILENT_TOOLS, SKIP_PERSIST_TOOLS } from './tool-executor.ts';
import { toolSchemas } from './tool-schemas.ts';
import { getToolDefinitions } from './tools.ts';
import type { AgentConfig, AgentContext, TelegramSender } from './types.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

const MAX_ROUNDS = 15;
const TIMEOUT_MS = 300_000;

/**
 * One apology covers a user for this long. A user who keeps writing during an
 * outage gets at most one playful "one sec", then one honest "the AI is down,
 * here is what still works", then silence — not five apologies in a row.
 */
const NOTICE_COOLDOWN_MS = 5 * 60_000;

/** Records older than this are dropped so the map cannot grow without bound. */
const NOTICE_RETENTION_MS = 60 * 60_000;

/**
 * Hard cap on tracked users. The age-based prune alone is not enough: a burst of
 * failures across many distinct users inside one retention window would grow the
 * map unchecked. Past the cap the least recently notified users are evicted —
 * they simply lose the "don't repeat the same apology" memory.
 */
const MAX_TRACKED_USERS = 10_000;

/**
 * What the bot says to the user when a run fails.
 *  - `stall`  — a playful "one sec, be right back". Only legitimate when a retry
 *               is actually scheduled, because it promises a comeback.
 *  - `honest` — the AI is unavailable, here are the commands that still work.
 *               No promise, so nothing to break.
 *  - `silent` — the user has already been told twice; say nothing.
 */
export type FailureNoticeKind = 'stall' | 'honest' | 'silent';

export interface FailureNotice {
  kind: FailureNoticeKind;
  /** Empty for `silent`. */
  text: string;
}

interface NoticeRecord {
  kind: 'stall' | 'honest';
  text: string;
  sentAt: number;
}

export interface FailureNoticeOptions {
  /** The provider chain is down for a known, non-transient reason. */
  hardOutage: boolean;
  /** A backoff retry will actually be scheduled — without it a promise is a lie. */
  willRetry: boolean;
  now?: number;
}

/**
 * Per-user memory of what the bot last said about an AI failure.
 *
 * Lives at module scope (rather than on the agent instance) because the pieces
 * that need it run in different places: the agent produces the notice, and the
 * retry layers — bot pipeline and BullMQ worker — need to know afterwards
 * whether a comeback was promised, so the give-up message can close that loop
 * instead of arriving out of nowhere. State is in-memory only; after a restart
 * the give-up simply does not reference a promise it can no longer verify.
 */
class AiFailureNoticeTracker {
  private byUser = new Map<number, NoticeRecord>();

  /** Decide what to tell the user about this failure, and remember it. */
  decide(userId: number, lang: Lang, opts: FailureNoticeOptions): FailureNotice {
    const now = opts.now ?? Date.now();
    this.prune(now);
    const previous = this.byUser.get(userId);
    const withinCooldown = previous !== undefined && now - previous.sentAt < NOTICE_COOLDOWN_MS;

    if (opts.hardOutage || !opts.willRetry) {
      return this.record(userId, 'honest', t(lang).ai_degraded, now, withinCooldown && previous.kind === 'honest');
    }
    if (!withinCooldown) {
      return this.record(userId, 'stall', t(lang).agent_error(previous?.text), now, false);
    }
    // A comeback was already promised and has not been delivered — repeating the
    // promise is what makes the bot look like a broken record. Tell the truth.
    if (previous.kind === 'stall') {
      return this.record(userId, 'honest', t(lang).ai_degraded, now, false);
    }
    return { kind: 'silent', text: '' };
  }

  private record(
    userId: number,
    kind: 'stall' | 'honest',
    text: string,
    now: number,
    alreadySaid: boolean,
  ): FailureNotice {
    if (alreadySaid) return { kind: 'silent', text: '' };
    // Delete before set so Map iteration order tracks recency, not first sight.
    this.byUser.delete(userId);
    this.byUser.set(userId, { kind, text, sentAt: now });
    this.evictOverflow();
    return { kind, text };
  }

  /**
   * Read and clear the outstanding notice for a user. Returns `stall` when the
   * bot promised a comeback it still owes, `honest` when it already admitted the
   * outage, `null` when it said nothing (or the process restarted).
   */
  takeNotice(userId: number): 'stall' | 'honest' | null {
    const record = this.byUser.get(userId);
    if (!record) return null;
    this.byUser.delete(userId);
    return record.kind;
  }

  /** The bot answered — any outstanding promise is settled. */
  clear(userId: number): void {
    this.byUser.delete(userId);
  }

  /** Test hook: drop all remembered notices. */
  reset(): void {
    this.byUser.clear();
  }

  private evictOverflow(): void {
    while (this.byUser.size > MAX_TRACKED_USERS) {
      const oldest = this.byUser.keys().next();
      if (oldest.done) return;
      this.byUser.delete(oldest.value);
    }
  }

  /** Test hook: how many users are currently remembered. */
  size(): number {
    return this.byUser.size;
  }

  private prune(now: number): void {
    for (const [userId, record] of this.byUser) {
      if (now - record.sentAt > NOTICE_RETENTION_MS) this.byUser.delete(userId);
    }
  }
}

export const aiFailureNotices = new AiFailureNoticeTracker();

/**
 * The closing message once the retry budget is spent. It references the earlier
 * "one sec" so the two messages read as one conversation. Returns null when the
 * user was already told the AI is down — a second notice would only be noise.
 */
export function agentGiveUpMessage(userId: number, lang: Lang): string | null {
  const notice = aiFailureNotices.takeNotice(userId);
  if (notice === 'honest') return null;
  return t(lang).agent_give_up(notice === 'stall');
}

/**
 * A failure the retry budget cannot fix: exhausted balance/quota, or dead
 * credentials. Promising a comeback for these is a lie — the retries will fail
 * exactly the same way three minutes later.
 */
function isHardOutage(error: unknown): boolean {
  // The chain reports a total outage as one aggregate rather than rethrowing the
  // last provider's error, so inspect the per-provider verdicts. If not one slot
  // looked merely down, a retry three minutes later hits the same wall.
  if (error instanceof AllProvidersFailedError) {
    return error.failures.every((failure) => !failure.transient);
  }
  if (isBalanceExhausted(error)) return true;
  return error instanceof OpenAI.APIError && (error.status === 401 || error.status === 403);
}

type MessageParam = OpenAI.ChatCompletionMessageParam;

function isToolMessage(msg: MessageParam): msg is OpenAI.ChatCompletionToolMessageParam {
  return msg.role === 'tool';
}

function withTimestamp(text: string, createdAt: string, timezone: string): string {
  const local = format(new TZDate(new Date(`${createdAt}Z`), timezone), 'yyyy-MM-dd HH:mm:ss');
  return `[${local}] ${text}`;
}

/**
 * Sanitize message history before handing it to the model.
 *
 * Two invariants, both enforced to keep OpenAI-compatible providers happy:
 *   1. The first non-system message must be a user message. If the history
 *      begins with an assistant or tool turn (e.g. a leading bot reply after
 *      migration), insert a '...' user placeholder.
 *   2. Every assistant message with `tool_calls` must be followed by one
 *      tool-role message per tool_call_id. If any id is unmatched — usually
 *      because a previous run crashed mid-loop and left an orphaned assistant
 *      turn in `chat_history` — strip the `tool_calls` field entirely and
 *      fall back to the text content (or drop the message if it's empty).
 *      Without this, OpenAI returns `400 - An assistant message with
 *      'tool_calls' must be followed by tool messages`.
 */
function sanitizeMessages(messages: MessageParam[]): MessageParam[] {
  const paired: MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (
      msg.role !== 'assistant' ||
      !('tool_calls' in msg) ||
      !Array.isArray(msg.tool_calls) ||
      msg.tool_calls.length === 0
    ) {
      paired.push(msg);
      continue;
    }
    // Collect tool_call_ids from the following consecutive tool messages.
    const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
    const foundIds = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      const toolMsg = messages[j] as OpenAI.ChatCompletionToolMessageParam;
      if (toolMsg.tool_call_id) foundIds.add(toolMsg.tool_call_id);
      j++;
    }
    const allPaired = expectedIds.size > 0 && [...expectedIds].every((id) => foundIds.has(id));
    if (allPaired) {
      paired.push(msg);
      continue;
    }
    // Orphaned tool_calls — strip them. Preserve any text content as a fallback;
    // otherwise drop the assistant turn altogether so we don't leave an empty
    // `assistant` message in the list.
    const textContent = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (textContent) {
      paired.push({ role: 'assistant', content: textContent });
    }
    // Note: we intentionally don't skip the orphaned trailing tool messages —
    // OpenAI rejects tool messages without a matching tool_call above, so we
    // also filter those out.
    for (let k = i + 1; k < j; k++) {
      const toolMsg = messages[k] as OpenAI.ChatCompletionToolMessageParam;
      // Drop tool messages whose tool_call_id was part of the orphaned set.
      if (!expectedIds.has(toolMsg.tool_call_id)) {
        paired.push(messages[k]!);
      }
    }
    i = j - 1; // advance past the orphaned tool block
  }

  // Second pass: ensure the first non-system message is a user.
  const result: MessageParam[] = [];
  let seenNonSystem = false;
  for (const msg of paired) {
    if (msg.role === 'system') {
      result.push(msg);
      continue;
    }
    if (!seenNonSystem) {
      if (msg.role !== 'user') {
        result.push({ role: 'user', content: '...' });
      }
      seenNonSystem = true;
    }
    result.push(msg);
  }
  return result;
}

/** Plain-text fallback for group-chat sender attribution. */
/**
 * Exported so the system prompt's description of this prefix can be pinned to
 * what it actually produces: the prompt used to tell the model to look for
 * "[Group: name, From: sender]", which nothing has ever written.
 */
export function tagSender(content: string, name: string, userId: number): string {
  const senderTag = `[From: ${name} (id:${userId})] `;
  const tsPattern = /^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] )/;
  return tsPattern.test(content) ? content.replace(tsPattern, `$1${senderTag}`) : `${senderTag}${content}`;
}

/**
 * Schema for parsing stored OpenAI-format assistant turns back out of chat_history.
 * The writer serializes via JSON.stringify on the full assistant message; this
 * schema validates the minimum shape we need on the way back in.
 */
const StoredAssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
});

const StoredToolResultArraySchema = z.array(
  z.object({
    role: z.literal('tool'),
    tool_call_id: z.string(),
    content: z.string(),
  }),
);

/**
 * Legacy Anthropic assistant turn — an array of content blocks with a `type`
 * field. Pre-migration history rows use this shape. We flatten them into plain
 * text so existing conversation context survives the SDK swap.
 */
const LegacyAnthropicContentBlocksSchema = z.array(z.object({ type: z.string() }).passthrough());

export const AssistantMessageCodec = jsonCodec(StoredAssistantMessageSchema);
const ToolResultsCodec = jsonCodec(StoredToolResultArraySchema);
const LegacyAnthropicContentBlocksCodec = jsonCodec(LegacyAnthropicContentBlocksSchema);
const ActivityEventCodec = jsonCodec(z.object({ kind: z.string() }).passthrough());

/** Extract a best-effort plain-text summary from a legacy Anthropic content-block array. */
function flattenLegacyContentBlocks(blocks: { type: string; [key: string]: unknown }[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(`[tool_use: ${block.name}]`);
    } else if (block.type === 'tool_result') {
      const content =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : ''))
                .filter(Boolean)
                .join(' ')
            : '';
      parts.push(`[tool_result: ${content.slice(0, 300)}]`);
    }
  }
  return parts.join(' ').trim();
}

/**
 * Parse the content column of a chat_history row into zero or more OpenAI
 * messages. Handles three formats:
 *  1. OpenAI assistant turn (JSON of a single assistant message)
 *  2. OpenAI tool results (JSON array of tool-role messages)
 *  3. Activity event (JSON { kind: ... }) — rendered to a single flat string
 *  4. Plain text fallback — rendered with a timestamp prefix
 */
function parseHistoryRow(msg: ChatHistoryMessage, timezone: string): MessageParam[] {
  if (msg.role === 'assistant') {
    const parsed = AssistantMessageCodec.safeParse(msg.content);
    if (parsed.success) {
      return [parsed.data];
    }
    // Legacy Anthropic content-blocks — flatten to plain-text assistant turn
    // so existing conversation context survives the SDK swap.
    const legacy = LegacyAnthropicContentBlocksCodec.safeParse(msg.content);
    if (legacy.success) {
      const flat = flattenLegacyContentBlocks(legacy.data as { type: string; [key: string]: unknown }[]);
      if (flat) {
        return [
          {
            role: 'assistant',
            content: withTimestamp(flat, msg.created_at, timezone),
          },
        ];
      }
      return [];
    }
    // Activity event (bot reply / edit) — render to a readable text line.
    const activity = ActivityEventCodec.safeParse(msg.content);
    if (activity.success) {
      return [
        {
          role: 'assistant',
          content: withTimestamp(formatActivityEvent(activity.data as ActivityEvent), msg.created_at, timezone),
        },
      ];
    }
    return [
      {
        role: 'assistant',
        content: withTimestamp(msg.content, msg.created_at, timezone),
      },
    ];
  }

  if (msg.role === 'tool') {
    const parsed = ToolResultsCodec.safeParse(msg.content);
    if (parsed.success) {
      return parsed.data;
    }
    // Legacy Anthropic tool_result blocks — drop; they cannot be mapped to
    // OpenAI without tool_call_ids and the stale ones won't match anything anyway.
    return [];
  }

  // role === 'user'
  const activity = ActivityEventCodec.safeParse(msg.content);
  if (activity.success) {
    return [
      {
        role: 'user',
        content: withTimestamp(formatActivityEvent(activity.data as ActivityEvent), msg.created_at, timezone),
      },
    ];
  }
  return [
    {
      role: 'user',
      content: withTimestamp(msg.content, msg.created_at, timezone),
    },
  ];
}

/** Detect [SKIP] / ellipsis-only outputs the bot should discard instead of sending. */
function isSkipText(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false; // empty text is handled separately; not a SKIP
  return t === '[SKIP]' || text.includes('[SKIP]') || t === '...' || t === '…';
}

/** Recursively sort object keys for stable serialization. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const sorted = Object.keys(value as { [key: string]: unknown }).sort();
  const parts = sorted.map((k) => `${JSON.stringify(k)}:${stableStringify((value as { [key: string]: unknown })[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * Canonical dedup key for (tool name, input). Keys known to the tool schema
 * are extracted and sorted so `{a,b}` and `{b,a}` collide. Extra keys
 * injected by the model (e.g. `_nonce`) are stripped to prevent false key
 * divergence.
 */
export function toolCallKey(name: string, input: { [key: string]: unknown }): string {
  const schema = toolSchemas[name as keyof typeof toolSchemas];
  const knownKeys =
    schema && 'shape' in schema ? Object.keys((schema as { shape: { [key: string]: unknown } }).shape) : null;
  const filteredKeys = knownKeys
    ? Object.keys(input)
        .filter((k) => knownKeys.includes(k))
        .sort()
    : Object.keys(input).sort();
  // Strip null/undefined — optional params absent vs explicitly null must not
  // break dedup. e.g. {query:"x"} and {query:"x", start_date:null} are the same.
  const canonical: { [key: string]: unknown } = {};
  for (const k of filteredKeys) {
    if (input[k] !== null && input[k] !== undefined) {
      canonical[k] = input[k];
    }
  }
  return `${name}:${stableStringify(canonical)}`;
}

const DUPLICATE_MARKER =
  'DUPLICATE: you already called this tool with identical arguments earlier in this turn. ' +
  'Use the previous result. Do NOT call this tool again — respond to the user with a final answer ' +
  'or call a different tool.';

export interface AgentToolCallRecord {
  name: string;
  input: { [key: string]: unknown };
}

export interface AgentToolResultRecord {
  success: boolean;
  output?: string;
}

export interface AgentRunResult {
  responseText: string;
  toolCalls: AgentToolCallRecord[];
  toolResults: AgentToolResultRecord[];
  endCall?: boolean;
}

export class CalendarBotAgent {
  private sender: TelegramSender;
  private debugLogger?: AiDebugLogger;
  private streamImpl: typeof aiStreamRound;
  private summarizer?: HistorySummarizer;

  constructor(config: AgentConfig, sender: TelegramSender, opts?: { streamImpl?: typeof aiStreamRound }) {
    this.sender = sender;
    this.debugLogger = config.debugLogger;
    this.streamImpl = opts?.streamImpl ?? aiStreamRound;
    this.summarizer = config.summarizer;
  }

  getSender(): TelegramSender {
    return this.sender;
  }

  async buildMessages(
    ctx: AgentContext,
    history: ChatHistoryMessage[],
  ): Promise<{ systemPrompt: string; messages: MessageParam[] }> {
    // IMPORTANT: history must already contain the current user message.
    // The universal GramIO middleware in bot/index.ts saves it via ConversationLogger
    // before the pipeline runs, so by the time agent.run() is called, it is present.
    const systemPrompt = buildSystemPrompt(ctx);

    const relevantHistory =
      ctx.isGroup && ctx.groupChatId ? ctx.chatHistory.getRecentByChat(ctx.groupChatId, 50) : history;

    const messages: MessageParam[] = [];
    const senderCache = new Map<number, string>();

    for (const row of relevantHistory) {
      const parsedMessages = parseHistoryRow(row, ctx.user.timezone);

      for (let msg of parsedMessages) {
        if (this.summarizer && isToolMessage(msg) && typeof msg.content === 'string') {
          const condensed = await this.summarizer.condenseMessage(row.id, msg.tool_call_id, msg.content);
          if (condensed !== msg.content) {
            msg = { ...msg, content: condensed };
          }
        }

        // For group chats, inject sender name+id into plain text user messages
        // so the model can distinguish speakers.
        if (ctx.isGroup && ctx.groupChatId && msg.role === 'user' && typeof msg.content === 'string') {
          if (!senderCache.has(row.user_id)) {
            const u = ctx.userRepo.findByTelegramId(row.user_id);
            senderCache.set(row.user_id, u?.first_name ?? u?.username ?? 'User');
          }
          const name = senderCache.get(row.user_id)!;
          messages.push({ role: 'user', content: tagSender(msg.content, name, row.user_id) });
          continue;
        }
        messages.push(msg);
      }
    }

    // A backoff retry re-runs the original message, but nothing re-saves it to
    // chat_history — the newest stored turn is the bot's own "one sec". Without
    // this the model is asked to continue from its own stall phrase and has no
    // idea which question it still owes an answer to.
    if ((ctx.retryAttempt ?? 0) > 0 && ctx.messageText.trim().length > 0) {
      const last = messages[messages.length - 1];
      const alreadyAsked =
        last?.role === 'user' && typeof last.content === 'string' && last.content.includes(ctx.messageText);
      if (!alreadyAsked) {
        messages.push({ role: 'user', content: ctx.messageText });
      }
    }

    return { systemPrompt, messages: sanitizeMessages(messages) };
  }

  /**
   * Tell the user what happened when a run failed.
   *
   * Mid-chain retries stay quiet: the comeback was already promised on the first
   * failure and repeating it every 30 seconds only adds noise. Everything else
   * goes through the notice tracker, which decides between a playful stall, an
   * honest "the AI is down, here is what still works", and silence.
   */
  private announceFailure(ctx: AgentContext, error: unknown, writer: TelegramStreamWriter): void {
    if (ctx.supplementMode || ctx.wasExplicitInvocation === false) return;

    const hardOutage = isHardOutage(error);
    if ((ctx.retryAttempt ?? 0) > 0 && !hardOutage) return;

    const notice = aiFailureNotices.decide(ctx.user.telegram_id, toLang(ctx.user.language), {
      hardOutage,
      willRetry: typeof ctx.retryEnqueue === 'function',
    });
    aiLogger.info({ userId: ctx.user.telegram_id, notice: notice.kind, hardOutage }, 'AI failure notice');
    if (notice.kind === 'silent') return;

    writer.appendText(`\n\n${notice.text}`);
    // Save to chat history so the model can see it and play along if the user reacts.
    this.saveAssistantTurn(ctx, { role: 'assistant', content: notice.text });
  }

  saveAssistantTurn(ctx: AgentContext, assistantMessage: MessageParam, skipIds?: Set<string>): void {
    let msgToSave = assistantMessage;
    if (
      skipIds?.size &&
      'tool_calls' in assistantMessage &&
      Array.isArray(assistantMessage.tool_calls) &&
      assistantMessage.tool_calls.length > 0
    ) {
      const kept = assistantMessage.tool_calls.filter((tc) => !skipIds.has(tc.id));
      if (kept.length !== assistantMessage.tool_calls.length) {
        msgToSave =
          kept.length > 0
            ? { ...assistantMessage, tool_calls: kept }
            : {
                role: 'assistant',
                content: typeof assistantMessage.content === 'string' ? assistantMessage.content : null,
              };
      }
    }
    // Skip persisting an empty assistant turn (no content, no tool_calls) — happens
    // when all tool calls in this round are skip-persist (e.g. only get_history called).
    const hasContent =
      msgToSave.content && (typeof msgToSave.content !== 'string' || msgToSave.content.trim().length > 0);
    const hasCalls =
      'tool_calls' in msgToSave && Array.isArray(msgToSave.tool_calls) && msgToSave.tool_calls.length > 0;
    if (!hasContent && !hasCalls) return;
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    // The conversation logger stores the full JSON payload under role='assistant'.
    // We stringify manually here so parseHistoryRow can round-trip the value.
    ctx.conversationLogger.logAiTurn(ctx.user.telegram_id, msgToSave, chatId);
  }

  saveToolResults(ctx: AgentContext, toolResults: MessageParam[], skipIds?: Set<string>): void {
    const toSave = skipIds?.size
      ? toolResults.filter((m) => !isToolMessage(m) || !skipIds.has(m.tool_call_id))
      : toolResults;
    if (toSave.length === 0) return;
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    ctx.conversationLogger.logToolResults(ctx.user.telegram_id, toSave, chatId);
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    aiLogger.info(
      {
        userId: ctx.user.telegram_id,
        chatId: ctx.chatId,
        supplementMode: !!ctx.supplementMode,
        msg: ctx.messageText.slice(0, 100),
      },
      'Agent run started',
    );

    const history = ctx.chatHistory.getRecent(ctx.user.telegram_id, 30);
    const { systemPrompt, messages: rawHistoryMessages } = await this.buildMessages(ctx, history);
    const historyMessages = this.summarizer
      ? await this.summarizer.condenseHistory(rawHistoryMessages)
      : rawHistoryMessages;

    const dbg: AiDebugRunContext | null =
      this.debugLogger?.createRunContext(
        ctx.user.telegram_id,
        ctx.chatId,
        ctx.user.username,
        ctx.user.first_name,
        ctx.groupTitle ?? null,
        !!ctx.supplementMode,
        ctx.messageText,
        ctx.supplementAutoResponse,
      ) ?? null;
    dbg?.logSystemPrompt(systemPrompt);
    dbg?.logHistory(historyMessages);

    const effectiveSender: TelegramSender = ctx.supplementMode
      ? ({
          sendMessage: async () => ({ message_id: 0 }),
          editMessageText: async () => {},
          sendMessageWithKeyboard: async () => ({ message_id: 0 }),
          sendButtons: async () => ({ message_id: 0 }),
          sendUserPicker: async () => ({ message_id: 0 }),
          sendPhoto: async () => ({ message_id: 0 }),
          sendInvitation: async () => null,
          sendEditProposal: async () => null,
          sendAsUser: async () => false,
          deleteMessage: async () => {},
          setReaction: async () => {},
        } satisfies TelegramSender)
      : this.sender;
    ctx.sender = effectiveSender;
    const writer = new TelegramStreamWriter(effectiveSender, ctx.chatId, ctx.user.language, {
      userTranscript: ctx.inputMode === 'live_call' ? ctx.messageText : undefined,
      noPlaceholder: ctx.isGroup,
    });
    await writer.init();

    const startTime = Date.now();
    const allToolCalls: AgentToolCallRecord[] = [];
    const allToolResults: AgentToolResultRecord[] = [];
    // Keys of tool calls already executed in this run — used to short-circuit
    // duplicate calls with identical arguments and prevent agent-level loops
    // where the model keeps invoking the same tool (e.g. render_day_image,
    // which has user-visible side effects).
    const seenToolCallKeys = new Set<string>();
    // Last text-only assistant turn — buffered so we don't persist a tool-less
    // hallucination to chat_history before the validator has a chance to reject it.
    let pendingAssistantTurn: MessageParam | null = null;
    let pendingResponseText = '';

    // Build the full message list once (system first, then the reconstructed history).
    const systemMessage: MessageParam = { role: 'system', content: systemPrompt };
    let currentMessages: MessageParam[] = [systemMessage, ...historyMessages];
    let runFailed = false;

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        dbg?.logRound(round);

        if (Date.now() - startTime > TIMEOUT_MS) {
          aiLogger.warn({ userId: ctx.user.telegram_id }, 'Agent timeout');
          const lang = ctx.user.language as 'en' | 'ru';
          writer.appendText(`\n\n${t(lang).agent_timeout}`);
          break;
        }

        const callbacks: StreamCallbacks = {
          onTextDelta: (text) => {
            writer.appendText(text);
            writer.flush(false).catch(() => {});
          },
          onToolCallStart: (name) => {
            if (SILENT_TOOLS.has(name)) return;
            // Only set the label — don't flush. The tool loop flushes
            // sequentially with full input details. Fire-and-forget flush
            // here raced with the tool loop in noPlaceholder (group) mode,
            // creating orphaned messages.
            writer.setToolLabel(name);
          },
          onProviderSwitch: () => {
            writer.resetBuffers();
          },
        };

        const remainingMs = Math.max(1000, TIMEOUT_MS - (Date.now() - startTime));
        const result = await this.streamImpl(
          {
            messages: currentMessages,
            tools: getToolDefinitions(ctx.inputMode, ctx.supplementMode),
            maxTokens: 4096,
            temperature: 0.3,
            signal: AbortSignal.timeout(remainingMs),
            userId: ctx.user.telegram_id,
          },
          callbacks,
        );

        aiLogger.info(
          {
            userId: ctx.user.telegram_id,
            provider: result.providerUsed,
            round,
            toolCount: result.toolCalls.length,
          },
          'Agent round complete',
        );
        dbg?.logAiText(result.text);

        // No tool calls → we're done with the streaming phase. Do NOT persist
        // the assistant turn yet — validation runs after the loop and may
        // reject+retry, in which case we don't want the rejected answer in
        // chat_history. Final persistence happens after validation below.
        if (result.toolCalls.length === 0) {
          pendingAssistantTurn = result.assistantMessage;
          pendingResponseText = result.text;
          break;
        }

        // Tool call IDs that must not be persisted (meta/query tools like get_history).
        // Computed upfront so saveAssistantTurn can strip them from the assistant message
        // before writing to DB, keeping the persisted tool_calls / tool_results in sync.
        const skipPersistIds = new Set(
          result.toolCalls.filter((tc) => SKIP_PERSIST_TOOLS.has(tc.name)).map((tc) => tc.id),
        );

        // Persist the assistant turn (text + tool_calls) before executing tools
        if (!ctx.supplementMode) {
          this.saveAssistantTurn(ctx, result.assistantMessage, skipPersistIds);
        }

        const toolResultMessages: MessageParam[] = [];

        for (const tc of result.toolCalls) {
          let input: { [key: string]: unknown };
          try {
            input = JSON.parse(tc.arguments) as { [key: string]: unknown };
          } catch (err) {
            aiLogger.error({ err, tool: tc.name, arguments: tc.arguments }, 'Failed to parse tool arguments');
            input = {};
          }

          aiLogger.info({ tool: tc.name, input, userId: ctx.user.telegram_id, chatId: ctx.chatId }, 'Tool call');
          dbg?.logToolCall(tc.name, input);

          // Dedup: if the model already called this exact (name, args) earlier
          // in the run, short-circuit and return a synthetic DUPLICATE result
          // without invoking the real handler. This prevents user-visible side
          // effects (photo sends, notifications) from being duplicated during
          // model loops.
          const dedupKey = toolCallKey(tc.name, input);
          if (seenToolCallKeys.has(dedupKey)) {
            aiLogger.warn(
              { tool: tc.name, input, userId: ctx.user.telegram_id, round },
              'Duplicate tool call skipped (in-run dedup)',
            );
            dbg?.logToolResult(tc.name, true, DUPLICATE_MARKER, undefined);
            allToolCalls.push({ name: tc.name, input });
            allToolResults.push({ success: true, output: DUPLICATE_MARKER });
            toolResultMessages.push({ role: 'tool', tool_call_id: tc.id, content: DUPLICATE_MARKER });
            continue;
          }
          if (!SILENT_TOOLS.has(tc.name)) {
            writer.setToolLabel(tc.name, input);
            await writer.flush(true);
          }

          const toolResult = await executeTool(ctx, tc.name, input);

          // Record dedup key only after a successful execution — failed calls
          // must not block retries with a synthetic DUPLICATE result.
          if (toolResult.success) {
            seenToolCallKeys.add(dedupKey);
          }

          writer.markToolResult(toolResult.success);
          dbg?.logToolResult(tc.name, toolResult.success, toolResult.output, toolResult.error);

          allToolCalls.push({ name: tc.name, input });
          allToolResults.push({ success: toolResult.success, output: toolResult.output });

          const content = toolResult.success
            ? `${toolResult.output ?? 'OK'}${toolResult.agentHint ? `\n[AGENT: ${toolResult.agentHint}]` : ''}`
            : `Error: ${toolResult.error ?? toolResult.output ?? 'Unknown error'}`;

          toolResultMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content,
          });

          if (toolResult.stopLoop) {
            writer.clearToolLabel();
            if (!ctx.supplementMode && toolResultMessages.length > 0) {
              this.saveToolResults(ctx, toolResultMessages, skipPersistIds);
            }
            writer.commitIntermediate();
            await writer.finalize();
            dbg?.logFinal(writer.getText().trim(), allToolCalls.length);
            dbg?.flush();
            if (allToolCalls.some((call) => call.name === 'end_conversation')) {
              this.debugLogger?.endSession(ctx.chatId);
            }
            return {
              responseText: ctx.inputMode !== 'text' ? writer.getPlainText() : writer.getText(),
              toolCalls: allToolCalls,
              toolResults: allToolResults,
              endCall: ctx.callEndRequested === true,
            };
          }
        }

        if (isSkipText(writer.getText())) {
          await writer.discard();
          dbg?.logFinal('[SKIP] (mid-loop discard)', allToolCalls.length);
          dbg?.flush();
          return { responseText: '', toolCalls: allToolCalls, toolResults: allToolResults };
        }

        writer.clearToolLabel();
        if (!ctx.supplementMode) {
          this.saveToolResults(ctx, toolResultMessages, skipPersistIds);
        }
        writer.commitIntermediate();

        currentMessages = [...currentMessages, result.assistantMessage, ...toolResultMessages];
      }

      // Response validation: when no tools were called, verify the response isn't
      // hallucinated. Always on — cheap via the fast chain, and critical for
      // calendar correctness. Skip supplementMode (no user-visible output to validate).
      const availableTools = getToolDefinitions(ctx.inputMode, ctx.supplementMode);
      let rejected = false;
      if (availableTools.length > 0 && allToolCalls.length === 0 && !ctx.supplementMode) {
        // Use the model's actual emitted text, not the writer buffer — tests
        // with scripted stream impls can produce an assistantMessage without
        // calling onTextDelta, so writer.getText() may be empty even when the
        // model did return content.
        const responseText = pendingResponseText.trim();
        if (responseText && !isSkipText(responseText)) {
          const validation = await validateResponse(
            {
              userMessage: ctx.messageText,
              toolCalls: allToolCalls.map((tc) => tc.name),
              response: responseText,
            },
            this.streamImpl,
          );

          if (!validation.approved) {
            aiLogger.info(
              { userId: ctx.user.telegram_id, reason: validation.reason },
              'Response validation REJECTED — retrying with tools',
            );
            rejected = true;
            pendingAssistantTurn = null;
            const retryOutcome = await this.runRetryAfterRejection(
              ctx,
              currentMessages,
              responseText,
              writer,
              dbg,
              allToolCalls,
              allToolResults,
              startTime,
              seenToolCallKeys,
            );

            // If the retry ALSO produced a tool-less answer, validate it once
            // more. If the second pass also rejects, we log and ship anyway —
            // the alternative is a blank or useless apology and we only get
            // one retry budget per user request.
            if (!retryOutcome.hitStopLoop && retryOutcome.lastRoundText && !retryOutcome.lastRoundHadToolCalls) {
              const reValidation = await validateResponse(
                {
                  userMessage: ctx.messageText,
                  toolCalls: allToolCalls.map((tc) => tc.name),
                  response: retryOutcome.lastRoundText,
                },
                this.streamImpl,
              );
              if (!reValidation.approved) {
                aiLogger.warn(
                  { userId: ctx.user.telegram_id, reason: reValidation.reason },
                  'Retry response ALSO rejected by validator — shipping anyway, user asked once',
                );
              }
            }
          }
        }
      }

      // Persist the final tool-less assistant turn only if validation didn't
      // reject it. Tool-bearing rounds persist as they happen, inside the loop.
      if (pendingAssistantTurn && !rejected && !ctx.supplementMode) {
        this.saveAssistantTurn(ctx, pendingAssistantTurn);
      }
    } catch (error) {
      aiLogger.error({ err: error, userId: ctx.user.telegram_id }, 'Agent error');
      runFailed = true;
      this.announceFailure(ctx, error, writer);

      // Enqueue next retry (or trigger graceful fail after max attempts)
      if (ctx.retryEnqueue && !ctx.supplementMode && ctx.wasExplicitInvocation !== false) {
        ctx.retryEnqueue(ctx.messageText).catch((err) => {
          aiLogger.warn({ err, userId: ctx.user.telegram_id }, 'Failed to handle retry enqueue');
        });
      }
    }

    if (!runFailed && !ctx.supplementMode) {
      // The bot answered — any comeback it promised earlier is now settled.
      aiFailureNotices.clear(ctx.user.telegram_id);
    }

    const finalText = writer.getText().trim();
    dbg?.logFinal(finalText, allToolCalls.length);
    dbg?.flush();

    if (allToolCalls.some((tc) => tc.name === 'end_conversation')) {
      this.debugLogger?.endSession(ctx.chatId);
    }

    aiLogger.info(
      {
        userId: ctx.user.telegram_id,
        chatId: ctx.chatId,
        toolCount: allToolCalls.length,
        supplementMode: !!ctx.supplementMode,
      },
      'Agent run complete',
    );

    // A failed run with nothing to show must not leave the ⏳ placeholder edited
    // into a bare "..." — that is the silence the user reads as being ignored.
    if (isSkipText(finalText) || (runFailed && finalText.length === 0)) {
      await writer.discard();
      return { responseText: '', toolCalls: allToolCalls, toolResults: allToolResults };
    }

    try {
      await writer.finalize();
    } catch (finalizeErr) {
      aiLogger.error({ err: finalizeErr, userId: ctx.user.telegram_id }, 'Writer finalize failed');
      await writer.sendErrorFallback(t(ctx.user.language).ai_send_error);
    }

    const msgId = writer.getMessageId();
    if (ctx.onBotResponse && msgId !== null) {
      ctx.onBotResponse(msgId);
    }

    return {
      responseText: ctx.inputMode !== 'text' ? writer.getPlainText() : writer.getText(),
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      endCall: ctx.callEndRequested === true,
    };
  }

  /**
   * Retry the round after the quality validator rejected a tool-less response.
   *
   * NOTE: the validator's REJECT reason is deliberately NOT forwarded to the
   * retry prompt. The validator is itself an LLM whose free-form output can
   * be influenced by the user's original message, so splicing the reason into
   * a pseudo-system instruction would open a prompt-injection channel where a
   * malicious user can steer the retry. Caller logs the reason once before
   * calling this method; after that it is discarded.
   */
  private async runRetryAfterRejection(
    ctx: AgentContext,
    messages: MessageParam[],
    previousText: string,
    writer: TelegramStreamWriter,
    dbg: AiDebugRunContext | null,
    allToolCalls: AgentToolCallRecord[],
    allToolResults: AgentToolResultRecord[],
    startTime: number,
    seenToolCallKeys: Set<string>,
  ): Promise<{
    hitStopLoop: boolean;
    /** Text produced by the most recent round of the retry loop (for re-validation). */
    lastRoundText: string;
    /** Whether the last round called any tools. Used to decide if re-validation is needed. */
    lastRoundHadToolCalls: boolean;
  }> {
    // Actually throw away the rejected text — commitIntermediate() would push
    // it into the final execution log, which is the opposite of what we want.
    writer.resetBuffers();

    // Generic retry nudge. Does NOT echo the validator's REJECT string, which
    // is an LLM-generated value that cannot be trusted as a system directive.
    const retryMessages: MessageParam[] = [
      ...messages,
      { role: 'assistant', content: previousText },
      {
        role: 'user',
        content:
          '[SYSTEM] Your previous response was rejected by the quality validator because it answered a calendar question without calling any tools. You MUST call the appropriate tools (get_events, search_events, get_free_slots, etc.) and re-answer the question properly. Do NOT repeat the same mistake.',
      },
    ];

    let currentMessages = retryMessages;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      dbg?.logRound(100 + round);

      if (Date.now() - startTime > TIMEOUT_MS) {
        aiLogger.warn({ userId: ctx.user.telegram_id }, 'Agent timeout (retry)');
        writer.appendText('\n\n⚠️ Timeout reached.');
        return { hitStopLoop: false, lastRoundText: '', lastRoundHadToolCalls: false };
      }

      const callbacks: StreamCallbacks = {
        onTextDelta: (text) => {
          writer.appendText(text);
          writer.flush(false).catch(() => {});
        },
        onToolCallStart: (name) => {
          writer.setToolLabel(name);
          writer.flush(true).catch(() => {});
        },
      };

      const remainingMs = Math.max(1000, TIMEOUT_MS - (Date.now() - startTime));
      const result = await this.streamImpl(
        {
          messages: currentMessages,
          tools: getToolDefinitions(ctx.inputMode, ctx.supplementMode),
          maxTokens: 4096,
          temperature: 0.3,
          signal: AbortSignal.timeout(remainingMs),
        },
        callbacks,
      );

      dbg?.logAiText(result.text);

      if (result.toolCalls.length === 0) {
        if (!ctx.supplementMode) {
          this.saveAssistantTurn(ctx, result.assistantMessage);
        }
        return { hitStopLoop: false, lastRoundText: result.text, lastRoundHadToolCalls: false };
      }

      const skipPersistIds = new Set(
        result.toolCalls.filter((tc) => SKIP_PERSIST_TOOLS.has(tc.name)).map((tc) => tc.id),
      );

      if (!ctx.supplementMode) {
        this.saveAssistantTurn(ctx, result.assistantMessage, skipPersistIds);
      }

      const toolResultMessages: MessageParam[] = [];
      let stopLoopTriggered = false;
      for (const tc of result.toolCalls) {
        let input: { [key: string]: unknown };
        try {
          input = JSON.parse(tc.arguments) as { [key: string]: unknown };
        } catch (err) {
          aiLogger.error({ err, tool: tc.name, arguments: tc.arguments }, 'Failed to parse tool arguments (retry)');
          input = {};
        }

        // Same in-run dedup as the main loop — share the Set so both loops
        // respect each other's calls.
        const dedupKey = toolCallKey(tc.name, input);
        if (seenToolCallKeys.has(dedupKey)) {
          aiLogger.warn(
            { tool: tc.name, input, userId: ctx.user.telegram_id, round },
            'Duplicate tool call skipped (in-run dedup, retry loop)',
          );
          dbg?.logToolResult(tc.name, true, DUPLICATE_MARKER, undefined);
          allToolCalls.push({ name: tc.name, input });
          allToolResults.push({ success: true, output: DUPLICATE_MARKER });
          toolResultMessages.push({ role: 'tool', tool_call_id: tc.id, content: DUPLICATE_MARKER });
          continue;
        }
        writer.setToolLabel(tc.name, input);
        await writer.flush(true);

        const toolResult = await executeTool(ctx, tc.name, input);

        // Record dedup key only on success — failed calls must not block retries.
        if (toolResult.success) {
          seenToolCallKeys.add(dedupKey);
        }

        writer.markToolResult(toolResult.success);
        dbg?.logToolResult(tc.name, toolResult.success, toolResult.output, toolResult.error);

        allToolCalls.push({ name: tc.name, input });
        allToolResults.push({ success: toolResult.success, output: toolResult.output });

        const content = toolResult.success
          ? `${toolResult.output ?? 'OK'}${toolResult.agentHint ? `\n[AGENT: ${toolResult.agentHint}]` : ''}`
          : `Error: ${toolResult.error ?? toolResult.output ?? 'Unknown error'}`;

        toolResultMessages.push({ role: 'tool', tool_call_id: tc.id, content });

        if (toolResult.stopLoop) {
          stopLoopTriggered = true;
          break;
        }
      }

      if (!ctx.supplementMode && toolResultMessages.length > 0) {
        this.saveToolResults(ctx, toolResultMessages, skipPersistIds);
      }
      writer.clearToolLabel();
      writer.commitIntermediate();

      if (stopLoopTriggered) {
        // A tool like ask_user / end_conversation already sent its own UI —
        // do not produce additional assistant text after it.
        return { hitStopLoop: true, lastRoundText: '', lastRoundHadToolCalls: true };
      }

      currentMessages = [...currentMessages, result.assistantMessage, ...toolResultMessages];
    }
    return { hitStopLoop: false, lastRoundText: '', lastRoundHadToolCalls: true };
  }
}
