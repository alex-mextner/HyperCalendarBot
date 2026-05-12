import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type OpenAI from 'openai';
import { z } from 'zod';
import { t } from '../../config/constants.ts';
import type { ChatHistoryMessage } from '../../database/types.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { logger } from '../../utils/logger.ts';
import { type ActivityEvent, formatActivityEvent } from './activity-event.ts';
import type { AiDebugLogger, AiDebugRunContext } from './debug-logger.ts';
import type { HistorySummarizer } from './history-summarizer.ts';
import { validateResponse } from './response-validator.ts';
import { aiStreamRound, type StreamCallbacks } from './streaming.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { TelegramStreamWriter } from './telegram-stream.ts';
import { executeTool, SILENT_TOOLS } from './tool-executor.ts';
import { toolSchemas } from './tool-schemas.ts';
import { getToolDefinitions, type UserCapabilities } from './tools.ts';
import type { AgentConfig, AgentContext, TelegramSender } from './types.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

const MAX_ROUNDS = 15;
const TIMEOUT_MS = 300_000;

type MessageParam = OpenAI.ChatCompletionMessageParam;

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
function tagSender(content: string, name: string, userId: number): string {
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

const AssistantMessageCodec = jsonCodec(StoredAssistantMessageSchema);
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
    caps?: UserCapabilities,
  ): Promise<{ systemPrompt: string; messages: MessageParam[] }> {
    // IMPORTANT: history must already contain the current user message.
    // The universal GramIO middleware in bot/index.ts saves it via ConversationLogger
    // before the pipeline runs, so by the time agent.run() is called, it is present.
    const systemPrompt = buildSystemPrompt(ctx, caps);

    const relevantHistory =
      ctx.isGroup && ctx.groupChatId ? ctx.chatHistory.getRecentByChat(ctx.groupChatId, 50) : history;

    const messages: MessageParam[] = [];
    const senderCache = new Map<number, string>();

    for (const row of relevantHistory) {
      const parsedMessages = parseHistoryRow(row, ctx.user.timezone);

      for (let msg of parsedMessages) {
        if (this.summarizer && msg.role === 'tool' && typeof msg.content === 'string') {
          const condensed = await this.summarizer.condenseMessage(row.id, 'tool', msg.content);
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

    return { systemPrompt, messages: sanitizeMessages(messages) };
  }

  saveAssistantTurn(ctx: AgentContext, assistantMessage: MessageParam): void {
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    // The conversation logger stores the full JSON payload under role='assistant'.
    // We stringify manually here so parseHistoryRow can round-trip the value.
    ctx.conversationLogger.logAiTurn(ctx.user.telegram_id, assistantMessage, chatId);
  }

  saveToolResults(ctx: AgentContext, toolResults: MessageParam[]): void {
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    ctx.conversationLogger.logToolResults(ctx.user.telegram_id, toolResults, chatId);
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

    const caps: UserCapabilities = {
      assistantEnabled: Boolean(ctx.user.assistant_enabled),
    };
    const history = ctx.chatHistory.getRecent(ctx.user.telegram_id, 30);
    const { systemPrompt, messages: rawHistoryMessages } = await this.buildMessages(ctx, history, caps);
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

    // Stream macOS agent chunks into the same writer so they appear live
    // and land in the collapsed blockquote after commitIntermediate().
    // tailText keeps only the last 3500 chars so Telegram never rejects the edit.
    if (ctx.agents) {
      ctx.agents.onAgentChunk = (text: string) => {
        writer.appendText(text);
        writer.tailText(3500);
        writer.flush(false).catch((err) => aiLogger.warn({ err }, 'agent chunk flush failed'));
      };
    }

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

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        dbg?.logRound(round);

        if (Date.now() - startTime > TIMEOUT_MS) {
          aiLogger.warn({ userId: ctx.user.telegram_id }, 'Agent timeout');
          writer.appendText('\n\n⚠️ Timeout reached.');
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
        };

        const remainingMs = Math.max(1000, TIMEOUT_MS - (Date.now() - startTime));
        const result = await this.streamImpl(
          {
            messages: currentMessages,
            tools: getToolDefinitions(ctx.inputMode, caps, ctx.supplementMode),
            maxTokens: 4096,
            temperature: 0.3,
            signal: AbortSignal.timeout(remainingMs),
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

        // Persist the assistant turn (text + tool_calls) before executing tools
        if (!ctx.supplementMode) {
          this.saveAssistantTurn(ctx, result.assistantMessage);
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
              this.saveToolResults(ctx, toolResultMessages);
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
          this.saveToolResults(ctx, toolResultMessages);
        }
        writer.commitIntermediate();

        currentMessages = [...currentMessages, result.assistantMessage, ...toolResultMessages];
      }

      // Response validation: when no tools were called, verify the response isn't
      // hallucinated. Always on — cheap via the fast chain, and critical for
      // calendar correctness. Skip supplementMode (no user-visible output to validate).
      const availableTools = getToolDefinitions(ctx.inputMode, caps, ctx.supplementMode);
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
              caps,
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
      writer.appendText(`\n\n${t(ctx.user.language).ai_processing_error}`);
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

    if (isSkipText(finalText)) {
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
    caps: UserCapabilities,
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
          tools: getToolDefinitions(ctx.inputMode, caps, ctx.supplementMode),
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

      if (!ctx.supplementMode) {
        this.saveAssistantTurn(ctx, result.assistantMessage);
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
        this.saveToolResults(ctx, toolResultMessages);
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
